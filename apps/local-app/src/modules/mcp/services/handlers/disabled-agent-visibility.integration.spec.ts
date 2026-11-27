import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createTestDatabase } from '../../../../common/test/test-database.helper';
import { LocalStorageService } from '../../../storage/local/local-storage.service';
import { createProjectWriteGateStub } from '../../../storage/write-gate/testing/project-write-gate.stub';
import { TeamsStore } from '../../../teams/storage/teams.store';
import { TeamsService } from '../../../teams/services/teams.service';
import { resolveFamilyAgentTargets } from '../../../subscribers/actions/family-agent-targets';
import { EpicsService } from '../../../epics/services/epics.service';
import { ManagedProjectionLock } from '../../../external-integrations/subscribers/managed-projection-lock';
import { MobileChatRpcService } from '../../../cloud-tunnel/services/mobile-chat-rpc.service';
import { handleListAgents, handleGetAgentByName } from './agent-tools';
import { handleSendMessage } from './chat-tools';
import { handleCreateEpic, handleUpdateEpic, handleListAssignedEpicsTasks } from './epic-tools';
import {
  handleDevchainTeam,
  handleTeamsCreateAgent,
  handleTeamsList,
  handleTeamsMembersList,
} from './teams-tools';

/**
 * Real SQLite, storage, team store and service, epic service and mobile RPC service: the filter
 * lives in SQL, so only a real database shows that a disabled agent is hidden from agent-facing
 * tools and still found by the complete default read. Delivery and sessions are fakes.
 */
describe('Disabled agents in agent-facing MCP tools', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let teamsService: TeamsService;
  let projectId: string;
  let profileId: string;
  let configId: string;
  let teamId: string;
  let lead: { id: string; name: string };
  let alice: { id: string; name: string };
  let bob: { id: string; name: string };
  let carol: { id: string; name: string };
  let deliverAgentMessage: jest.Mock;
  let epicsService: EpicsService;
  let openStatusId: string;
  let autoCleanStatusId: string;

  const sessionContext = () => ({
    success: true,
    data: {
      type: 'agent',
      session: { id: 'sess-1', agentId: lead.id, status: 'active', startedAt: '' },
      agent: { id: lead.id, name: lead.name, projectId },
      project: { id: projectId, name: 'Test Project', rootPath: '/tmp/test' },
    },
  });
  const resolveSessionContext = jest.fn(async () => sessionContext());

  function seedAgent(name: string, disabled = false): { id: string; name: string } {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, profileId, configId, name, disabled ? 1 : 0, now, now);
    return { id, name };
  }

  const names = (rows: Array<{ agentName?: string; name?: string }>) =>
    rows.map((row) => row.agentName ?? row.name);

  beforeEach(() => {
    sqlite = createTestDatabase().sqlite;
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    storage = new LocalStorageService(db);
    deliverAgentMessage = jest.fn(async (descriptors: Array<{ agentId: string }>) => ({
      status: 'queued',
      results: descriptors.map((d) => ({ agentId: d.agentId, status: 'queued' })),
    }));
    teamsService = new TeamsService(
      new TeamsStore(db),
      storage,
      {} as never,
      {} as never,
      createProjectWriteGateStub() as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    projectId = randomUUID();
    const providerId = randomUUID();
    profileId = randomUUID();
    configId = randomUUID();
    teamId = randomUUID();
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

    lead = seedAgent('Lead');
    alice = seedAgent('Alice');
    bob = seedAgent('Bob', true);
    carol = seedAgent('Carol');
    sqlite
      .prepare(
        `INSERT INTO teams (id, project_id, name, team_lead_agent_id, max_members, created_at, updated_at)
         VALUES (?, ?, 'Builders', ?, 3, ?, ?)`,
      )
      .run(teamId, projectId, lead.id, now, now);
    for (const member of [lead, alice, bob, carol]) {
      sqlite
        .prepare('INSERT INTO team_members (team_id, agent_id, created_at) VALUES (?, ?, ?)')
        .run(teamId, member.id, now);
    }

    openStatusId = randomUUID();
    autoCleanStatusId = randomUUID();
    const insertStatus = sqlite.prepare(
      `INSERT INTO statuses (id, project_id, label, color, position, created_at, updated_at)
       VALUES (?, ?, ?, '#000', ?, ?, ?)`,
    );
    insertStatus.run(openStatusId, projectId, 'New', 0, now, now);
    insertStatus.run(autoCleanStatusId, projectId, 'Archived', 1, now, now);
    epicsService = new EpicsService(
      storage,
      {
        publish: jest.fn().mockResolvedValue('event-id'),
        prepareCommitted: jest.fn((name: string, payload: unknown) => ({
          id: randomUUID(),
          name,
          payload,
          requestId: null,
          publishedAt: now,
        })),
        emitCommitted: jest.fn(),
      } as never,
      { getAutoCleanStatusIds: () => [autoCleanStatusId] } as never,
      { emit: jest.fn() } as never,
      createProjectWriteGateStub() as never,
      {} as never,
      { pullNow: jest.fn() } as never,
      new ManagedProjectionLock(),
      { isClaimedHost: () => false },
      { write: jest.fn() },
    );
  });

  const epicCount = () =>
    (sqlite.prepare('SELECT COUNT(*) AS count FROM epics').get() as { count: number }).count;
  const storedAssignee = (epicId: string) =>
    (sqlite.prepare('SELECT agent_id FROM epics WHERE id = ?').get(epicId) as { agent_id: string })
      .agent_id;

  afterEach(() => {
    sqlite.close();
  });

  const agentCtx = () =>
    ({
      storage,
      sessionsService: { getAgentPresence: jest.fn().mockResolvedValue(new Map()) },
      terminalIO: { listAllSessionNames: jest.fn().mockResolvedValue(new Set()) },
      instructionsResolver: {},
      teamsService,
      defaultInlineMaxBytes: 1000,
      resolveSessionContext,
    }) as never;
  const teamsCtx = () => ({ storage, teamsService, resolveSessionContext }) as never;
  const chatCtx = () =>
    ({
      storage,
      teamsService,
      agentMessageDelivery: { deliverAgentMessage, deliver: jest.fn() },
      settingsService: { getMessagePoolConfigForProject: () => ({ delayMs: 0 }) },
      projectCommunicationService: {},
      resolveSessionContext,
    }) as never;
  const epicCtx = () =>
    ({
      storage,
      epicsService,
      resolveSessionContext,
    }) as never;

  describe('rosters and lookups', () => {
    it('hides the disabled member from every roster tool', async () => {
      const list = await handleListAgents(agentCtx(), { sessionId: 's' });
      expect(names((list.data as { agents: never[] }).agents)).not.toContain('Bob');

      const members = await handleTeamsMembersList(teamsCtx(), { sessionId: 's' });
      const memberNames = names(
        (members.data as { teams: Array<{ members: never[] }> }).teams[0].members,
      );
      expect(memberNames.sort()).toEqual(['Alice', 'Carol', 'Lead']);

      const team = await handleDevchainTeam(teamsCtx(), { sessionId: 's' });
      expect(names((team.data as { members: never[] }).members)).not.toContain('Bob');

      const teams = await handleTeamsList(teamsCtx(), { sessionId: 's' });
      expect((teams.data as { teams: Array<{ memberCount: number }> }).teams[0].memberCount).toBe(
        3,
      );
    });

    it('answers a lookup of the disabled name like an unknown name', async () => {
      const disabled = await handleGetAgentByName(agentCtx(), { sessionId: 's', name: 'Bob' });
      const unknown = await handleGetAgentByName(agentCtx(), { sessionId: 's', name: 'Nobody' });

      expect(disabled.success).toBe(false);
      expect(disabled.error?.code).toBe('AGENT_NOT_FOUND');
      expect(disabled.error?.data).toEqual(unknown.error?.data);
      expect(disabled.error?.data).toEqual({ availableNames: ['Lead', 'Alice', 'Carol'] });
    });

    it('refuses to create an agent with the name of a disabled agent', async () => {
      sqlite.prepare('UPDATE teams SET allow_team_lead_create_agents = 1 WHERE id = ?').run(teamId);
      sqlite
        .prepare('INSERT INTO team_profiles (team_id, profile_id, created_at) VALUES (?, ?, ?)')
        .run(teamId, profileId, new Date().toISOString());
      const agentRows = () =>
        (sqlite.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }).count;
      const before = agentRows();

      const result = await handleTeamsCreateAgent(teamsCtx(), {
        sessionId: 's',
        name: 'bob',
        configName: 'default',
      });

      expect(result.error?.code).toBe('AGENT_NAME_EXISTS');
      expect(agentRows()).toBe(before);
    });
  });

  describe('devchain_send_message', () => {
    it('answers recipient-not-found for the disabled name', async () => {
      const result = await handleSendMessage(chatCtx(), {
        sessionId: 's',
        message: 'hi',
        recipientAgentNames: ['Bob'],
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RECIPIENT_NOT_FOUND');
      expect(result.error?.message).not.toContain('Bob,');
      expect(deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('skips the disabled member in a team fan-out and delivers to the others', async () => {
      // The sender is the lead, so the fan-out goes to the members.
      const result = await handleSendMessage(chatCtx(), {
        sessionId: 's',
        message: 'hi',
        teamName: 'Builders',
      });

      expect(result.error).toBeUndefined();
      const descriptors = deliverAgentMessage.mock.calls[0][0] as Array<{ agentName: string }>;
      expect(descriptors.map((d) => d.agentName).sort()).toEqual(['Alice', 'Carol']);
    });
  });

  describe('epic tools', () => {
    it('refuses to create an epic for the disabled name and creates nothing', async () => {
      const result = await handleCreateEpic(epicCtx(), {
        sessionId: 's',
        title: 'T',
        agentName: 'Bob',
      });

      expect(result.error?.code).toBe('AGENT_NOT_FOUND');
      expect(epicCount()).toBe(0);
    });

    it.each([
      ['an open status', 'New'],
      ['an auto-clean status', 'Archived'],
    ])('assigns an enabled name on create in %s', async (_label, statusName) => {
      const result = await handleCreateEpic(epicCtx(), {
        sessionId: 's',
        title: 'T',
        agentName: 'alice',
        statusName,
      });

      expect(result.error).toBeUndefined();
      expect(storedAssignee((result.data as { id: string }).id)).toBe(alice.id);
    });

    describe('update', () => {
      let epicId: string;
      beforeEach(async () => {
        epicId = (
          await storage.createEpicForProject(projectId, {
            title: 'Assigned',
            statusId: openStatusId,
            agentId: bob.id,
          })
        ).id;
      });

      it('refuses an assignment to the disabled name and lists only enabled agents', async () => {
        sqlite.prepare('UPDATE epics SET agent_id = ? WHERE id = ?').run(alice.id, epicId);

        const result = await handleUpdateEpic(epicCtx(), {
          sessionId: 's',
          id: epicId,
          version: 1,
          assignment: { agentName: 'Bob' },
        });

        expect(result.error?.code).toBe('AGENT_NOT_FOUND');
        const available = (result.error?.data as { availableAgents: Array<{ name: string }> })
          .availableAgents;
        expect(available.map((a) => a.name)).not.toContain('Bob');
        expect(storedAssignee(epicId)).toBe(alice.id);
      });

      it('edits another field of an epic already assigned to the disabled agent', async () => {
        const result = await handleUpdateEpic(epicCtx(), {
          sessionId: 's',
          id: epicId,
          version: 1,
          title: 'New title',
        });

        expect(result.error).toBeUndefined();
        const row = sqlite.prepare('SELECT title, agent_id FROM epics WHERE id = ?').get(epicId);
        expect(row).toEqual({ title: 'New title', agent_id: bob.id });
      });
    });

    it('answers agent-not-found when listing the assigned epics of the disabled name', async () => {
      const result = await handleListAssignedEpicsTasks(epicCtx(), {
        sessionId: 's',
        agentName: 'Bob',
      });

      expect(result.error?.code).toBe('AGENT_NOT_FOUND');
    });
  });

  describe('mobile chat RPC', () => {
    it('omits the disabled agent from chat.listAgents and from chat.listTeams', async () => {
      const mobile = new MobileChatRpcService(
        storage,
        { listActiveSessions: async () => [] } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        teamsService,
        {} as never,
        {} as never,
        {} as never,
      );

      const agents = await mobile.listAgents({ projectId });
      const teams = await mobile.listTeams({ projectId });

      expect(agents.map((agent) => agent.name).sort()).toEqual(['Alice', 'Carol', 'Lead']);
      expect(teams).toHaveLength(1);
      expect(teams[0].memberAgentIds).not.toContain(bob.id);
      expect(teams[0].memberAgentIds.sort()).toEqual([lead.id, alice.id, carol.id].sort());
      expect(teams[0].memberCount).toBe(3);
    });
  });

  describe('family automation', () => {
    it('skips the disabled agent and still acts on the enabled agents of the family', async () => {
      sqlite
        .prepare('UPDATE agent_profiles SET family_slug = ? WHERE id = ?')
        .run('coders', profileId);

      const targets = await resolveFamilyAgentTargets(storage, projectId, 'coders');

      expect(targets.map((agent) => agent.name)).toEqual(['Alice', 'Carol', 'Lead']);
    });
  });

  describe('team capacity', () => {
    it('reports the enabled members and keeps the seat of the disabled one', async () => {
      const result = await handleDevchainTeam(teamsCtx(), { sessionId: 's' });

      expect(result.data).toMatchObject({ maxMembers: 3, currentMemberCount: 2, freeSeats: 0 });
    });
  });
});
