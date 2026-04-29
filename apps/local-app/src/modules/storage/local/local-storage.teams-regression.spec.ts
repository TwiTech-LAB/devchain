import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';
import { importProjectWithHelper } from '../../projects/helpers/project-import';
import { TeamsStore } from '../../teams/storage/teams.store';

/**
 * Integration tests verifying that destructive flows (deleteAgent, deleteProject,
 * importProject) work correctly when teams and team_members exist.
 *
 * Uses real in-memory SQLite with migrations applied — no mocks.
 */
describe('Teams Regression – Destructive Flows', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: LocalStorageService;
  let projectId: string;
  let providerId: string;
  let profileId: string;
  let configId: string;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });
    service = new LocalStorageService(db);

    // Seed shared prerequisite data
    projectId = randomUUID();
    providerId = randomUUID();
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

      INSERT INTO statuses (id, project_id, label, color, position, created_at, updated_at)
      VALUES ('${randomUUID()}', '${projectId}', 'New', '#6c757d', 0, '${now}', '${now}');
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedAgent(name: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
      VALUES ('${id}', '${projectId}', '${profileId}', '${configId}', '${name}', '${now}', '${now}')
    `);
    return id;
  }

  function seedTeam(name: string, leadAgentId: string | null, memberAgentIds: string[]): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const serializedLead = leadAgentId === null ? 'NULL' : `'${leadAgentId}'`;
    sqlite.exec(`
      INSERT INTO teams (id, project_id, name, team_lead_agent_id, created_at, updated_at)
      VALUES ('${id}', '${projectId}', '${name}', ${serializedLead}, '${now}', '${now}')
    `);
    for (const agentId of memberAgentIds) {
      sqlite.exec(`
        INSERT INTO team_members (team_id, agent_id, created_at)
        VALUES ('${id}', '${agentId}', '${now}')
      `);
    }
    return id;
  }

  describe('deleteAgent', () => {
    it('disbands leadless teams that lose their final member', async () => {
      const agentA = seedAgent('Agent-A');
      const teamId = seedTeam('Leadless Team', null, [agentA]);

      const team = sqlite
        .prepare('SELECT id, team_lead_agent_id FROM teams WHERE id = ?')
        .get(teamId) as { id: string; team_lead_agent_id: string | null };
      expect(team).toEqual({ id: teamId, team_lead_agent_id: null });

      await expect(service.deleteAgent(agentA)).resolves.not.toThrow();

      expect(sqlite.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)).toBeUndefined();
      expect(sqlite.prepare('SELECT * FROM team_members WHERE team_id = ?').all(teamId)).toEqual(
        [],
      );
    });

    it('succeeds and clears team lead when agent is team lead', async () => {
      const agentA = seedAgent('Agent-A');
      const agentB = seedAgent('Agent-B');
      const teamId = seedTeam('Backend Team', agentA, [agentA, agentB]);

      await expect(service.deleteAgent(agentA)).resolves.not.toThrow();

      const teams = sqlite
        .prepare('SELECT id, team_lead_agent_id FROM teams WHERE id = ?')
        .all(teamId) as Array<{ id: string; team_lead_agent_id: string | null }>;
      expect(teams).toEqual([{ id: teamId, team_lead_agent_id: null }]);

      const members = sqlite.prepare('SELECT * FROM team_members').all();
      expect(members).toHaveLength(1);
      expect((members[0] as { agent_id: string }).agent_id).toBe(agentB);
    });

    it('succeeds and removes team membership when agent is NOT a lead', async () => {
      const agentA = seedAgent('Agent-A');
      const agentB = seedAgent('Agent-B');
      seedTeam('Backend Team', agentA, [agentA, agentB]);

      // Deleting agentB (member, not lead) should succeed
      await expect(service.deleteAgent(agentB)).resolves.not.toThrow();

      // Verify team still exists and agentB membership is gone (cascade)
      const members = sqlite.prepare('SELECT * FROM team_members').all();
      expect(members).toHaveLength(1);
      expect((members[0] as { agent_id: string }).agent_id).toBe(agentA);
    });

    it('clears only the deleted agent lead when agent leads one team but is member of another', async () => {
      const agentA = seedAgent('Agent-A');
      const agentB = seedAgent('Agent-B');
      const alphaTeamId = seedTeam('Alpha Team', agentA, [agentA, agentB]);
      const betaTeamId = seedTeam('Beta Team', agentB, [agentA, agentB]);

      await expect(service.deleteAgent(agentA)).resolves.not.toThrow();

      const teams = sqlite
        .prepare('SELECT id, team_lead_agent_id FROM teams WHERE id IN (?, ?) ORDER BY id')
        .all(alphaTeamId, betaTeamId) as Array<{ id: string; team_lead_agent_id: string | null }>;
      expect(teams).toEqual(
        expect.arrayContaining([
          { id: alphaTeamId, team_lead_agent_id: null },
          { id: betaTeamId, team_lead_agent_id: agentB },
        ]),
      );
    });

    it('disbands teams when a lead is also the final member', async () => {
      const agentA = seedAgent('Agent-A');
      const teamId = seedTeam('Solo Team', agentA, [agentA]);

      await expect(service.deleteAgent(agentA)).resolves.not.toThrow();

      expect(sqlite.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)).toBeUndefined();
      expect(sqlite.prepare('SELECT * FROM team_members WHERE team_id = ?').all(teamId)).toEqual(
        [],
      );
    });
  });

  describe('deleteProject', () => {
    it('succeeds with teams present — cleans up team_members and teams before agents', async () => {
      const agentA = seedAgent('Agent-A');
      const agentB = seedAgent('Agent-B');
      seedTeam('Backend Team', agentA, [agentA, agentB]);
      seedTeam('Frontend Team', agentB, [agentA, agentB]);

      // deleteProject should not throw any FK constraint errors
      await expect(service.deleteProject(projectId)).resolves.not.toThrow();

      // Verify everything is cleaned up
      const teams = sqlite.prepare('SELECT * FROM teams').all();
      const members = sqlite.prepare('SELECT * FROM team_members').all();
      const agents = sqlite.prepare('SELECT * FROM agents').all();
      const projects = sqlite.prepare('SELECT * FROM projects').all();

      expect(teams).toHaveLength(0);
      expect(members).toHaveLength(0);
      expect(agents).toHaveLength(0);
      expect(projects).toHaveLength(0);
    });

    it('succeeds when project has teams with team leads (no FK RESTRICT error)', async () => {
      const agentA = seedAgent('Agent-A');
      // agentA is team lead — without the cascade fix, this would fail with FK RESTRICT
      seedTeam('Lead Team', agentA, [agentA]);

      await expect(service.deleteProject(projectId)).resolves.not.toThrow();

      const teams = sqlite.prepare('SELECT * FROM teams').all();
      expect(teams).toHaveLength(0);
    });
  });

  describe('importProject (replace flow)', () => {
    it('succeeds with existing teams — cleanupTeamsForProject runs before agent deletion', async () => {
      const agentA = seedAgent('Agent-A');
      const agentB = seedAgent('Agent-B');
      seedTeam('Backend Team', agentA, [agentA, agentB]);

      // Verify teams exist before import
      expect(sqlite.prepare('SELECT * FROM teams').all()).toHaveLength(1);
      expect(sqlite.prepare('SELECT * FROM team_members').all()).toHaveLength(2);

      const teamsStore = new TeamsStore(db);

      // Call importProjectWithHelper with an empty payload (replace flow)
      // This exercises the clearExistingProjectData path which must clean up teams first
      const result = await importProjectWithHelper(
        { projectId, payload: {} },
        {
          storage: service,
          settings: {
            updateSettings: jest.fn().mockResolvedValue(undefined),
            setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
            setProjectPresets: jest.fn().mockResolvedValue(undefined),
            clearProjectPresets: jest.fn().mockResolvedValue(undefined),
          } as never,
          watchersService: { deleteWatcher: jest.fn().mockResolvedValue(undefined) },
          sessions: { getActiveSessionsForProject: () => [] },
          cleanupTeamsForProject: (pid) => teamsStore.deleteTeamsByProject(pid),
          unifiedTemplateService: {
            getBundledTemplate: () => {
              throw new Error('not bundled');
            },
          },
          computeFamilyAlternatives: async () => ({
            alternatives: [],
            missingProviders: [],
            canImport: true,
          }),
          createWatchersFromPayload: async () => ({ created: 0, watcherIdMap: {} }),
          createSubscribersFromPayload: async () => ({ created: 0, subscriberIdMap: {} }),
          applyProjectSettings: async () => ({ initialPromptSet: false }),
          getImportErrorMessage: (e) => (e instanceof Error ? e.message : String(e)),
        },
      );

      // Import should succeed without FK constraint errors
      expect(result).toHaveProperty('success', true);

      // Verify teams and team_members are cleaned up
      expect(sqlite.prepare('SELECT * FROM teams').all()).toHaveLength(0);
      expect(sqlite.prepare('SELECT * FROM team_members').all()).toHaveLength(0);

      // Verify agents were deleted (replaced with empty set)
      expect(sqlite.prepare('SELECT * FROM agents').all()).toHaveLength(0);
    });
  });
});
