import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';
import { TeamsStore } from '../storage/teams.store';
import { TeamsService } from './teams.service';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';

/**
 * Real SQLite with the real team store and agent storage: the races here are between separate
 * write transactions, which mocks cannot reproduce. Only the session facade is a fake, so each
 * test controls when the session stop settles.
 */
describe('TeamsService – disabled agent races', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let teamsStore: TeamsStore;
  let service: TeamsService;
  let stopDisabledAgent: jest.Mock;
  let deliver: jest.Mock;
  let projectId: string;
  let profileId: string;
  let configId: string;

  beforeEach(() => {
    sqlite = createTestDatabase().sqlite;
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    storage = new LocalStorageService(db);
    teamsStore = new TeamsStore(db);
    stopDisabledAgent = jest.fn().mockResolvedValue(undefined);
    deliver = jest.fn().mockResolvedValue({ status: 'delivered', results: [] });
    service = new TeamsService(
      teamsStore,
      storage,
      {} as never,
      {} as never,
      createProjectWriteGateStub() as never,
      { stopDisabledAgent } as never,
      {} as never,
      {} as never,
      {} as never,
      { deliver } as never,
    );

    projectId = randomUUID();
    const providerId = randomUUID();
    profileId = randomUUID();
    configId = randomUUID();
    const now = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO projects (id, name, description, root_path, created_at, updated_at)
      VALUES ('${projectId}', 'Test Project', NULL, '/tmp/test', '${now}', '${now}');
      INSERT INTO providers (id, name, created_at, updated_at)
      VALUES ('${providerId}', 'test-provider', '${now}', '${now}');
      INSERT INTO agent_profiles (id, project_id, name, created_at, updated_at)
      VALUES ('${profileId}', '${projectId}', 'Test Profile', '${now}', '${now}');
      INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, position, created_at, updated_at)
      VALUES ('${configId}', '${profileId}', '${providerId}', 'default', 0, '${now}', '${now}');
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedAgent(name: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, profileId, configId, name, now, now);
    return id;
  }

  function seedTeam(name: string, leadAgentId: string, memberAgentIds: string[]): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO teams (id, project_id, name, team_lead_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, name, leadAgentId, now, now);
    for (const agentId of memberAgentIds) {
      sqlite
        .prepare('INSERT INTO team_members (team_id, agent_id, created_at) VALUES (?, ?, ?)')
        .run(id, agentId, now);
    }
    return id;
  }

  function storedFlag(agentId: string): number {
    return (
      sqlite.prepare('SELECT disabled FROM agents WHERE id = ?').get(agentId) as {
        disabled: number;
      }
    ).disabled;
  }

  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

  describe('team lead', () => {
    it('fails a promotion with AGENT_DISABLED when Disable commits between validation and the team write', async () => {
      const leadA = seedAgent('Lead A');
      const leadB = seedAgent('Lead B');
      const target = seedAgent('Target');
      seedTeam('Team A', leadA, [leadA, target]);
      const teamB = seedTeam('Team B', leadB, [leadB, target]);
      const paused = deferred();
      const write = teamsStore.updateTeam.bind(teamsStore);
      jest.spyOn(teamsStore, 'updateTeam').mockImplementationOnce(async (...args) => {
        await paused.promise;
        return write(...args);
      });

      const promotion = service.updateTeam(teamB, { teamLeadAgentId: target });
      await flushMicrotasks();
      await expect(service.disableAgent(target, 'web-api')).resolves.toMatchObject({
        disabled: true,
      });
      paused.resolve();

      await expect(promotion).rejects.toMatchObject({ code: 'AGENT_DISABLED' });
      expect(
        sqlite.prepare('SELECT team_lead_agent_id FROM teams WHERE id = ?').get(teamB),
      ).toEqual({ team_lead_agent_id: leadB });
    });

    it('rejects a disabled agent as the lead of a new team', async () => {
      const lead = seedAgent('Lead');
      const target = seedAgent('Target');
      seedTeam('Team A', lead, [lead, target]);
      sqlite.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run(target);

      await expect(
        service.createTeam({
          projectId,
          name: 'Team B',
          teamLeadAgentId: target,
          memberAgentIds: [target],
        }),
      ).rejects.toMatchObject({ code: 'AGENT_DISABLED' });
      expect(sqlite.prepare("SELECT id FROM teams WHERE name = 'Team B'").get()).toBeUndefined();
    });
  });

  describe('Disable and Enable ordering', () => {
    let member: string;

    beforeEach(() => {
      const lead = seedAgent('Lead');
      member = seedAgent('Member');
      seedTeam('Team', lead, [lead, member]);
    });

    it('runs an Enable that arrives during a pending Disable after the Disable settles', async () => {
      const stop = deferred();
      stopDisabledAgent.mockReturnValueOnce(stop.promise);

      const disable = service.disableAgent(member, 'web-api');
      await flushMicrotasks();
      const enable = service.enableAgent(member);
      await flushMicrotasks();
      expect(storedFlag(member)).toBe(1);

      stop.resolve();
      await expect(disable).resolves.toMatchObject({ disabled: true });
      await expect(enable).resolves.toMatchObject({ disabled: false });
      expect(storedFlag(member)).toBe(0);
      expect(stopDisabledAgent).toHaveBeenCalledTimes(1);
    });

    it('runs a second Disable after the first one fails and rolls back', async () => {
      const firstStop = deferred();
      stopDisabledAgent.mockReturnValueOnce(firstStop.promise);

      const first = service.disableAgent(member, 'web-api');
      await flushMicrotasks();
      const second = service.disableAgent(member, 'web-api');
      await flushMicrotasks();
      firstStop.reject(new Error('tmux down'));

      await expect(first).rejects.toThrow('tmux down');
      await expect(second).resolves.toMatchObject({ disabled: true });
      expect(storedFlag(member)).toBe(1);
      expect(stopDisabledAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe('with a team write transaction open on the same connection', () => {
    /** Starts createTeam and holds it inside its write transaction until `release`. */
    async function holdTeamTransaction(leadAgentId: string, memberAgentIds: string[]) {
      const entered = deferred();
      const held = deferred();
      const store = teamsStore as unknown as { nextTeamCreatedAt(id: string): Promise<string> };
      const original = store.nextTeamCreatedAt.bind(teamsStore);
      jest.spyOn(store, 'nextTeamCreatedAt').mockImplementationOnce(async (id: string) => {
        entered.resolve();
        await held.promise;
        return original(id);
      });
      const created = service.createTeam({
        projectId,
        name: 'Held team',
        teamLeadAgentId: leadAgentId,
        memberAgentIds,
      });
      await entered.promise;
      return { created, release: () => held.resolve() };
    }

    it('returns the eligibility error once a promotion that held the transaction commits', async () => {
      const lead = seedAgent('Lead');
      const target = seedAgent('Target');
      seedTeam('Team', lead, [lead, target]);
      const team = await holdTeamTransaction(target, [target]);

      const disable = service.disableAgent(target, 'web-api');
      await flushMicrotasks();
      team.release();

      await expect(team.created).resolves.toMatchObject({ teamLeadAgentId: target });
      await expect(disable).rejects.toMatchObject({ details: { code: 'AGENT_IS_TEAM_LEAD' } });
      expect(storedFlag(target)).toBe(0);
    });

    it('disables an eligible agent after an unrelated team transaction commits', async () => {
      const lead = seedAgent('Lead');
      const member = seedAgent('Member');
      seedTeam('Team', lead, [lead, member]);
      const team = await holdTeamTransaction(lead, [lead]);

      const disable = service.disableAgent(member, 'web-api');
      await flushMicrotasks();
      team.release();

      await expect(team.created).resolves.toMatchObject({ teamLeadAgentId: lead });
      await expect(disable).resolves.toMatchObject({ disabled: true });
      expect(storedFlag(member)).toBe(1);
    });

    it('clears the flag after a failed stop while a team transaction holds the connection', async () => {
      const lead = seedAgent('Lead');
      const member = seedAgent('Member');
      seedTeam('Team', lead, [lead, member]);
      const held = deferred<Awaited<ReturnType<typeof holdTeamTransaction>>>();
      stopDisabledAgent.mockImplementationOnce(async () => {
        held.resolve(await holdTeamTransaction(lead, [lead]));
        throw new Error('tmux down');
      });

      const disable = service.disableAgent(member, 'web-api');
      const team = await held.promise;
      await flushMicrotasks();
      team.release();

      await expect(disable).rejects.toThrow('tmux down');
      await expect(team.created).resolves.toBeDefined();
      expect(storedFlag(member)).toBe(0);
    });
  });
  describe('lead notice', () => {
    // Real delivery service, so the active-session policy decides who is reached. Only the
    // session lookup, launcher and pool are fakes; the pool records what reached a lead.
    let delivery: AgentMessageDeliveryService;
    let online: Set<string>;
    let enqueue: jest.Mock;
    let ensureActiveSession: jest.Mock;

    const reachedLeads = () =>
      enqueue.mock.calls.map((call) => (call[0] as Array<{ agentId: string }>)[0].agentId).sort();
    const reachedTexts = () =>
      enqueue.mock.calls.map((call) => (call[0] as Array<{ text: string }>)[0].text);

    beforeEach(() => {
      online = new Set();
      enqueue = jest.fn(async (items: unknown[]) => items.map(() => ({ status: 'queued' })));
      ensureActiveSession = jest.fn();
      delivery = new AgentMessageDeliveryService(
        { resolve: async (agentIds: string[]) => ({ agentIds }) } as never,
        { ensureActiveSession } as never,
        { format: (message: { body: string }) => message.body } as never,
        { getAdmissionFence: () => 0, enqueue } as never,
        {} as never,
        {
          getActiveSession: async (agentId: string) =>
            online.has(agentId) ? { sessionId: `s-${agentId}` } : null,
        } as never,
        {} as never,
        storage,
      );
      service = new TeamsService(
        teamsStore,
        storage,
        {} as never,
        {} as never,
        createProjectWriteGateStub() as never,
        { stopDisabledAgent } as never,
        {} as never,
        {} as never,
        {} as never,
        delivery,
      );
    });

    it('notifies the online lead once and never starts the offline lead', async () => {
      const onlineLead = seedAgent('Online Lead');
      const offlineLead = seedAgent('Offline Lead');
      const member = seedAgent('Member');
      seedTeam('Team A', onlineLead, [onlineLead, member]);
      seedTeam('Team B', offlineLead, [offlineLead, member]);
      online.add(onlineLead);

      await service.disableAgent(member, 'web-api');
      await service.enableAgent(member);

      expect(reachedLeads()).toEqual([onlineLead, onlineLead]);
      expect(reachedTexts()).toEqual([
        'Agent Member is disabled. It is not available until a user enables it.',
        'Agent Member is enabled again.',
      ]);
      expect(ensureActiveSession).not.toHaveBeenCalled();
    });

    it('sends no notice for a repeated Disable or Enable', async () => {
      const lead = seedAgent('Lead');
      const member = seedAgent('Member');
      seedTeam('Team', lead, [lead, member]);
      online.add(lead);

      await service.disableAgent(member, 'web-api');
      await service.disableAgent(member, 'web-api');
      await service.enableAgent(member);
      await service.enableAgent(member);

      expect(enqueue).toHaveBeenCalledTimes(2);
    });

    it('keeps the state change and still notifies the other lead when one notice fails', async () => {
      const leadA = seedAgent('Lead A');
      const leadB = seedAgent('Lead B');
      const member = seedAgent('Member');
      seedTeam('Team A', leadA, [leadA, member]);
      seedTeam('Team B', leadB, [leadB, member]);
      online.add(leadA);
      online.add(leadB);
      const deliverSpy = jest.spyOn(delivery, 'deliver');
      deliverSpy.mockRejectedValueOnce(new Error('pool down'));

      await expect(service.disableAgent(member, 'web-api')).resolves.toMatchObject({
        disabled: true,
      });

      expect(storedFlag(member)).toBe(1);
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      const failedLead = (deliverSpy.mock.calls[0][0] as string[])[0];
      expect(reachedLeads()).toEqual([leadA, leadB].filter((id) => id !== failedLead));
    });
  });
  describe('delete overlapping Disable', () => {
    // Real storage decides; only the session service, preset cleanup and events are fakes,
    // so each test controls when the delete reaches its storage transaction.
    let listActiveSessions: jest.Mock;
    let terminateSession: jest.Mock;
    let removeAgentFromProjectPresets: jest.Mock;
    let publish: jest.Mock;
    let lead: string;
    let member: string;

    const removedEvents = () =>
      publish.mock.calls.filter(([name]) => name === 'team.member.removed');
    const memberRow = () =>
      sqlite
        .prepare(
          `SELECT a.disabled, COUNT(tm.team_id) AS memberships FROM agents a
           LEFT JOIN team_members tm ON tm.agent_id = a.id WHERE a.id = ? GROUP BY a.id`,
        )
        .get(member);

    beforeEach(() => {
      listActiveSessions = jest.fn().mockResolvedValue([]);
      terminateSession = jest.fn().mockResolvedValue(undefined);
      removeAgentFromProjectPresets = jest.fn().mockResolvedValue(undefined);
      publish = jest.fn().mockResolvedValue('event-id');
      service = new TeamsService(
        teamsStore,
        storage,
        { get: () => ({ listActiveSessions, terminateSession }) } as never,
        { removeAgentFromProjectPresets } as never,
        createProjectWriteGateStub() as never,
        { stopDisabledAgent } as never,
        {} as never,
        {} as never,
        {} as never,
        { deliver } as never,
        { publish } as never,
      );
      lead = seedAgent('Lead');
      member = seedAgent('Member');
      seedTeam('Team', lead, [lead, member]);
    });

    const leadDelete = () =>
      service.deleteTeamAgent({ leadAgentId: lead, projectId, name: 'Member' });

    it('refuses a team-lead delete when Disable commits during the session stop', async () => {
      const held = deferred();
      listActiveSessions.mockImplementationOnce(async () => {
        await held.promise;
        return [];
      });

      const deletion = leadDelete();
      await flushMicrotasks();
      expect(listActiveSessions).toHaveBeenCalledTimes(1);
      await expect(service.disableAgent(member, 'web-api')).resolves.toMatchObject({
        disabled: true,
      });
      held.resolve();

      await expect(deletion).resolves.toEqual({
        error: {
          code: 'AGENT_NOT_FOUND_IN_TEAM',
          message: 'No agent named "Member" found in team "Team"',
        },
      });
      expect(memberRow()).toEqual({ disabled: 1, memberships: 1 });
      expect(removedEvents()).toHaveLength(0);
      expect(removeAgentFromProjectPresets).not.toHaveBeenCalled();
    });

    it('answers a repeated lead delete at name resolution, without a session lookup', async () => {
      await service.disableAgent(member, 'web-api');

      await expect(leadDelete()).resolves.toMatchObject({
        error: { code: 'AGENT_NOT_FOUND_IN_TEAM' },
      });
      expect(listActiveSessions).not.toHaveBeenCalled();
    });

    it('refuses an automation delete when Disable commits after the agent read', async () => {
      const held = deferred();
      const readTeams = teamsStore.listTeamsByAgent.bind(teamsStore);
      jest.spyOn(teamsStore, 'listTeamsByAgent').mockImplementationOnce(async (...args) => {
        await held.promise;
        return readTeams(...args);
      });

      const deletion = service.deleteAgentForAutomation({ projectId, agentId: member });
      await flushMicrotasks();
      await service.disableAgent(member, 'web-api');
      held.resolve();

      await expect(deletion).rejects.toMatchObject({ code: 'AGENT_DISABLED' });
      expect(memberRow()).toEqual({ disabled: 1, memberships: 1 });
    });

    it('lets the human delete remove a disabled agent', async () => {
      await service.disableAgent(member, 'web-api');

      await service.deleteAgentForChat({ projectId, agentId: member });

      expect(sqlite.prepare('SELECT id FROM agents WHERE id = ?').get(member)).toBeUndefined();
    });

    it('answers not-found to a Disable that arrives after the lead delete committed', async () => {
      await expect(leadDelete()).resolves.toHaveProperty('result');

      await expect(service.disableAgent(member, 'web-api')).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(stopDisabledAgent).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT id FROM agents WHERE id = ?').get(member)).toBeUndefined();
    });
  });
});
