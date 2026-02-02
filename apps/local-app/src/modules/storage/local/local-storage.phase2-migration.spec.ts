/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { readFileSync } from 'fs';

// NOTE: These tests are skipped because they require the old schema structure
// (agent_profiles.provider_id column) which was removed in Phase 4 migrations (0031).
// The Phase 2 migrations (0028-0030) have already been deployed and tested in production.
// These tests are kept for reference but can no longer be executed against the current schema.
describe.skip('Phase 2 Migration - Profile Provider Configs Integration', () => {
  let sqlite: Database.Database;

  const migrationsFolder = join(__dirname, '../../../../drizzle');

  // Helper to run a specific migration SQL file
  const runMigration = (filename: string) => {
    const sql = readFileSync(join(migrationsFolder, filename), 'utf-8');
    // For complex migrations with temp tables, run as single transaction
    sqlite.exec(sql.replace(/--> statement-breakpoint/g, ''));
  };

  // Helper to seed test data
  const seedTestData = () => {
    // Create project
    sqlite.exec(`
      INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
      VALUES ('project-1', 'Test Project', '/test', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
    `);

    // Create provider
    sqlite.exec(`
      INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
      VALUES ('provider-claude', 'claude', '/usr/bin/claude', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
    `);

    // Create status (required for epics)
    sqlite.exec(`
      INSERT INTO statuses (id, project_id, label, color, position, mcp_hidden, created_at, updated_at)
      VALUES ('status-1', 'project-1', 'New', '#000', 1, 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
    `);
  };

  beforeEach(() => {
    // Create fresh in-memory database
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Run migrations up to (but not including) Phase 2 migrations
    // This creates the schema including profile_provider_configs table
    migrate(db, { migrationsFolder });

    // Clear any data that migrations might have created
    sqlite.exec('DELETE FROM profile_provider_configs');
    sqlite.exec('DELETE FROM agents');
    sqlite.exec('DELETE FROM agent_profiles');
    sqlite.exec('DELETE FROM statuses');
    sqlite.exec('DELETE FROM projects');
    sqlite.exec('DELETE FROM providers');
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('0028_populate_provider_configs', () => {
    it('should create one config per profile with providerId', () => {
      seedTestData();

      // Create profiles with providerId
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, options, created_at, updated_at)
        VALUES
          ('profile-1', 'project-1', 'Profile 1', 'provider-claude', '--model claude-3', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('profile-2', 'project-1', 'Profile 2', 'provider-claude', '--model opus', '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z')
      `);

      // Run migration
      runMigration('0028_populate_provider_configs.sql');

      // Verify configs created
      const configs = sqlite.prepare('SELECT * FROM profile_provider_configs').all() as any[];
      expect(configs).toHaveLength(2);

      // Verify config data matches profile
      const config1 = configs.find((c) => c.profile_id === 'profile-1');
      expect(config1).toBeDefined();
      expect(config1.provider_id).toBe('provider-claude');
      expect(config1.options).toBe('--model claude-3');
      expect(config1.env).toBeNull();
    });

    it('should skip profiles with NULL providerId', () => {
      seedTestData();

      // Create profile without providerId
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, options, created_at, updated_at)
        VALUES ('profile-null', 'project-1', 'No Provider', NULL, NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run migration
      runMigration('0028_populate_provider_configs.sql');

      // Verify no config created
      const configs = sqlite.prepare('SELECT * FROM profile_provider_configs').all();
      expect(configs).toHaveLength(0);
    });

    it('should be idempotent (safe to run twice)', () => {
      seedTestData();

      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, options, created_at, updated_at)
        VALUES ('profile-1', 'project-1', 'Profile 1', 'provider-claude', '--model claude-3', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run migration twice
      runMigration('0028_populate_provider_configs.sql');
      runMigration('0028_populate_provider_configs.sql');

      // Should still have only 1 config
      const configs = sqlite.prepare('SELECT * FROM profile_provider_configs').all();
      expect(configs).toHaveLength(1);
    });
  });

  describe('0029_merge_profiles_by_family_slug', () => {
    it('should merge profiles with same familySlug, keeping oldest', () => {
      seedTestData();

      // Add more providers for the test
      sqlite.exec(`
        INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
        VALUES
          ('provider-codex', 'codex', '/usr/bin/codex', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('provider-gemini', 'gemini', '/usr/bin/gemini', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Note: UNIQUE constraint on (project_id, family_slug, provider_id) requires different providers
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES
          ('profile-old', 'project-1', 'Old Profile', 'provider-claude', 'coder', '--old', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('profile-mid', 'project-1', 'Mid Profile', 'provider-codex', 'coder', '--mid', '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z'),
          ('profile-new', 'project-1', 'New Profile', 'provider-gemini', 'coder', '--new', '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z')
      `);

      // Create configs first (prerequisite)
      runMigration('0028_populate_provider_configs.sql');

      // Create agents pointing to different profiles
      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES
          ('agent-1', 'project-1', 'profile-mid', 'Agent 1', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('agent-2', 'project-1', 'profile-new', 'Agent 2', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run merge migration
      runMigration('0029_merge_profiles_by_family_slug.sql');

      // Verify only oldest profile remains
      const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all() as any[];
      expect(profiles).toHaveLength(1);
      expect(profiles[0].id).toBe('profile-old');

      // Verify agents updated to canonical profile
      const agents = sqlite.prepare('SELECT * FROM agents').all() as any[];
      expect(agents).toHaveLength(2);
      expect(agents[0].profile_id).toBe('profile-old');
      expect(agents[1].profile_id).toBe('profile-old');

      // Verify all configs moved to canonical
      const configs = sqlite.prepare('SELECT * FROM profile_provider_configs').all() as any[];
      expect(configs).toHaveLength(3);
      configs.forEach((c) => {
        expect(c.profile_id).toBe('profile-old');
      });
    });

    it('should not merge profiles with different familySlug', () => {
      seedTestData();

      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES
          ('profile-a', 'project-1', 'Profile A', 'provider-claude', 'coder', '--a', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('profile-b', 'project-1', 'Profile B', 'provider-claude', 'reviewer', '--b', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      runMigration('0028_populate_provider_configs.sql');
      runMigration('0029_merge_profiles_by_family_slug.sql');

      // Both profiles should remain
      const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all();
      expect(profiles).toHaveLength(2);
    });

    it('should not merge profiles with NULL familySlug', () => {
      seedTestData();

      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES
          ('profile-null-1', 'project-1', 'Null Slug 1', 'provider-claude', NULL, '--1', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('profile-null-2', 'project-1', 'Null Slug 2', 'provider-claude', NULL, '--2', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      runMigration('0028_populate_provider_configs.sql');
      runMigration('0029_merge_profiles_by_family_slug.sql');

      // Both profiles should remain (NULL familySlug not grouped)
      const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all();
      expect(profiles).toHaveLength(2);
    });
  });

  describe('0030_set_agents_provider_config_id', () => {
    it('should set providerConfigId for all agents', () => {
      seedTestData();

      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, options, created_at, updated_at)
        VALUES ('profile-1', 'project-1', 'Profile 1', 'provider-claude', '--model claude-3', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES
          ('agent-1', 'project-1', 'profile-1', 'Agent 1', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('agent-2', 'project-1', 'profile-1', 'Agent 2', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run all migrations
      runMigration('0028_populate_provider_configs.sql');
      runMigration('0029_merge_profiles_by_family_slug.sql');
      runMigration('0030_set_agents_provider_config_id.sql');

      // Verify all agents have providerConfigId
      const agents = sqlite.prepare('SELECT * FROM agents').all() as any[];
      expect(agents).toHaveLength(2);
      agents.forEach((a) => {
        expect(a.provider_config_id).not.toBeNull();
      });

      // Verify config belongs to agent's profile
      const config = sqlite
        .prepare('SELECT * FROM profile_provider_configs WHERE id = ?')
        .get(agents[0].provider_config_id) as any;
      expect(config.profile_id).toBe('profile-1');
    });

    it('should be idempotent (safe to run twice)', () => {
      seedTestData();

      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, options, created_at, updated_at)
        VALUES ('profile-1', 'project-1', 'Profile 1', 'provider-claude', '--model claude-3', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES ('agent-1', 'project-1', 'profile-1', 'Agent 1', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      runMigration('0028_populate_provider_configs.sql');
      runMigration('0029_merge_profiles_by_family_slug.sql');
      runMigration('0030_set_agents_provider_config_id.sql');

      const configIdBefore = (sqlite.prepare('SELECT provider_config_id FROM agents').get() as any)
        .provider_config_id;

      // Run again
      runMigration('0030_set_agents_provider_config_id.sql');

      const configIdAfter = (sqlite.prepare('SELECT provider_config_id FROM agents').get() as any)
        .provider_config_id;

      // Should be same config
      expect(configIdAfter).toBe(configIdBefore);
    });
  });

  describe('migration-guard', () => {
    it('should detect active sessions', () => {
      seedTestData();

      // Create a profile and agent for session
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, created_at, updated_at)
        VALUES ('profile-1', 'project-1', 'Profile', 'provider-claude', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES ('agent-1', 'project-1', 'profile-1', 'Agent 1', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
        VALUES ('session-1', 'agent-1', 'running', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Check for active sessions
      const activeSessions = sqlite
        .prepare("SELECT * FROM sessions WHERE status = 'running' AND ended_at IS NULL")
        .all();

      expect(activeSessions).toHaveLength(1);
    });

    it('should pass when no active sessions', () => {
      seedTestData();

      // Create a profile and agent for session
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, created_at, updated_at)
        VALUES ('profile-1', 'project-1', 'Profile', 'provider-claude', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES ('agent-1', 'project-1', 'profile-1', 'Agent 1', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO sessions (id, agent_id, status, started_at, ended_at, created_at, updated_at)
        VALUES ('session-1', 'agent-1', 'stopped', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z')
      `);

      // Check for active sessions
      const activeSessions = sqlite
        .prepare("SELECT * FROM sessions WHERE status = 'running' AND ended_at IS NULL")
        .all();

      expect(activeSessions).toHaveLength(0);
    });
  });

  describe('full migration flow', () => {
    it('should handle complex scenario with multiple projects and profiles', () => {
      // Create projects
      sqlite.exec(`
        INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
        VALUES
          ('project-1', 'Project 1', '/test1', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('project-2', 'Project 2', '/test2', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
        VALUES
          ('provider-claude', 'claude', '/usr/bin/claude', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('provider-codex', 'codex', '/usr/bin/codex', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('provider-gemini', 'gemini', '/usr/bin/gemini', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Note: There's a unique index on (project_id, family_slug, provider_id)
      // So profiles with same familySlug must have different providers
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES
          ('p1-coder-claude', 'project-1', 'Coder Claude', 'provider-claude', 'coder', '--claude', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('p1-coder-codex', 'project-1', 'Coder Codex', 'provider-codex', 'coder', '--codex', '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z'),
          ('p1-unique', 'project-1', 'Unique', 'provider-claude', 'unique-slug', '--unique', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Profile in project 2
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES ('p2-coder', 'project-2', 'P2 Coder', 'provider-claude', 'coder', '--p2', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Agents
      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES
          ('agent-p1-1', 'project-1', 'p1-coder-codex', 'Agent using Codex', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('agent-p1-2', 'project-1', 'p1-unique', 'Agent unique', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('agent-p2-1', 'project-2', 'p2-coder', 'Agent P2', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run all migrations
      runMigration('0028_populate_provider_configs.sql');
      runMigration('0029_merge_profiles_by_family_slug.sql');
      runMigration('0030_set_agents_provider_config_id.sql');

      // Verify profiles: project-1 should have 2 (coder merged to oldest, unique kept), project-2 should have 1
      const profiles = sqlite
        .prepare('SELECT * FROM agent_profiles ORDER BY project_id, id')
        .all() as any[];
      expect(profiles).toHaveLength(3);

      const p1Profiles = profiles.filter((p) => p.project_id === 'project-1');
      expect(p1Profiles).toHaveLength(2);
      expect(p1Profiles.map((p) => p.id).sort()).toEqual(['p1-coder-claude', 'p1-unique']);

      // Verify all agents have valid providerConfigId
      const agents = sqlite.prepare('SELECT * FROM agents').all() as any[];
      expect(agents).toHaveLength(3);
      agents.forEach((a) => {
        expect(a.provider_config_id).not.toBeNull();
        // Verify config exists and belongs to agent's profile
        const config = sqlite
          .prepare('SELECT * FROM profile_provider_configs WHERE id = ?')
          .get(a.provider_config_id) as any;
        expect(config).toBeDefined();
        expect(config.profile_id).toBe(a.profile_id);
      });

      // Verify configs count: 2 from merged coder group + 1 unique + 1 from project-2 = 4
      const configs = sqlite.prepare('SELECT * FROM profile_provider_configs').all();
      expect(configs).toHaveLength(4);
    });
  });

  describe('fixed migration: agent providerConfigId matches original provider', () => {
    it('should assign correct providerConfigId for merged agents (0029 fix)', () => {
      // This test verifies the fix from Task:1 - agents whose profiles are merged
      // should get providerConfigId matching their ORIGINAL provider, not oldest config

      // Setup: Create project and providers
      sqlite.exec(`
        INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
        VALUES ('project-1', 'Test Project', '/test', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
        VALUES
          ('provider-claude', 'claude', '/usr/bin/claude', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('provider-codex', 'codex', '/usr/bin/codex', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Create two profiles with same familySlug but different providers
      // The OLDER profile uses codex, the NEWER uses claude
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES
          ('profile-codex', 'project-1', 'Architect (Codex)', 'provider-codex', 'architect', '--codex-opts', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('profile-claude', 'project-1', 'Architect (Claude)', 'provider-claude', 'architect', '--claude-opts', '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z')
      `);

      // Create provider configs first
      runMigration('0028_populate_provider_configs.sql');

      // Create agents - one using codex profile, one using claude profile
      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES
          ('agent-using-codex', 'project-1', 'profile-codex', 'Planner (uses Codex)', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('agent-using-claude', 'project-1', 'profile-claude', 'Coder (uses Claude)', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run merge migration (fixes from Task:1)
      runMigration('0029_merge_profiles_by_family_slug.sql');

      // Run config assignment migration (fixes from Task:2)
      runMigration('0030_set_agents_provider_config_id.sql');

      // Verify: Only canonical profile remains (oldest = codex)
      const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all() as any[];
      expect(profiles).toHaveLength(1);
      expect(profiles[0].id).toBe('profile-codex');

      // Both configs should now be under the canonical profile
      const configs = sqlite
        .prepare('SELECT * FROM profile_provider_configs ORDER BY provider_id')
        .all() as any[];
      expect(configs).toHaveLength(2);
      configs.forEach((c) => expect(c.profile_id).toBe('profile-codex'));

      // Find the config for each provider
      const claudeConfig = configs.find((c) => c.provider_id === 'provider-claude');
      const codexConfig = configs.find((c) => c.provider_id === 'provider-codex');

      // CRITICAL VERIFICATION: Each agent gets config matching their ORIGINAL provider
      const agents = sqlite.prepare('SELECT * FROM agents ORDER BY id').all() as any[];
      expect(agents).toHaveLength(2);

      const agentUsingClaude = agents.find((a) => a.id === 'agent-using-claude');
      const agentUsingCodex = agents.find((a) => a.id === 'agent-using-codex');

      // agent-using-claude should have claude config (not oldest!)
      expect(agentUsingClaude.provider_config_id).toBe(claudeConfig.id);

      // agent-using-codex should have codex config
      expect(agentUsingCodex.provider_config_id).toBe(codexConfig.id);

      // Both should point to canonical profile
      expect(agentUsingClaude.profile_id).toBe('profile-codex');
      expect(agentUsingCodex.profile_id).toBe('profile-codex');
    });

    it('should assign correct providerConfigId for non-merged agents (0030 fix)', () => {
      // This test verifies the fix from Task:2 - agents whose profiles are NOT merged
      // should get providerConfigId matching their profile's providerId, not oldest config

      // Setup: Create project and providers
      sqlite.exec(`
        INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
        VALUES ('project-1', 'Test Project', '/test', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
        VALUES
          ('provider-claude', 'claude', '/usr/bin/claude', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          ('provider-codex', 'codex', '/usr/bin/codex', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Create a single profile (no merge needed) with claude provider
      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, family_slug, options, created_at, updated_at)
        VALUES ('profile-claude', 'project-1', 'Standalone Profile', 'provider-claude', 'unique-slug', '--claude', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Create provider configs
      runMigration('0028_populate_provider_configs.sql');

      // Manually add a second config with different provider (simulating edge case)
      // The codex config is OLDER by created_at, but profile's provider_id is claude
      sqlite.exec(`
        INSERT INTO profile_provider_configs (id, profile_id, provider_id, options, env, created_at, updated_at)
        VALUES ('config-codex-older', 'profile-claude', 'provider-codex', '--codex', NULL, '2023-01-01T00:00:00Z', '2023-01-01T00:00:00Z')
      `);

      // Create an agent using this profile
      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
        VALUES ('agent-1', 'project-1', 'profile-claude', 'Test Agent', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      // Run migrations (0029 won't merge this profile since it's unique)
      runMigration('0029_merge_profiles_by_family_slug.sql');
      runMigration('0030_set_agents_provider_config_id.sql');

      // Profile should remain unchanged
      const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all() as any[];
      expect(profiles).toHaveLength(1);

      // There should be 2 configs (claude from 0028, codex manually added)
      const configs = sqlite
        .prepare('SELECT * FROM profile_provider_configs ORDER BY created_at')
        .all() as any[];
      expect(configs).toHaveLength(2);

      const claudeConfig = configs.find((c) => c.provider_id === 'provider-claude');
      const codexConfig = configs.find((c) => c.provider_id === 'provider-codex');

      // Codex config is older
      expect(new Date(codexConfig.created_at).getTime()).toBeLessThan(
        new Date(claudeConfig.created_at).getTime(),
      );

      // CRITICAL VERIFICATION: Agent gets claude config (matches profile's provider_id)
      // NOT codex config (which would be selected if using ORDER BY created_at)
      const agent = sqlite.prepare('SELECT * FROM agents').get() as any;
      expect(agent.provider_config_id).toBe(claudeConfig.id);
      expect(agent.provider_config_id).not.toBe(codexConfig.id);
    });

    it('should handle agents already having providerConfigId set', () => {
      // Verify idempotency - migrations should not overwrite existing values

      sqlite.exec(`
        INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
        VALUES ('project-1', 'Test Project', '/test', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
        VALUES ('provider-claude', 'claude', '/usr/bin/claude', 0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      sqlite.exec(`
        INSERT INTO agent_profiles (id, project_id, name, provider_id, options, created_at, updated_at)
        VALUES ('profile-1', 'project-1', 'Profile', 'provider-claude', '--opts', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      runMigration('0028_populate_provider_configs.sql');

      // Get the created config id
      const config = sqlite.prepare('SELECT * FROM profile_provider_configs').get() as any;

      // Create agent with ALREADY SET provider_config_id
      sqlite.exec(`
        INSERT INTO agents (id, project_id, profile_id, name, provider_config_id, created_at, updated_at)
        VALUES ('agent-1', 'project-1', 'profile-1', 'Agent', '${config.id}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
      `);

      const configIdBefore = (sqlite.prepare('SELECT provider_config_id FROM agents').get() as any)
        .provider_config_id;

      // Run migrations
      runMigration('0029_merge_profiles_by_family_slug.sql');
      runMigration('0030_set_agents_provider_config_id.sql');

      const configIdAfter = (sqlite.prepare('SELECT provider_config_id FROM agents').get() as any)
        .provider_config_id;

      // Config should not have changed
      expect(configIdAfter).toBe(configIdBefore);
    });
  });
});
