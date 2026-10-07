import { Test } from '@nestjs/testing';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { DB_CONNECTION } from '../storage/db/db.provider';
import type { RemoteOperation } from '../storage/models/domain.models';
import { GitOwnerStore } from './git-owner.store';
import { AttachOperation } from './operations/attach.operation';
import { DetachOperation } from './operations/detach.operation';
import type { RemoteOperationDefinition } from './operations/remote-operation.types';

// Real SQLite proves durable ownership and cleanup through the bind/unbind steps.
describe('Git owner persistence', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let owner: GitOwnerStore;

  beforeEach(async () => {
    database = createTestDatabase();
    const module = await Test.createTestingModule({
      providers: [GitOwnerStore, { provide: DB_CONNECTION, useValue: database.db }],
    }).compile();
    owner = module.get(GitOwnerStore);
  });

  afterEach(() => database.sqlite.close());

  it('persists PC ownership across store recreation and deletes VM/default entries independently', () => {
    expect(owner.get('p')).toBe('vm');
    owner.set('p', 'home');
    owner.set('other', 'home');
    const reopened = new GitOwnerStore(database.db);
    expect(reopened.get('p')).toBe('home');
    reopened.set('p', 'vm');
    expect(owner.get('p')).toBe('vm');
    expect(owner.get('other')).toBe('home');
    const row = database.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('remotes.gitOwner') as { value: string };
    expect(JSON.parse(row.value)).toEqual({ other: 'home' });
    owner.clear('other');
    owner.clear('other');
    expect(reopened.get('other')).toBe('vm');
  });

  it.each(['bind_remote', 'unbind'] as const)('clears saved ownership at %s', async (stepId) => {
    owner.set('p', 'home');
    const unused = {} as never;
    let connected = false;
    const bindings = {
      update: async () => {
        connected = true;
      },
      delete: async () => {
        connected = false;
      },
    };
    const instance: RemoteOperationDefinition =
      stepId === 'bind_remote'
        ? new AttachOperation(
            unused,
            bindings as never,
            unused,
            unused,
            unused,
            unused,
            unused,
            unused,
            unused,
            unused,
            unused,
            unused,
            unused,
            owner,
          )
        : new DetachOperation(
            unused,
            bindings as never,
            unused,
            unused,
            unused,
            { stop: async () => undefined } as never,
            unused,
            unused,
            unused,
            unused,
            owner,
          );
    const step = instance.steps.find((candidate) => candidate.id === stepId)!;
    await step.run({
      operation: { projectId: 'p' } as RemoteOperation,
      details: { importCursor: 'cursor' },
      progress: async () => undefined,
    } as Parameters<typeof step.run>[0]);
    expect(connected).toBe(stepId === 'bind_remote');
    expect(owner.get('p')).toBe('vm');
  });
});
