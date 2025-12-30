import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';
import { ValidationError } from '../../../common/errors/error-types';

describe('LocalStorageService - Transaction Rollback Integration', () => {
  it('should rollback all changes when createProjectWithTemplate fails', async () => {
    // This integration test uses a real in-memory SQLite database to verify
    // that transaction rollback works correctly (no partial writes)
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Run migrations to create schema
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    const service = new LocalStorageService(db);

    // Insert a provider (required for agent profiles)
    const providerId = 'provider-test';
    sqlite.exec(`
      INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
      VALUES ('${providerId}', 'test-provider', '/bin/test', 0, '2024-01-01', '2024-01-01')
    `);

    // Create a template with an agent that references a profile with a missing ID mapping
    // This will trigger a ValidationError during agent creation
    const templatePayload = {
      statuses: [
        {
          id: 'status-old-1',
          label: 'Backlog',
          color: '#6c757d',
          position: 0,
        },
      ],
      prompts: [
        {
          id: 'prompt-old-1',
          title: 'Test Prompt',
          content: 'Test content',
          tags: [],
        },
      ],
      profiles: [
        {
          id: 'profile-old-1',
          name: 'Test Profile',
          providerId: providerId,
          options: null,
          instructions: null,
          temperature: null,
          maxTokens: null,
        },
      ],
      agents: [
        {
          id: 'agent-old-1',
          name: 'Test Agent',
          profileId: 'profile-missing-id', // This profile ID won't exist in the mapping
        },
      ],
      epics: [],
      documents: [],
    };

    // Attempt to create project from template - should fail
    await expect(
      service.createProjectWithTemplate(
        {
          name: 'Rollback Test Project',
          description: 'Should not persist',
          rootPath: '/test/rollback',
          isTemplate: false,
        },
        templatePayload,
      ),
    ).rejects.toThrow(ValidationError);

    // Verify rollback: NO project should have been created
    const projects = sqlite.prepare('SELECT * FROM projects').all();
    expect(projects).toHaveLength(0);

    // Verify rollback: NO statuses should have been created
    const statuses = sqlite.prepare('SELECT * FROM statuses').all();
    expect(statuses).toHaveLength(0);

    // Verify rollback: NO prompts should have been created
    const prompts = sqlite.prepare('SELECT * FROM prompts').all();
    expect(prompts).toHaveLength(0);

    // Verify rollback: NO profiles should have been created
    const profiles = sqlite.prepare('SELECT * FROM agent_profiles').all();
    expect(profiles).toHaveLength(0);

    // Verify rollback: NO agents should have been created
    const agents = sqlite.prepare('SELECT * FROM agents').all();
    expect(agents).toHaveLength(0);

    sqlite.close();
  });
});
