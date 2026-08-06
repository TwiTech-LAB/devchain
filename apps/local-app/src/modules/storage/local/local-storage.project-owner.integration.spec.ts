import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundError } from '../../../common/errors/error-types';
import type { Agent, Project } from '../models/domain.models';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - project owner', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: join(__dirname, '../../../../drizzle') });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  async function createProject(name: string): Promise<Project> {
    return service.createProject({
      name,
      description: null,
      rootPath: `/tmp/${name.toLowerCase()}`,
      isTemplate: false,
    });
  }

  async function createAgent(
    projectId: string,
    name: string,
    isProjectOwner?: boolean,
  ): Promise<Agent> {
    const provider = await service.createProvider({ name: `provider-${name}-${randomUUID()}` });
    const profile = await service.createAgentProfile({
      projectId,
      name: `profile-${name}`,
    });
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${name}`,
    });
    return service.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name,
      ...(isProjectOwner === undefined ? {} : { isProjectOwner }),
    });
  }

  function ownerIds(projectId: string): string[] {
    return (
      sqlite
        .prepare('SELECT id FROM agents WHERE project_id = ? AND is_project_owner = 1 ORDER BY id')
        .all(projectId) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  it('migrates existing agent rows to false with a non-null default', () => {
    const legacySqlite = new Database(':memory:');
    try {
      legacySqlite.exec(`
        CREATE TABLE agents (id text PRIMARY KEY, project_id text NOT NULL);
        INSERT INTO agents (id, project_id) VALUES ('legacy-agent', 'legacy-project');
      `);
      const migrationSql = readFileSync(
        join(__dirname, '../../../../drizzle/0069_fluffy_exodus.sql'),
        'utf8',
      );
      for (const statement of migrationSql.split('--> statement-breakpoint')) {
        if (statement.trim()) {
          legacySqlite.exec(statement);
        }
      }

      expect(
        legacySqlite
          .prepare('SELECT is_project_owner FROM agents WHERE id = ?')
          .get('legacy-agent'),
      ).toEqual({ is_project_owner: 0 });
      const column = (
        legacySqlite.prepare("PRAGMA table_info('agents')").all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((entry) => entry.name === 'is_project_owner');
      expect(column).toMatchObject({ notnull: 1, dflt_value: 'false' });
    } finally {
      legacySqlite.close();
    }
  });

  it('defaults new agents to false and accepts the optional internal create flag', async () => {
    const defaultProject = await createProject('Default Owner');
    const explicitProject = await createProject('Explicit Owner');

    const defaultAgent = await createAgent(defaultProject.id, 'Default');
    const explicitOwner = await createAgent(explicitProject.id, 'Explicit', true);

    expect(defaultAgent.isProjectOwner).toBe(false);
    expect((await service.getAgent(defaultAgent.id)).isProjectOwner).toBe(false);
    expect(explicitOwner.isProjectOwner).toBe(true);
    expect(ownerIds(explicitProject.id)).toEqual([explicitOwner.id]);
  });

  it('enforces at most one owner per project for direct database writes', async () => {
    const project = await createProject('Unique Owner');
    const agentA = await createAgent(project.id, 'Unique-A');
    const agentB = await createAgent(project.id, 'Unique-B');

    sqlite.prepare('UPDATE agents SET is_project_owner = 1 WHERE id = ?').run(agentA.id);

    expect(() =>
      sqlite.prepare('UPDATE agents SET is_project_owner = 1 WHERE id = ?').run(agentB.id),
    ).toThrow(/UNIQUE constraint failed/);
    expect(ownerIds(project.id)).toEqual([agentA.id]);
  });

  it('hands ownership off atomically, isolates projects, and supports explicit unassignment', async () => {
    const projectA = await createProject('Project A');
    const projectB = await createProject('Project B');
    const agentA = await createAgent(projectA.id, 'Handoff-A');
    const agentB = await createAgent(projectA.id, 'Handoff-B');
    const otherOwner = await createAgent(projectB.id, 'Other-Owner', true);

    await service.updateAgent(agentA.id, { isProjectOwner: true });
    await service.updateAgent(agentB.id, { isProjectOwner: true });

    expect((await service.getAgent(agentA.id)).isProjectOwner).toBe(false);
    expect((await service.getAgent(agentB.id)).isProjectOwner).toBe(true);
    expect((await service.getAgent(otherOwner.id)).isProjectOwner).toBe(true);

    await service.updateAgent(agentB.id, { name: 'Handoff-B-Renamed' });
    expect((await service.getAgent(agentB.id)).isProjectOwner).toBe(true);

    await service.updateAgent(agentB.id, { isProjectOwner: false });
    expect(ownerIds(projectA.id)).toEqual([]);
    expect(ownerIds(projectB.id)).toEqual([otherOwner.id]);
  });

  it('serializes simultaneous assignments so the project finishes with one owner', async () => {
    const project = await createProject('Concurrent Owner');
    const agentA = await createAgent(project.id, 'Concurrent-A');
    const agentB = await createAgent(project.id, 'Concurrent-B');

    await Promise.all([
      service.updateAgent(agentA.id, { isProjectOwner: true }),
      service.updateAgent(agentB.id, { isProjectOwner: true }),
    ]);

    expect(ownerIds(project.id)).toHaveLength(1);
    expect([agentA.id, agentB.id]).toContain(ownerIds(project.id)[0]);
  });

  it('retains the prior owner when the requested target does not exist', async () => {
    const project = await createProject('Missing Target');
    const owner = await createAgent(project.id, 'Existing-Owner', true);

    await expect(service.updateAgent('missing-agent', { isProjectOwner: true })).rejects.toThrow(
      NotFoundError,
    );

    expect(ownerIds(project.id)).toEqual([owner.id]);
  });

  it('rolls back the clear when setting the target owner fails', async () => {
    const project = await createProject('Rollback Owner');
    const owner = await createAgent(project.id, 'Rollback-A', true);
    const target = await createAgent(project.id, 'Rollback-B');

    sqlite.exec(`
      CREATE TRIGGER fail_owner_assignment
      BEFORE UPDATE OF is_project_owner ON agents
      WHEN OLD.id = '${target.id}' AND NEW.is_project_owner = 1
      BEGIN
        SELECT RAISE(FAIL, 'injected owner assignment failure');
      END;
    `);

    await expect(service.updateAgent(target.id, { isProjectOwner: true })).rejects.toThrow(
      'injected owner assignment failure',
    );

    expect(ownerIds(project.id)).toEqual([owner.id]);
    expect((await service.getAgent(target.id)).isProjectOwner).toBe(false);
  });

  it('requires the target update to affect exactly one row and rolls back otherwise', async () => {
    const project = await createProject('Ignored Update');
    const owner = await createAgent(project.id, 'Ignored-A', true);
    const target = await createAgent(project.id, 'Ignored-B');

    sqlite.exec(`
      CREATE TRIGGER ignore_owner_assignment
      BEFORE UPDATE OF is_project_owner ON agents
      WHEN OLD.id = '${target.id}' AND NEW.is_project_owner = 1
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    await expect(service.updateAgent(target.id, { isProjectOwner: true })).rejects.toThrow(
      NotFoundError,
    );

    expect(ownerIds(project.id)).toEqual([owner.id]);
  });

  it('allows owner deletion and leaves the project without an owner', async () => {
    const project = await createProject('Delete Owner');
    const owner = await createAgent(project.id, 'Delete-Owner', true);

    await service.deleteAgent(owner.id);

    expect(ownerIds(project.id)).toEqual([]);
  });

  it('retains ownership when a running session prevents owner deletion', async () => {
    const project = await createProject('Blocked Delete');
    const owner = await createAgent(project.id, 'Blocked-Owner', true);
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, agent_id, tmux_session_id, status, started_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(randomUUID(), owner.id, `tmux-${owner.id}`, now, now, now);

    await expect(service.deleteAgent(owner.id)).rejects.toThrow(/active session/);

    expect(ownerIds(project.id)).toEqual([owner.id]);
  });
});
