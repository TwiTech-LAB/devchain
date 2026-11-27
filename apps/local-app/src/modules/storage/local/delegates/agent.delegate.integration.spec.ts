import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createTestDatabase } from '../../../../common/test/test-database.helper';
import { LocalStorageService } from '../local-storage.service';

/**
 * The disabled flag rules live in SQL transactions, so they run against real SQLite with the
 * migrations applied: a mock cannot show that the check and the write share one transaction.
 */
describe('Agent storage – disabled flag', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  let projectId: string;
  let profileId: string;
  let configId: string;

  beforeEach(() => {
    sqlite = createTestDatabase().sqlite;
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(drizzle(sqlite));

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

  /** Inserts without the `disabled` column, as rows written before the migration. */
  function seedAgent(name: string, options: { owner?: boolean } = {}): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, is_project_owner, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, options.owner ? 1 : 0, profileId, configId, name, now, now);
    return id;
  }

  function seedTeam(name: string, leadAgentId: string | null, memberAgentIds: string[]): void {
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
  }

  function storedFlag(agentId: string): number {
    return (
      sqlite.prepare('SELECT disabled FROM agents WHERE id = ?').get(agentId) as {
        disabled: number;
      }
    ).disabled;
  }

  it('reads disabled false for an agent stored without a disabled value', async () => {
    const agentId = seedAgent('Legacy');

    await expect(service.getAgent(agentId)).resolves.toMatchObject({ disabled: false });
  });

  it.each([
    {
      code: 'AGENT_IS_PROJECT_OWNER',
      arrange: (target: string, other: string) => {
        sqlite.prepare('UPDATE agents SET is_project_owner = 1 WHERE id = ?').run(target);
        seedTeam('Team', other, [other, target]);
      },
    },
    {
      // A member of one team that leads another team.
      code: 'AGENT_IS_TEAM_LEAD',
      arrange: (target: string, other: string) => {
        seedTeam('Member team', other, [other, target]);
        seedTeam('Led team', target, [target]);
      },
    },
    { code: 'AGENT_NOT_IN_TEAM', arrange: () => undefined },
  ])('rejects Disable with $code and keeps the agent enabled', async ({ code, arrange }) => {
    const target = seedAgent('Target');
    const other = seedAgent('Other');
    arrange(target, other);

    await expect(service.disableAgent(target)).rejects.toMatchObject({ details: { code } });
    expect(storedFlag(target)).toBe(0);
  });

  it('disables a team member, and a repeat succeeds without a change', async () => {
    const lead = seedAgent('Lead');
    const member = seedAgent('Member');
    seedTeam('Team', lead, [lead, member]);

    await expect(service.disableAgent(member)).resolves.toMatchObject({
      agent: { id: member, disabled: true },
      changed: true,
    });
    await expect(service.disableAgent(member)).resolves.toMatchObject({
      agent: { id: member, disabled: true },
      changed: false,
    });
    expect(storedFlag(member)).toBe(1);
  });

  it('enables a disabled agent that is in no team', async () => {
    const agentId = seedAgent('Orphan');
    sqlite.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run(agentId);

    await expect(service.enableAgent(agentId)).resolves.toMatchObject({ disabled: false });
    expect(storedFlag(agentId)).toBe(0);
  });

  it('rejects a disabled agent as Project Owner and keeps the current owner', async () => {
    const owner = seedAgent('Owner', { owner: true });
    const agentId = seedAgent('Parked');
    sqlite.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run(agentId);

    await expect(service.updateAgent(agentId, { isProjectOwner: true })).rejects.toMatchObject({
      code: 'AGENT_DISABLED',
    });
    await expect(service.getAgent(owner)).resolves.toMatchObject({ isProjectOwner: true });
  });

  it('rejects a protected delete of a disabled agent', async () => {
    const lead = seedAgent('Lead');
    const member = seedAgent('Member');
    seedTeam('Team', lead, [lead, member]);
    sqlite.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run(member);

    await expect(service.deleteAgent(member, { protectDisabled: true })).rejects.toMatchObject({
      code: 'AGENT_DISABLED',
    });
    expect(sqlite.prepare('SELECT id FROM agents WHERE id = ?').get(member)).toEqual({
      id: member,
    });
  });
});

/** Real SQLite shows that the move and the delete share one transaction. */
describe('Agent storage – delete keeps family sessions', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  let projectId: string;
  let providerId: string;
  const now = new Date().toISOString();

  beforeEach(() => {
    sqlite = createTestDatabase().sqlite;
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(drizzle(sqlite));
    projectId = randomUUID();
    providerId = randomUUID();
    sqlite.exec(`
      INSERT INTO projects (id, name, description, root_path, created_at, updated_at)
      VALUES ('${projectId}', 'Test Project', NULL, '/tmp/test', '${now}', '${now}');
      INSERT INTO providers (id, name, created_at, updated_at)
      VALUES ('${providerId}', 'test-provider', '${now}', '${now}');
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedProfile(familySlug: string | null): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, id, familySlug, now, now);
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES (?, ?, ?, 'default', 0, ?, ?)`,
      )
      .run(id, id, providerId, now, now);
    return id;
  }

  function seedAgent(name: string, profileId: string, disabled = false): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, profileId, profileId, name, disabled ? 1 : 0, now, now);
    return id;
  }

  /** A stopped root, a failed root, and a save point of the stopped root. */
  function seedSessions(agentId: string): string[] {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const insert = sqlite.prepare(
      `INSERT INTO sessions (id, agent_id, parent_session_id, kind, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(ids[0], agentId, null, 'session', 'stopped', now, now, now);
    insert.run(ids[1], agentId, null, 'session', 'failed', now, now, now);
    insert.run(ids[2], agentId, ids[0], 'save_point', 'stopped', now, now, now);
    return ids;
  }

  function owners(sessionIds: string[]): (string | undefined)[] {
    return sessionIds.map(
      (id) =>
        (
          sqlite.prepare('SELECT agent_id FROM sessions WHERE id = ?').get(id) as
            | { agent_id: string }
            | undefined
        )?.agent_id,
    );
  }

  it('moves stopped, failed and saved sessions to the enabled member first by name', async () => {
    const gone = seedAgent('Gone', seedProfile('coder'));
    seedAgent('Aaron', seedProfile(' CODER '), true);
    seedAgent('Zed', seedProfile('Coder'));
    const bob = seedAgent('bob', seedProfile('coder '));
    const sessionIds = seedSessions(gone);

    await service.deleteAgent(gone);

    expect(owners(sessionIds)).toEqual([bob, bob, bob]);
  });

  it('breaks a name tie by id', async () => {
    const profileId = seedProfile(null);
    const gone = seedAgent('Gone', profileId);
    const [first] = [seedAgent('Twin', profileId), seedAgent('twin', profileId)].sort();
    const sessionIds = seedSessions(gone);

    await service.deleteAgent(gone);

    expect(owners(sessionIds)).toEqual([first, first, first]);
  });

  it('deletes the sessions of the last member; agents of another slugless profile do not count', async () => {
    const gone = seedAgent('Gone', seedProfile(null));
    seedAgent('Stranger', seedProfile(null));
    const sessionIds = seedSessions(gone);

    await service.deleteAgent(gone);

    expect(owners(sessionIds)).toEqual([undefined, undefined, undefined]);
  });

  it('leaves the agent and its sessions unchanged when the delete fails', async () => {
    const profileId = seedProfile('coder');
    const gone = seedAgent('Gone', profileId);
    seedAgent('Heir', profileId);
    const sessionIds = seedSessions(gone);
    sqlite.exec(`
      CREATE TRIGGER fail_agent_delete BEFORE DELETE ON agents WHEN OLD.id = '${gone}'
      BEGIN SELECT RAISE(FAIL, 'injected agent delete failure'); END;
    `);

    await expect(service.deleteAgent(gone)).rejects.toThrow('injected agent delete failure');

    expect(sqlite.prepare('SELECT id FROM agents WHERE id = ?').get(gone)).toEqual({ id: gone });
    expect(owners(sessionIds)).toEqual([gone, gone, gone]);
  });
});
