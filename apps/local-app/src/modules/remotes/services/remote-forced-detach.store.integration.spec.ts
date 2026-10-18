// SQLite integration verifies the durable write before binding removal and
// idempotent replay; unrelated detach effects remain outside this boundary test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteOperation, RemoteOperationKind } from '../../storage/models/domain.models';
import { DetachOperation } from '../operations/detach.operation';
import { RemoteForcedDetachStore } from './remote-forced-detach.store';
import { RemoteForcedDetachService } from './remote-forced-detach.service';

describe('forced detach durable boundary', () => {
  let db: ReturnType<typeof createTestDatabase>;
  let directory: string;
  let storage: LocalStorageService;
  let store: RemoteForcedDetachStore;
  let remoteId: string;
  let projectId: string;
  let detach: DetachOperation;
  let recordedAtRemoval: ReturnType<RemoteForcedDetachStore['pending']>;

  beforeEach(async () => {
    db = createTestDatabase();
    directory = mkdtempSync(join(tmpdir(), 'forced-detach-boundary-'));
    storage = new LocalStorageService(
      db.db,
      new IntegrationCredentialCipher({ secretDirectory: directory }),
    );
    store = new RemoteForcedDetachStore(db.db);
    remoteId = (
      await storage.createRemote({ name: 'VM', kind: 'address', baseUrl: 'https://vm.example' })
    ).id;
    projectId = (
      await storage.createProject({
        name: 'project',
        description: null,
        rootPath: directory,
        isTemplate: false,
      })
    ).id;
    await storage.createRemoteProjectBinding({ remoteId, projectId });
    recordedAtRemoval = [];
    const unused = {} as never;
    detach = new DetachOperation(
      unused,
      {
        delete: async (id: string) => {
          recordedAtRemoval = new RemoteForcedDetachStore(db.db).pending();
          await storage.deleteRemoteProjectBinding(id);
        },
      } as never,
      unused,
      unused,
      unused,
      { stop: async () => undefined } as never,
      unused,
      unused,
      unused,
      unused,
      { clear: () => undefined } as never,
      { freezeRemoteEmpty: async () => null } as never,
      new RemoteForcedDetachService(store, { sharedVmAbandon: async () => undefined } as never),
    );
  });

  afterEach(() => {
    db.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function unbind(kind: RemoteOperationKind, force: boolean): Promise<void> {
    // Unbind follows preflight; retain its loss checkpoint at this isolated boundary.
    const details = {
      force,
      ...(force && {
        forcedLoss: {
          hostCursor: null,
          mirrorAgeMs: null,
          fileSync: 'unknown' as const,
          teamLanes: 'unfinalized' as const,
        },
      }),
    };
    const operation: RemoteOperation = {
      kind,
      projectId,
      remoteId,
      id: 'operation',
      details,
      state: 'running',
      steps: [],
      createdAt: '2026-10-12T15:00:00Z',
      updatedAt: '2026-10-12T15:00:00Z',
    };
    await detach.steps
      .find((step) => step.id === 'unbind')!
      .run({ operation, details, progress: async () => undefined });
  }

  it.each([
    { kind: 'detach' as const, force: true, records: true },
    { kind: 'detach' as const, force: false, records: false },
    { kind: 'reset_vm' as const, force: true, records: false },
  ])(
    'records before deleting the binding only for a real forced Disconnect ($kind, $force)',
    async ({ kind, force, records }) => {
      await unbind(kind, force);
      await unbind(kind, force);
      expect(recordedAtRemoval).toEqual(records ? [{ remoteId, projectId }] : []);
      expect(store.pending()).toEqual(recordedAtRemoval);
      expect(await storage.getRemoteProjectBinding(projectId)).toBeNull();
    },
  );

  it('keeps the binding when the durable tombstone write fails', async () => {
    jest.spyOn(store, 'record').mockRejectedValue(new Error('settings write failed'));
    await expect(unbind('detach', true)).rejects.toThrow('settings write failed');
    expect(await storage.getRemoteProjectBinding(projectId)).toMatchObject({ remoteId });
    expect(store.pending()).toEqual([]);
  });
});
