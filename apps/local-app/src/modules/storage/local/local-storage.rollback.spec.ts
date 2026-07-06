import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';
import { ValidationError } from '../../../common/errors/error-types';

describe('LocalStorageService - Transaction Rollback Integration', () => {
  it('should rollback all create-core changes when runInTransaction fails', async () => {
    // This integration test uses a real in-memory SQLite database to verify that the
    // create-core transaction primitive (runInTransaction) rolls back atomically — no
    // partial writes when a mid-core step (here, the agent step) throws. This mirrors the
    // create-from-template core: createProjectShell + statuses + prompts + profiles + agents
    // inside ONE transaction.
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Run migrations to create schema
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    const service = new LocalStorageService(db);

    // Attempt a multi-step create-core that fails at the agent step (unresolved profile
    // mapping is exactly what the agents codec throws). The whole transaction must roll back.
    await expect(
      service.runInTransaction(async () => {
        const project = await service.createProjectShell({
          name: 'Rollback Test Project',
          description: 'Should not persist',
          rootPath: '/test/rollback',
          isTemplate: false,
        });
        await service.createStatus({
          projectId: project.id,
          label: 'Backlog',
          color: '#6c757d',
          position: 0,
        });
        await service.createPrompt({
          projectId: project.id,
          title: 'Test Prompt',
          content: 'Test content',
          tags: [],
        });
        await service.createAgentProfile({
          projectId: project.id,
          name: 'Test Profile',
          familySlug: null,
          systemPrompt: null,
          instructions: null,
          temperature: null,
          maxTokens: null,
        });
        // Mid-core failure: the agents codec throws a ValidationError when a profile mapping
        // is missing; simulate that here to prove the transaction aborts and rolls back.
        throw new ValidationError('Profile mapping missing for agent Test Agent');
      }),
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
