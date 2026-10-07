import type { FolderSyncStatus } from '../../file-sync/file-sync.dto';
import { Test } from '@nestjs/testing';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { GitService } from '../../git/services/git.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteFileSyncService } from './remote-file-sync.service';
import { GitOwnerStore } from '../git-owner.store';
import { FileSyncAutoFixStore } from '../../file-sync/file-sync-auto-fix.store';
import { FileSyncFailuresService } from './file-sync-failures.service';

// Service units isolate complete raw lists and eligibility gates without network transfers.
async function setup() {
  const fake = new FakeFileSyncService();
  await fake.ensureFolder({
    projectId: 'p',
    kind: 'code',
    type: 'sendreceive',
    peerDeviceId: 'VM',
    ignores: [],
  });
  const baseline = await fake.status('code:p');
  const home: FolderSyncStatus = {
    ...baseline,
    needTotalItems: 3,
    peer: { deviceId: 'VM', remoteState: 'idle', completion: 50, needItems: 5, needBytes: 10 },
  };
  const files = {
    status: jest.fn(async (_id: string) => home),
    isConnected: jest.fn(async () => true),
  };
  const host = {
    syncDevice: jest.fn(async () => ({ deviceId: 'VM' })),
    syncStatus: jest.fn(async (_remote: string, _id: string) => baseline),
  };
  const health = { online: true, versionMatches: true, apiKeyRejected: false };
  const storage = { listRemoteOperations: jest.fn(async () => [] as { id: string }[]) };
  const module = await Test.createTestingModule({
    providers: [
      RemoteFileSyncService,
      { provide: GitOwnerStore, useValue: { get: () => 'vm' } },
      { provide: FileSyncAutoFixStore, useValue: {} },
      { provide: FileSyncFailuresService, useValue: {} },
      { provide: FileSyncService, useValue: files },
      { provide: RemoteHostClient, useValue: host },
      {
        provide: RemoteBindingsService,
        useValue: { get: async () => ({ state: 'remote', remoteId: 'r' }) },
      },
      { provide: REMOTE_HEALTH_PORT, useValue: { getState: () => health } },
      { provide: FileSyncManagedExclusionsStore, useValue: {} },
      { provide: GitService, useValue: {} },
      { provide: HomeGitGuardService, useValue: {} },
      { provide: STORAGE_SERVICE, useValue: storage },
    ],
  }).compile();
  const service = module.get(RemoteFileSyncService);
  const problem = jest.spyOn(service, 'problem').mockReturnValue('error');
  return { service, problem, files, host, health, storage, baseline, home };
}

describe('Force sync offer', () => {
  it.each(['error', 'stalled', 'setup'] as const)(
    'offers %s with directional pending counts',
    async (kind) => {
      const s = await setup();
      s.problem.mockReturnValue(kind);
      await expect(s.service.forceSyncOffer('p')).resolves.toEqual({
        offered: true,
        reason: null,
        pending: { fromVm: 3, fromHome: 5 },
      });
      expect(s.files.status).toHaveBeenCalledWith('code:p', 'VM', { allErrors: true });
      expect(s.files.status).toHaveBeenCalledWith('git:p', undefined, { allErrors: true });
      for (const id of ['code:p', 'git:p'])
        expect(s.host.syncStatus).toHaveBeenCalledWith('r', id, undefined, { allErrors: true });
    },
  );

  it.each(['home-code', 'home-git', 'vm-code', 'vm-git'])(
    'refuses a permission error behind another error on the same path in %s',
    async (side) => {
      const s = await setup();
      const status = {
        ...s.baseline,
        fileErrors: [
          { path: 'a', error: 'disk full' },
          { path: 'a', error: 'chmod: Operation not permitted' },
        ],
      };
      if (side.startsWith('home'))
        s.files.status.mockImplementation(async (id: string) =>
          id === `${side.endsWith('git') ? 'git' : 'code'}:p` ? status : s.home,
        );
      else
        s.host.syncStatus.mockImplementation(async (_remote: string, id: string) =>
          id === `${side.endsWith('git') ? 'git' : 'code'}:p` ? status : s.baseline,
        );
      const result = await s.service.forceSyncOffer('p');
      expect(result).toMatchObject({
        offered: false,
        reason: 'Repair file permissions before using Force sync.',
      });
    },
  );

  it.each(['home', 'vm'] as const)(
    'fails closed for unreadable %s status and preserves readable counts',
    async (side) => {
      const s = await setup();
      if (side === 'home') s.files.status.mockRejectedValue(new Error('down'));
      else s.host.syncStatus.mockRejectedValue(new Error('down'));
      expect(await s.service.forceSyncOffer('p')).toEqual({
        offered: false,
        reason: `DevChain could not read ${side === 'home' ? "this PC's" : "the VM's"} file sync status.`,
        pending: side === 'home' ? { fromVm: null, fromHome: null } : { fromVm: 3, fromHome: 5 },
      });
    },
  );

  it.each(['home', 'vm'] as const)(
    'treats a missing %s share as readable and repairable',
    async (side) => {
      const s = await setup();
      if (side === 'home')
        s.files.status.mockRejectedValue(
          new SyncthingRestError('folder not shared', { path: '/rest/db/status', status: 404 }),
        );
      else
        s.host.syncStatus.mockRejectedValue(
          new RemoteHostRequestError('folder not shared', {
            remoteId: 'r',
            path: '/api/host/sync/status',
            status: 404,
            hostCode: 'not_found',
          }),
        );
      expect(await s.service.forceSyncOffer('p')).toMatchObject({ offered: true, reason: null });
    },
  );

  it.each(['offline', 'key', 'version', 'disconnected', 'operation'] as const)(
    'refuses %s with a reason',
    async (gate) => {
      const s = await setup();
      if (gate === 'offline') s.health.online = false;
      if (gate === 'key') s.health.apiKeyRejected = true;
      if (gate === 'version') s.health.versionMatches = false;
      if (gate === 'disconnected') s.files.isConnected.mockResolvedValue(false);
      if (gate === 'operation') s.storage.listRemoteOperations.mockResolvedValue([{ id: 'op' }]);
      expect(await s.service.forceSyncOffer('p')).toMatchObject({
        offered: false,
        reason: expect.any(String),
      });
    },
  );

  it('excludes only the caller operation', async () => {
    const s = await setup();
    s.storage.listRemoteOperations.mockResolvedValue([{ id: 'op' }]);
    expect(await s.service.forceSyncOffer('p', 'op')).toMatchObject({ offered: true });
    s.storage.listRemoteOperations.mockResolvedValue([{ id: 'op' }, { id: 'other' }]);
    expect(await s.service.forceSyncOffer('p', 'op')).toMatchObject({ offered: false });
  });

  it.each([null, 'connection', 'failed-files'] as const)(
    'requires a persistent file error for problem %s',
    async (problem) => {
      const s = await setup();
      s.problem.mockReturnValue(problem);
      s.host.syncStatus.mockResolvedValue({
        ...s.baseline,
        fileErrors: [{ path: 'a', error: 'file modified but not rescanned; will try again later' }],
      });
      expect(await s.service.forceSyncOffer('p')).toMatchObject({ offered: false });
      s.host.syncStatus.mockResolvedValue({
        ...s.baseline,
        fileErrors: [{ path: 'a', error: 'disk full' }],
      });
      expect(await s.service.forceSyncOffer('p')).toMatchObject({ offered: true });
    },
  );
});
