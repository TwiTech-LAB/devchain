import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import {
  projects,
  providers,
  agentProfiles,
  profileProviderConfigs,
  agents,
  teamProfiles,
  teamProfileConfigs,
  statuses,
  epics,
} from '../../storage/db/schema';
import {
  ConflictError,
  StorageError,
  TeamMemberCapReachedError,
} from '../../../common/errors/error-types';
import { TeamsStore } from './teams.store';

/** Insert a project and return its id */
async function seedProject(db: BetterSQLite3Database, name = 'test-project'): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id,
    name,
    description: null,
    rootPath: `/tmp/${name}`,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Insert a provider, profile, config, and agent; return agentId */
async function seedAgent(
  db: BetterSQLite3Database,
  projectId: string,
  agentName: string,
): Promise<string> {
  const now = new Date().toISOString();

  // Ensure provider exists (idempotent via unique name)
  const providerId = 'test-provider-id';
  const existingProvider = await db.select().from(providers);
  if (existingProvider.length === 0) {
    await db.insert(providers).values({
      id: providerId,
      name: 'test-provider',
      createdAt: now,
      updatedAt: now,
    });
  }

  const profileId = randomUUID();
  await db.insert(agentProfiles).values({
    id: profileId,
    projectId,
    name: `profile-${agentName}`,
    createdAt: now,
    updatedAt: now,
  });

  const configId = randomUUID();
  await db.insert(profileProviderConfigs).values({
    id: configId,
    profileId,
    providerId,
    name: `config-${agentName}`,
    options: null,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });

  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    projectId,
    profileId,
    providerConfigId: configId,
    name: agentName,
    createdAt: now,
    updatedAt: now,
  });

  return agentId;
}

/** Insert a standalone profile (not tied to an agent) and return its id */
async function seedProfile(
  db: BetterSQLite3Database,
  projectId: string,
  profileName: string,
): Promise<string> {
  const now = new Date().toISOString();
  const profileId = randomUUID();
  await db.insert(agentProfiles).values({
    id: profileId,
    projectId,
    name: profileName,
    createdAt: now,
    updatedAt: now,
  });
  return profileId;
}

/** Insert a provider config for a profile */
async function seedProviderConfig(
  db: BetterSQLite3Database,
  profileId: string,
  configName = 'default',
): Promise<string> {
  const now = new Date().toISOString();
  // Ensure at least one provider exists
  const existingProvider = await db.select().from(providers);
  const providerId = existingProvider.length > 0 ? existingProvider[0].id : 'test-provider-id';

  // Determine next available position for this profile
  const existing = await db
    .select({ position: profileProviderConfigs.position })
    .from(profileProviderConfigs)
    .where(eq(profileProviderConfigs.profileId, profileId));
  const nextPosition = existing.length > 0 ? Math.max(...existing.map((r) => r.position)) + 1 : 0;

  const configId = randomUUID();
  await db.insert(profileProviderConfigs).values({
    id: configId,
    profileId,
    providerId,
    name: configName,
    options: null,
    position: nextPosition,
    createdAt: now,
    updatedAt: now,
  });
  return configId;
}

describe('TeamsStore', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let store: TeamsStore;
  let projectId: string;
  let agentA: string;
  let agentB: string;
  let agentC: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });
    store = new TeamsStore(db);

    // Seed prerequisite data
    projectId = await seedProject(db);
    agentA = await seedAgent(db, projectId, 'Agent-A');
    agentB = await seedAgent(db, projectId, 'Agent-B');
    agentC = await seedAgent(db, projectId, 'Agent-C');
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('createTeam', () => {
    it('creates a team with members atomically', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'Backend Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });

      expect(team.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(team.name).toBe('Backend Team');
      expect(team.projectId).toBe(projectId);
      expect(team.teamLeadAgentId).toBe(agentA);
      expect(team.description).toBeNull();
      expect(team.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Verify members were persisted
      const fetched = await store.getTeam(team.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.members).toHaveLength(2);
      expect(fetched!.members.map((m) => m.agentId).sort()).toEqual([agentA, agentB].sort());
    });

    it('creates a team with no members', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'Empty Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [],
      });

      const fetched = await store.getTeam(team.id);
      expect(fetched!.members).toHaveLength(0);
    });

    it('creates a team with description', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'Described Team',
        description: 'A team with a description',
        teamLeadAgentId: agentA,
        memberAgentIds: [],
      });

      expect(team.description).toBe('A team with a description');
    });

    it('creates a team without a lead', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'Leadless Team',
        memberAgentIds: [agentA],
      });

      expect(team.teamLeadAgentId).toBeNull();

      const fetched = await store.getTeam(team.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.teamLeadAgentId).toBeNull();
      expect(fetched!.members).toHaveLength(1);
    });

    it('throws ConflictError on duplicate team name in same project (case-insensitive)', async () => {
      await store.createTeam({
        projectId,
        name: 'Backend Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [],
      });

      await expect(
        store.createTeam({
          projectId,
          name: 'backend team',
          teamLeadAgentId: agentB,
          memberAgentIds: [],
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws StorageError (not ConflictError) on duplicate member agent', async () => {
      await expect(
        store.createTeam({
          projectId,
          name: 'Dup Member Team',
          teamLeadAgentId: agentA,
          memberAgentIds: [agentA, agentA],
        }),
      ).rejects.toThrow(StorageError);

      await expect(
        store.createTeam({
          projectId,
          name: 'Dup Member Team 2',
          teamLeadAgentId: agentA,
          memberAgentIds: [agentA, agentA],
        }),
      ).rejects.toThrow('Duplicate agent in team members');
    });

    it('rolls back on member insert failure (no partial writes)', async () => {
      const invalidAgentId = randomUUID(); // Does not exist in agents table

      await expect(
        store.createTeam({
          projectId,
          name: 'Broken Team',
          teamLeadAgentId: agentA,
          memberAgentIds: [invalidAgentId],
        }),
      ).rejects.toThrow();

      // Team should NOT exist (transaction rolled back)
      const listed = await store.listTeams(projectId);
      expect(listed.items).toHaveLength(0);
    });
  });

  describe('getTeam', () => {
    it('returns team with members', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Test Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });

      const team = await store.getTeam(created.id);

      expect(team).not.toBeNull();
      expect(team!.id).toBe(created.id);
      expect(team!.name).toBe('Test Team');
      expect(team!.members).toHaveLength(2);
    });

    it('returns null for non-existent team', async () => {
      const team = await store.getTeam(randomUUID());
      expect(team).toBeNull();
    });
  });

  describe('listTeams', () => {
    it('returns teams with member counts and pagination', async () => {
      await store.createTeam({
        projectId,
        name: 'Team A',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });
      await store.createTeam({
        projectId,
        name: 'Team B',
        teamLeadAgentId: agentC,
        memberAgentIds: [agentC],
      });

      const result = await store.listTeams(projectId);

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.limit).toBe(100);
      expect(result.offset).toBe(0);

      const teamA = result.items.find((t) => t.name === 'Team A');
      const teamB = result.items.find((t) => t.name === 'Team B');
      expect(teamA!.memberCount).toBe(2);
      expect(teamB!.memberCount).toBe(1);
    });

    it('returns teams with mixed null and non-null leads', async () => {
      await store.createTeam({
        projectId,
        name: 'Leadless Team',
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'Led Team',
        teamLeadAgentId: agentB,
        memberAgentIds: [agentA, agentB],
      });

      const result = await store.listTeams(projectId);

      expect(result.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Leadless Team', teamLeadAgentId: null }),
          expect.objectContaining({ name: 'Led Team', teamLeadAgentId: agentB }),
        ]),
      );
    });

    it('respects limit and offset', async () => {
      await store.createTeam({
        projectId,
        name: 'Team 1',
        teamLeadAgentId: agentA,
        memberAgentIds: [],
      });
      await store.createTeam({
        projectId,
        name: 'Team 2',
        teamLeadAgentId: agentA,
        memberAgentIds: [],
      });
      await store.createTeam({
        projectId,
        name: 'Team 3',
        teamLeadAgentId: agentA,
        memberAgentIds: [],
      });

      const page1 = await store.listTeams(projectId, { limit: 2, offset: 0 });
      const page2 = await store.listTeams(projectId, { limit: 2, offset: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(3);
      expect(page2.items).toHaveLength(1);
      expect(page2.total).toBe(3);
    });

    it('filters by q parameter (case-insensitive substring match)', async () => {
      await store.createTeam({
        projectId,
        name: 'Backend Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'Frontend Team',
        teamLeadAgentId: agentB,
        memberAgentIds: [agentB],
      });
      await store.createTeam({
        projectId,
        name: 'DevOps Squad',
        teamLeadAgentId: agentC,
        memberAgentIds: [agentC],
      });

      const result = await store.listTeams(projectId, { q: 'team' });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.items.map((t) => t.name).sort()).toEqual(['Backend Team', 'Frontend Team']);
    });

    it('q filter works with pagination and returns correct total', async () => {
      await store.createTeam({
        projectId,
        name: 'Alpha Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'Beta Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'Gamma Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'DevOps Squad',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });

      // q matches 3 teams ("Alpha Team", "Beta Team", "Gamma Team"), page size 2
      const page1 = await store.listTeams(projectId, { q: 'team', limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await store.listTeams(projectId, { q: 'team', limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(1);
      expect(page2.total).toBe(3);
    });

    it('q filter returns empty when no matches', async () => {
      await store.createTeam({
        projectId,
        name: 'Backend Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });

      const result = await store.listTeams(projectId, { q: 'zzz-no-match' });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('returns empty result for project with no teams', async () => {
      const otherProjectId = await seedProject(db, 'other-project');
      const result = await store.listTeams(otherProjectId);

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('findTeamByExactName', () => {
    it('returns an exact case-insensitive match without depending on fuzzy pagination', async () => {
      await store.createTeam({
        projectId,
        name: 'Alpha Team',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'Beta Team',
        teamLeadAgentId: agentB,
        memberAgentIds: [agentB],
      });
      await store.createTeam({
        projectId,
        name: 'Platform',
        teamLeadAgentId: agentC,
        memberAgentIds: [agentC],
      });

      const fuzzyPage = await store.listTeams(projectId, { q: 'team', limit: 2, offset: 0 });
      const exactMatch = await store.findTeamByExactName(projectId, 'platform');

      expect(fuzzyPage.items).toHaveLength(2);
      expect(fuzzyPage.items.some((team) => team.name === 'Platform')).toBe(false);
      expect(exactMatch).toEqual(expect.objectContaining({ name: 'Platform', projectId }));
    });

    it('returns null when the exact name does not exist in the requested project', async () => {
      const otherProjectId = await seedProject(db, 'other-project');
      const otherAgent = await seedAgent(db, otherProjectId, 'Other-Agent');

      await store.createTeam({
        projectId,
        name: 'Platform',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId: otherProjectId,
        name: 'Support',
        teamLeadAgentId: otherAgent,
        memberAgentIds: [otherAgent],
      });

      const result = await store.findTeamByExactName(otherProjectId, 'platform');

      expect(result).toBeNull();
    });
  });

  describe('updateTeam', () => {
    it('updates team fields and replaces members atomically', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Original',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });

      const updated = await store.updateTeam(created.id, {
        name: 'Updated',
        description: 'New description',
        teamLeadAgentId: agentC,
        memberAgentIds: [agentC],
      });

      expect(updated.name).toBe('Updated');
      expect(updated.description).toBe('New description');
      expect(updated.teamLeadAgentId).toBe(agentC);

      const fetched = await store.getTeam(created.id);
      expect(fetched!.members).toHaveLength(1);
      expect(fetched!.members[0].agentId).toBe(agentC);
    });

    it('updates only provided fields', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Keep Name',
        description: 'Keep description',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });

      const updated = await store.updateTeam(created.id, {
        description: 'New description only',
      });

      expect(updated.name).toBe('Keep Name');
      expect(updated.description).toBe('New description only');
      expect(updated.teamLeadAgentId).toBe(agentA);

      // Members unchanged (memberAgentIds not provided)
      const fetched = await store.getTeam(created.id);
      expect(fetched!.members).toHaveLength(1);
    });

    it('allows clearing the lead with null', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Nullable Lead',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });

      const updated = await store.updateTeam(created.id, {
        teamLeadAgentId: null,
      });

      expect(updated.teamLeadAgentId).toBeNull();

      const fetched = await store.getTeam(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.teamLeadAgentId).toBeNull();
      expect(fetched!.members.map((member) => member.agentId).sort()).toEqual(
        [agentA, agentB].sort(),
      );
    });

    it('throws NotFoundError for non-existent team', async () => {
      await expect(store.updateTeam(randomUUID(), { name: 'X' })).rejects.toThrow('not found');
    });

    it('throws StorageError (not ConflictError) on duplicate member during update', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Update Dup Test',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });

      await expect(
        store.updateTeam(created.id, {
          memberAgentIds: [agentA, agentA],
        }),
      ).rejects.toThrow(StorageError);

      await expect(
        store.updateTeam(created.id, {
          memberAgentIds: [agentB, agentB],
        }),
      ).rejects.toThrow('Duplicate agent in team members');
    });

    it('rolls back on member replace failure (no partial writes)', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Rollback Test',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });

      const invalidAgentId = randomUUID();

      await expect(
        store.updateTeam(created.id, {
          name: 'Should Not Persist',
          memberAgentIds: [invalidAgentId],
        }),
      ).rejects.toThrow();

      // Team name should be unchanged (transaction rolled back)
      const fetched = await store.getTeam(created.id);
      expect(fetched!.name).toBe('Rollback Test');
      expect(fetched!.members).toHaveLength(1);
      expect(fetched!.members[0].agentId).toBe(agentA);
    });
  });

  describe('deleteTeam', () => {
    it('deletes team and cascades to members', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'To Delete',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });

      await store.deleteTeam(created.id);

      const fetched = await store.getTeam(created.id);
      expect(fetched).toBeNull();
    });

    it('is a no-op for non-existent team', async () => {
      await expect(store.deleteTeam(randomUUID())).resolves.not.toThrow();
    });
  });

  describe('listTeamsByAgent', () => {
    it('returns all teams an agent is a member of', async () => {
      await store.createTeam({
        projectId,
        name: 'Team 1',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });
      await store.createTeam({
        projectId,
        name: 'Team 2',
        teamLeadAgentId: agentC,
        memberAgentIds: [agentB, agentC],
      });

      const teamsForB = await store.listTeamsByAgent(agentB);

      expect(teamsForB).toHaveLength(2);
      expect(teamsForB.map((t) => t.name).sort()).toEqual(['Team 1', 'Team 2']);
    });

    it('returns empty array for agent with no teams', async () => {
      const result = await store.listTeamsByAgent(agentC);
      expect(result).toHaveLength(0);
    });
  });

  describe('getTeamLeadTeams', () => {
    it('returns teams where agent is team lead', async () => {
      await store.createTeam({
        projectId,
        name: 'Led by A',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });
      await store.createTeam({
        projectId,
        name: 'Led by B',
        teamLeadAgentId: agentB,
        memberAgentIds: [agentB],
      });
      await store.createTeam({
        projectId,
        name: 'Also Led by A',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA],
      });

      const leadsA = await store.getTeamLeadTeams(agentA);
      const leadsB = await store.getTeamLeadTeams(agentB);

      expect(leadsA).toHaveLength(2);
      expect(leadsA.map((t) => t.name).sort()).toEqual(['Also Led by A', 'Led by A']);
      expect(leadsB).toHaveLength(1);
      expect(leadsB[0].name).toBe('Led by B');
    });

    it('returns empty array for agent who leads no teams', async () => {
      const result = await store.getTeamLeadTeams(agentC);
      expect(result).toHaveLength(0);
    });

    it('returns no teams after a lead is cleared', async () => {
      const created = await store.createTeam({
        projectId,
        name: 'Cleared Lead',
        teamLeadAgentId: agentA,
        memberAgentIds: [agentA, agentB],
      });

      await store.updateTeam(created.id, { teamLeadAgentId: null });

      const result = await store.getTeamLeadTeams(agentA);
      expect(result).toHaveLength(0);
    });
  });

  describe('createTeam with profileIds', () => {
    it('persists profileIds when provided', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');

      const team = await store.createTeam({
        projectId,
        name: 'Profiled Team',
        memberAgentIds: [agentA],
        profileIds: [profileA, profileB],
      });

      const rows = await db.select().from(teamProfiles).where(eq(teamProfiles.teamId, team.id));

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.profileId).sort()).toEqual([profileA, profileB].sort());
    });

    it('creates team without profileIds when not provided', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'No Profiles',
        memberAgentIds: [agentA],
      });

      const rows = await db.select().from(teamProfiles).where(eq(teamProfiles.teamId, team.id));

      expect(rows).toHaveLength(0);
    });
  });

  describe('updateTeam with profileIds', () => {
    it('replaces profileIds', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');

      const team = await store.createTeam({
        projectId,
        name: 'Update Profiles',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      await store.updateTeam(team.id, { profileIds: [profileB] });

      const result = await store.getTeam(team.id);
      expect(result!.profileIds).toEqual([profileB]);
    });

    it('clears profileIds when set to empty array', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');

      const team = await store.createTeam({
        projectId,
        name: 'Clear Profiles',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      await store.updateTeam(team.id, { profileIds: [] });

      const result = await store.getTeam(team.id);
      expect(result!.profileIds).toEqual([]);
    });

    it('leaves profileIds unchanged when not provided in update', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');

      const team = await store.createTeam({
        projectId,
        name: 'Keep Profiles',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      await store.updateTeam(team.id, { name: 'Renamed' });

      const result = await store.getTeam(team.id);
      expect(result!.profileIds).toEqual([profileA]);
    });
  });

  describe('getTeam returns profileIds', () => {
    it('returns profileIds in the result', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');

      const team = await store.createTeam({
        projectId,
        name: 'Get Profiles',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      const result = await store.getTeam(team.id);

      expect(result).not.toBeNull();
      expect(result!.profileIds).toEqual([profileA]);
    });

    it('returns empty profileIds when none assigned', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'No Profiles',
        memberAgentIds: [agentA],
      });

      const result = await store.getTeam(team.id);

      expect(result).not.toBeNull();
      expect(result!.profileIds).toEqual([]);
    });
  });

  describe('listProfilesForTeam', () => {
    it('returns correct profile IDs', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');

      const team = await store.createTeam({
        projectId,
        name: 'List Profiles',
        memberAgentIds: [agentA],
        profileIds: [profileA, profileB],
      });

      const profileIds = await store.listProfilesForTeam(team.id);

      expect(profileIds.sort()).toEqual([profileA, profileB].sort());
    });

    it('returns empty array when team has no profiles', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'Empty Profiles',
        memberAgentIds: [agentA],
      });

      const profileIds = await store.listProfilesForTeam(team.id);

      expect(profileIds).toEqual([]);
    });
  });

  describe('listConfigsForTeam', () => {
    it('returns configs for team profiles', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configId = await seedProviderConfig(db, profileA, 'config-a');

      const team = await store.createTeam({
        projectId,
        name: 'Config Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      const configs = await store.listConfigsForTeam(team.id);

      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe(configId);
      expect(configs[0].profileId).toBe(profileA);
    });

    it('returns empty array when team has no profiles', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'No Configs',
        memberAgentIds: [agentA],
      });

      const configs = await store.listConfigsForTeam(team.id);

      expect(configs).toEqual([]);
    });

    it('filters out profiles from different projects (defense-in-depth)', async () => {
      const otherProjectId = await seedProject(db, 'other-project');
      const profileOther = await seedProfile(db, otherProjectId, 'Other-Profile');
      await seedProviderConfig(db, profileOther, 'other-config');

      const profileA = await seedProfile(db, projectId, 'Profile-A');
      await seedProviderConfig(db, profileA, 'config-a');

      const team = await store.createTeam({
        projectId,
        name: 'Defense Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      // Manually insert a cross-project team_profiles row
      const now = new Date().toISOString();
      await db.insert(teamProfiles).values({
        teamId: team.id,
        profileId: profileOther,
        createdAt: now,
      });

      const configs = await store.listConfigsForTeam(team.id);

      // Should only return configs for same-project profiles
      expect(configs).toHaveLength(1);
      expect(configs[0].profileId).toBe(profileA);
    });
  });

  describe('cascade deletes for team_profiles', () => {
    it('team DELETE cascades team_profiles', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');

      const team = await store.createTeam({
        projectId,
        name: 'Cascade Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      await store.deleteTeam(team.id);

      const rows = await db.select().from(teamProfiles).where(eq(teamProfiles.teamId, team.id));
      expect(rows).toHaveLength(0);
    });

    it('profile DELETE cascades team_profiles', async () => {
      const profileA = await seedProfile(db, projectId, 'Deletable-Profile');

      const team = await store.createTeam({
        projectId,
        name: 'Profile Cascade',
        memberAgentIds: [agentA],
        profileIds: [profileA],
      });

      // Delete the profile directly
      await db.delete(agentProfiles).where(eq(agentProfiles.id, profileA));

      const rows = await db.select().from(teamProfiles).where(eq(teamProfiles.teamId, team.id));
      expect(rows).toHaveLength(0);
    });

    it('deleteTeam cascades team_profile_configs', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configId = await seedProviderConfig(db, profileA, 'cfg-cascade');

      const team = await store.createTeam({
        projectId,
        name: 'Cascade TPC Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configId] }],
      });

      await store.deleteTeam(team.id);

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(0);
    });

    it('deleteTeamsByProject cascades team_profile_configs', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configId = await seedProviderConfig(db, profileA, 'cfg-cascade-proj');

      const team = await store.createTeam({
        projectId,
        name: 'Cascade Proj TPC Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configId] }],
      });

      await store.deleteTeamsByProject(projectId);

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(0);
    });

    it('deleteTeamsByIds cascades team_profile_configs', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configId = await seedProviderConfig(db, profileA, 'cfg-cascade-ids');

      const team = await store.createTeam({
        projectId,
        name: 'Cascade Ids TPC Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configId] }],
      });

      await store.deleteTeamsByIds([team.id]);

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(0);
    });

    it('removing a profile from team via updateTeam cascades team_profile_configs entries for that profile', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');
      const configA = await seedProviderConfig(db, profileA, 'cfg-a');
      const configB = await seedProviderConfig(db, profileB, 'cfg-b');

      const team = await store.createTeam({
        projectId,
        name: 'Remove Profile TPC',
        memberAgentIds: [agentA],
        profileIds: [profileA, profileB],
        profileConfigSelections: [
          { profileId: profileA, configIds: [configA] },
          { profileId: profileB, configIds: [configB] },
        ],
      });

      // Remove profileA from the team, keep profileB
      await store.updateTeam(team.id, {
        profileIds: [profileB],
        profileConfigSelections: [{ profileId: profileB, configIds: [configB] }],
      });

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].profileId).toBe(profileB);
    });

    it('deleting a provider config cascades team_profile_configs rows referencing it', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA = await seedProviderConfig(db, profileA, 'cfg-deletable');
      const configB = await seedProviderConfig(db, profileA, 'cfg-keeper');

      const team = await store.createTeam({
        projectId,
        name: 'Config Cascade Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA, configB] }],
      });

      // Delete configA directly
      await db.delete(profileProviderConfigs).where(eq(profileProviderConfigs.id, configA));

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].providerConfigId).toBe(configB);
    });
  });

  describe('writeTeamProfileConfigs and narrowing', () => {
    it('createTeam with profileConfigSelections persists the allowlist rows', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configA2 = await seedProviderConfig(db, profileA, 'cfg-a2');

      const team = await store.createTeam({
        projectId,
        name: 'Allowlist Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1, configA2] }],
      });

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.providerConfigId).sort()).toEqual([configA1, configA2].sort());
    });

    it('updateTeam replaces profileConfigSelections', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configA2 = await seedProviderConfig(db, profileA, 'cfg-a2');

      const team = await store.createTeam({
        projectId,
        name: 'Replace Selections',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      await store.updateTeam(team.id, {
        profileConfigSelections: [{ profileId: profileA, configIds: [configA2] }],
      });

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].providerConfigId).toBe(configA2);
    });

    it('listConfigsForTeam returns only allowed configs when narrowing exists', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configA2 = await seedProviderConfig(db, profileA, 'cfg-a2');

      const team = await store.createTeam({
        projectId,
        name: 'Narrowed Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      const configs = await store.listConfigsForTeam(team.id);
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe(configA1);
      expect(configs.map((c) => c.id)).not.toContain(configA2);
    });

    it('listConfigsForTeam returns ALL configs when no narrowing exists for a profile', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configA2 = await seedProviderConfig(db, profileA, 'cfg-a2');

      const team = await store.createTeam({
        projectId,
        name: 'No Narrow Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        // No profileConfigSelections
      });

      const configs = await store.listConfigsForTeam(team.id);
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.id).sort()).toEqual([configA1, configA2].sort());
    });

    it('listProfileConfigSelections returns accurate shape', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configB1 = await seedProviderConfig(db, profileB, 'cfg-b1');
      const configB2 = await seedProviderConfig(db, profileB, 'cfg-b2');

      const team = await store.createTeam({
        projectId,
        name: 'Shape Team',
        memberAgentIds: [agentA],
        profileIds: [profileA, profileB],
        profileConfigSelections: [
          { profileId: profileA, configIds: [configA1] },
          { profileId: profileB, configIds: [configB1, configB2] },
        ],
      });

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toHaveLength(2);

      const selA = selections.find((s) => s.profileId === profileA);
      const selB = selections.find((s) => s.profileId === profileB);
      expect(selA).toBeDefined();
      expect(selA!.configIds).toEqual([configA1]);
      expect(selB).toBeDefined();
      expect(selB!.configIds.sort()).toEqual([configB1, configB2].sort());
    });

    it('listProfileConfigSelections returns empty array when no narrowing exists', async () => {
      const team = await store.createTeam({
        projectId,
        name: 'Empty Selections',
        memberAgentIds: [agentA],
      });

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toEqual([]);
    });

    it('updateTeam with same profileIds and no selections preserves allowlist rows', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');

      const team = await store.createTeam({
        projectId,
        name: 'Preserve Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      await store.updateTeam(team.id, { profileIds: [profileA] });

      const configs = await store.listConfigsForTeam(team.id);
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe(configA1);

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toEqual([{ profileId: profileA, configIds: [configA1] }]);
    });

    it('updateTeam removing a profile preserves retained profile narrowing', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configB1 = await seedProviderConfig(db, profileB, 'cfg-b1');

      const team = await store.createTeam({
        projectId,
        name: 'Remove Profile Team',
        memberAgentIds: [agentA],
        profileIds: [profileA, profileB],
        profileConfigSelections: [
          { profileId: profileA, configIds: [configA1] },
          { profileId: profileB, configIds: [configB1] },
        ],
      });

      await store.updateTeam(team.id, { profileIds: [profileA] });

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toEqual([{ profileId: profileA, configIds: [configA1] }]);

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].providerConfigId).toBe(configA1);
    });

    it('updateTeam adding a profile preserves existing profile narrowing', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const profileB = await seedProfile(db, projectId, 'Profile-B');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');

      const team = await store.createTeam({
        projectId,
        name: 'Add Profile Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      await store.updateTeam(team.id, { profileIds: [profileA, profileB] });

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toEqual([{ profileId: profileA, configIds: [configA1] }]);
    });

    it('updateTeam with profileIds and explicit selections replaces narrowing', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configA2 = await seedProviderConfig(db, profileA, 'cfg-a2');

      const team = await store.createTeam({
        projectId,
        name: 'Replace With Selections',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      await store.updateTeam(team.id, {
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA2] }],
      });

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toEqual([{ profileId: profileA, configIds: [configA2] }]);
    });

    it('updateTeam with explicit empty profileConfigSelections clears all narrowing', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');
      const configA2 = await seedProviderConfig(db, profileA, 'cfg-a2');

      const team = await store.createTeam({
        projectId,
        name: 'Clear All Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      await store.updateTeam(team.id, { profileConfigSelections: [] });

      const selections = await store.listProfileConfigSelections(team.id);
      expect(selections).toEqual([]);

      const configs = await store.listConfigsForTeam(team.id);
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.id).sort()).toEqual([configA1, configA2].sort());
    });

    it('empty configIds for a profile = no rows inserted (auto-revert to allow-all)', async () => {
      const profileA = await seedProfile(db, projectId, 'Profile-A');
      const configA1 = await seedProviderConfig(db, profileA, 'cfg-a1');

      const team = await store.createTeam({
        projectId,
        name: 'Empty Configs Team',
        memberAgentIds: [agentA],
        profileIds: [profileA],
        profileConfigSelections: [{ profileId: profileA, configIds: [configA1] }],
      });

      // Update with empty configIds to revert to allow-all
      await store.updateTeam(team.id, {
        profileConfigSelections: [{ profileId: profileA, configIds: [] }],
      });

      const rows = await db
        .select()
        .from(teamProfileConfigs)
        .where(eq(teamProfileConfigs.teamId, team.id));
      expect(rows).toHaveLength(0);

      // Should now return all configs (allow-all)
      const configs = await store.listConfigsForTeam(team.id);
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe(configA1);
    });
  });

  describe('createTeamAgentAtomicCapped', () => {
    it('throws TeamMemberCapReachedError when at cap', async () => {
      const agentA = await seedAgent(db, projectId, 'CapA');
      const agentB = await seedAgent(db, projectId, 'CapB');
      const agentLead = await seedAgent(db, projectId, 'CapLead');

      const team = await store.createTeam({
        projectId,
        name: 'Capped Team',
        memberAgentIds: [agentLead, agentA, agentB],
        teamLeadAgentId: agentLead,
        maxMembers: 2,
        maxConcurrentTasks: 2,
      });

      const newAgentId = await seedAgent(db, projectId, 'CapC');

      await expect(
        store.createTeamAgentAtomicCapped({
          teamId: team.id,
          maxMembers: 2,
          teamLeadAgentId: agentLead,
          createAgentFn: async () => ({
            id: newAgentId,
            projectId,
            profileId: 'p',
            providerConfigId: 'c',
            modelOverride: null,
            name: 'CapC',
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        }),
      ).rejects.toThrow(TeamMemberCapReachedError);
    });
  });

  describe('countBusyTeamMembers', () => {
    let teamId: string;
    let agentLead: string;
    let agentM1: string;
    let agentM2: string;
    let agentOutside: string;
    let statusInProgress: string;
    let statusDone: string;

    async function seedStatus(label: string, position: number): Promise<string> {
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.insert(statuses).values({
        id,
        projectId,
        label,
        color: '#000',
        position,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    async function seedEpic(opts: {
      agentId: string;
      statusId: string;
      parentId?: string | null;
    }): Promise<string> {
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.insert(epics).values({
        id,
        projectId,
        title: `Epic-${id.slice(0, 8)}`,
        statusId: opts.statusId,
        parentId: opts.parentId ?? null,
        agentId: opts.agentId,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    beforeEach(async () => {
      statusInProgress = await seedStatus('In Progress', 10);
      statusDone = await seedStatus('Done', 20);

      agentLead = await seedAgent(db, projectId, 'BusyLead');
      agentM1 = await seedAgent(db, projectId, 'BusyM1');
      agentM2 = await seedAgent(db, projectId, 'BusyM2');
      agentOutside = await seedAgent(db, projectId, 'Outside');

      const team = await store.createTeam({
        projectId,
        name: 'Busy Team',
        memberAgentIds: [agentLead, agentM1, agentM2],
        teamLeadAgentId: agentLead,
      });
      teamId = team.id;
    });

    it('returns 0 when no sub-epics exist', async () => {
      const count = await store.countBusyTeamMembers(teamId, agentLead);
      expect(count).toBe(0);
    });

    it('returns 1 for one busy member', async () => {
      const parentEpic = await seedEpic({ agentId: agentLead, statusId: statusInProgress });
      await seedEpic({ agentId: agentM1, statusId: statusInProgress, parentId: parentEpic });

      const count = await store.countBusyTeamMembers(teamId, agentLead);
      expect(count).toBe(1);
    });

    it('returns N for N busy members', async () => {
      const parentEpic = await seedEpic({ agentId: agentLead, statusId: statusInProgress });
      await seedEpic({ agentId: agentM1, statusId: statusInProgress, parentId: parentEpic });
      await seedEpic({ agentId: agentM2, statusId: statusInProgress, parentId: parentEpic });

      const count = await store.countBusyTeamMembers(teamId, agentLead);
      expect(count).toBe(2);
    });

    it('filters out Done/DONE/done statuses (mixed case)', async () => {
      const statusDoneUpper = await seedStatus('DONE', 21);
      const statusDoneMixed = await seedStatus('done', 22);
      const parentEpic = await seedEpic({ agentId: agentLead, statusId: statusInProgress });

      await seedEpic({ agentId: agentM1, statusId: statusDone, parentId: parentEpic });
      await seedEpic({ agentId: agentM2, statusId: statusDoneUpper, parentId: parentEpic });
      await seedEpic({ agentId: agentM1, statusId: statusDoneMixed, parentId: parentEpic });

      const count = await store.countBusyTeamMembers(teamId, agentLead);
      expect(count).toBe(0);
    });

    it('ignores top-level epics (parentId IS NULL)', async () => {
      await seedEpic({ agentId: agentM1, statusId: statusInProgress, parentId: null });

      const count = await store.countBusyTeamMembers(teamId, agentLead);
      expect(count).toBe(0);
    });

    it('ignores agents not in the team', async () => {
      const parentEpic = await seedEpic({ agentId: agentLead, statusId: statusInProgress });
      await seedEpic({ agentId: agentOutside, statusId: statusInProgress, parentId: parentEpic });

      const count = await store.countBusyTeamMembers(teamId, agentLead);
      expect(count).toBe(0);
    });

    it('leadless team returns accurate count (not 0)', async () => {
      const leadlessTeam = await store.createTeam({
        projectId,
        name: 'Leadless Busy',
        memberAgentIds: [agentM1, agentM2],
        teamLeadAgentId: null,
      });
      const parentEpic = await seedEpic({ agentId: agentM1, statusId: statusInProgress });
      await seedEpic({ agentId: agentM1, statusId: statusInProgress, parentId: parentEpic });
      await seedEpic({ agentId: agentM2, statusId: statusInProgress, parentId: parentEpic });

      const count = await store.countBusyTeamMembers(leadlessTeam.id, null);
      expect(count).toBe(2);
    });
  });
});
