import { Test } from '@nestjs/testing';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { FileSyncAutoFixStore } from '../../file-sync/file-sync-auto-fix.store';
import { FileSyncIgnoresStore } from '../../file-sync/file-sync-ignores.store';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { GitService } from '../../git/services/git.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { GitOwnerStore } from '../git-owner.store';
import {
  connectExclusions,
  DockerImportInventoryStore,
  type DockerImportInventory,
} from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { FileSyncFailuresService } from './file-sync-failures.service';
import { FileSyncSuggestionsService } from './file-sync-suggestions.service';
import { ManagedExclusionsCheckService } from './managed-exclusions-check.service';
import { ManagedExclusionsRemovalStore } from './managed-exclusions-removal.store';
import type { ManagedExclusionRow } from './remote-file-sync.dto';
import { RemoteFileSyncService } from './remote-file-sync.service';

const root = '/checkout';
const project = 'p';
const remote = 'vm';
const code = 'code:p';
const patterns = ['/tmp', '/tmp/db', '/tmp-other'];
const userPatterns = ['!/tmp/cache', '/user'];
const passed: ManagedExclusionRow[] = [{ pattern: '/tmp', status: 'will-remove', containers: [] }];
const importedAt = '2026-10-10T00:00:00.000Z';
const records: DockerImportInventory = {
  importedAt,
  items: [
    {
      name: 'db',
      imageId: 'image',
      sizeBytes: null,
      volumes: [],
      bindPaths: ['/tmp', '/tmp/db'],
      dataRepresentations: [
        { volumes: [], bindPaths: [root + '/tmp/files'] },
        { volumes: ['vol'], bindPaths: [root + '/tmp'] },
      ],
    },
  ],
  groups: [
    { volumes: [], bindPaths: [root + '/tmp/db'], homeDiscardedAt: importedAt },
    { volumes: ['vol'], bindPaths: [root + '/tmp'], vmDiscardedAt: importedAt },
    { volumes: [], bindPaths: [root + '/tmp-other'], vmDiscardedAt: importedAt },
  ],
};

describe('live sync Docker exclusion removal', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let managed: FileSyncManagedExclusionsStore;
  let inventory: DockerImportInventoryStore;
  let history: FileSyncAutoFixStore;
  let user: FileSyncIgnoresStore;
  let home: FakeFileSyncService;
  let vm: FakeFileSyncService;
  let service: RemoteFileSyncService;
  let active: boolean;
  let held: boolean;
  const binding = { state: 'remote', remoteId: remote };
  const getBinding = jest.fn(async () => ({ ...binding }));
  const evaluate = jest.fn<
    ReturnType<ManagedExclusionsCheckService['evaluate']>,
    Parameters<ManagedExclusionsCheckService['evaluate']>
  >();
  const pushes: string[] = [];
  const signal = new AbortController().signal;
  const tick = () => service.tick(project, remote, () => active, signal);
  const changeCount = () => database.sqlite.prepare('SELECT total_changes() AS count').get();

  beforeEach(async () => {
    database = createTestDatabase();
    home = new FakeFileSyncService();
    vm = new FakeFileSyncService();
    user = new FileSyncIgnoresStore(database.db);
    user.set(project, userPatterns);
    Object.assign(home, {
      getIgnores: user.get.bind(user),
      getIgnoresRevision: user.revision.bind(user),
      setIgnores: user.set.bind(user),
    });
    home.codeRoots.set(project, root);
    home.folders.set(code, {
      type: 'receiveonly',
      ignores: [],
      paused: false,
      peerDeviceId: vm.deviceId,
    });
    vm.folders.set(code, {
      type: 'sendonly',
      ignores: [],
      paused: false,
      peerDeviceId: home.deviceId,
    });
    const update = home.updateFolder.bind(home);
    jest.spyOn(home, 'updateFolder').mockImplementation(async (id, patch) => {
      if (patch.ignores) pushes.push('home');
      return update(id, patch);
    });
    active = true;
    held = false;
    Object.assign(binding, { state: 'remote', remoteId: remote });
    evaluate.mockReset().mockResolvedValue(passed);
    const module = await Test.createTestingModule({
      providers: [
        RemoteFileSyncService,
        ManagedExclusionsRemovalStore,
        FileSyncAutoFixStore,
        FileSyncManagedExclusionsStore,
        DockerImportInventoryStore,
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: FileSyncService, useValue: home },
        {
          provide: RemoteHostClient,
          useValue: {
            syncFolderType: (
              _remote: string,
              id: string,
              patch: Parameters<typeof vm.updateFolder>[1],
            ) => {
              if (patch.ignores) pushes.push('vm');
              return vm.updateFolder(id, patch);
            },
            syncStatus: (_remote: string, id: string) => vm.status(id),
          },
        },
        { provide: RemoteBindingsService, useValue: { get: getBinding } },
        {
          provide: REMOTE_HEALTH_PORT,
          useValue: { getState: () => ({ online: true, versionMatches: true }) },
        },
        {
          provide: STORAGE_SERVICE,
          useValue: {
            listRemoteOperations: async () =>
              held ? [{ kind: 'force_sync', state: 'running' }] : [],
          },
        },
        { provide: GitOwnerStore, useValue: { get: () => 'vm', fence: () => ({}) } },
        { provide: ManagedExclusionsCheckService, useValue: { evaluate } },
        { provide: FileSyncSuggestionsService, useValue: {} },
        { provide: FileSyncFailuresService, useValue: {} },
        { provide: GitService, useValue: {} },
        { provide: HomeGitGuardService, useValue: {} },
      ],
    }).compile();
    service = module.get(RemoteFileSyncService);
    managed = module.get(FileSyncManagedExclusionsStore);
    inventory = module.get(DockerImportInventoryStore);
    history = module.get(FileSyncAutoFixStore);
    history.setEnabled(project, false);
    managed.set(project, patterns);
    inventory.set(project, remote, records);
    inventory.set(project, 'other', records);
    await tick();
    expect(evaluate).not.toHaveBeenCalled();
    expect(home.folders.get(code)?.type).toBe('sendreceive');
    expect(vm.folders.get(code)?.type).toBe('sendreceive');
    pushes.length = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    database.sqlite.close();
  });

  it('clears only the passed subtrees, records the action and installs the committed list once', async () => {
    await tick();
    expect(managed.get(project)).toEqual(['/tmp-other']);
    const saved = inventory.get(project, remote);
    expect(saved).toEqual({
      importedAt,
      items: [
        {
          ...records.items[0],
          bindPaths: [],
          dataRepresentations: [{ volumes: ['vol'], bindPaths: [] }],
        },
      ],
      groups: [{ ...records.groups![1], bindPaths: [] }, records.groups![2]],
    });
    expect(connectExclusions({ managedExclusions: [], codePaths: [] }, saved, root)).toEqual([
      '/tmp-other',
    ]);
    expect(inventory.get(project, 'other')).toEqual(records);
    expect(history.get(project)).toEqual({
      enabled: false,
      actions: [
        { at: expect.any(String), kind: 'docker-exclusion-removed', patterns: ['/tmp', '/tmp/db'] },
      ],
    });
    expect(service.getIgnores(project)).toEqual({ ignores: userPatterns, revision: 1 });
    expect(pushes).toEqual(['vm', 'home']);
    for (const side of [home, vm])
      expect((await side.installedIgnores(code)).ignore).toEqual([
        '/.git',
        '/tmp-other',
        ...userPatterns,
      ]);
    await tick();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(project, remote, signal);
    expect(pushes).toEqual(['vm', 'home']);
  });

  it('leaves retained rows untouched until the next project state', async () => {
    evaluate.mockResolvedValue([
      {
        pattern: '/tmp',
        containers: [],
        status: 'stays',
        reason: { kind: 'unchecked', cause: 'offline' },
      },
    ]);
    const before = changeCount();
    await tick();
    await tick();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(changeCount()).toEqual(before);
    expect(pushes).toEqual([]);
    service.forget(project);
    await tick();
    await tick();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it.each(['stopped', 'forgotten state', 'detaching', 'different remote', 'open hold'])(
    'aborts the write after evaluation for %s',
    async (reason) => {
      const folderCheck = jest.spyOn(home, 'projectFolders');
      evaluate.mockImplementationOnce(async () => {
        getBinding.mockImplementationOnce(async () => {
          if (reason === 'stopped') active = false;
          if (reason === 'forgotten state') service.forget(project);
          if (reason === 'detaching') binding.state = 'detaching';
          if (reason === 'different remote') binding.remoteId = 'other';
          return { ...binding };
        });
        held = reason === 'open hold';
        return passed;
      });
      const before = changeCount();
      await tick();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(changeCount()).toEqual(before);
      expect(pushes).toEqual([]);
      expect(folderCheck).not.toHaveBeenCalled();
      if (reason === 'forgotten state') return;
      active = true;
      held = false;
      Object.assign(binding, { state: 'remote', remoteId: remote });
      await tick();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(changeCount()).toEqual(before);
      expect(pushes).toEqual([]);
    },
  );

  it('leaves an inventory removed by VM reset absent at commit', async () => {
    evaluate.mockImplementationOnce(async () => {
      inventory.delete(project, remote);
      return passed;
    });
    await tick();
    expect(inventory.get(project, remote)).toBeNull();
    expect(managed.get(project)).toEqual(['/tmp-other']);
    expect(pushes).toEqual(['vm', 'home']);
  });

  // Real SQLite rollback and the public tick expose a consumed attempt that mocks miss.
  it('rolls back a failed removal and retries with fresh checks in the same state', async () => {
    database.sqlite.exec(`CREATE TRIGGER reject_action BEFORE INSERT ON settings
      WHEN NEW.key = 'fileSync.autoFix' BEGIN SELECT RAISE(ABORT, 'cannot record action'); END`);
    await tick();
    expect(managed.get(project)).toEqual(patterns);
    expect(inventory.get(project, remote)).toEqual(records);
    expect(history.get(project).actions).toEqual([]);
    expect(pushes).toEqual([]);

    database.sqlite.exec('DROP TRIGGER reject_action');
    evaluate.mockResolvedValue([{ pattern: '/tmp-other', status: 'will-remove', containers: [] }]);
    await tick();
    await tick();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(managed.get(project)).toEqual(['/tmp', '/tmp/db']);
    expect(inventory.get(project, remote)).toEqual({
      ...records,
      groups: records.groups!.slice(0, 2),
    });
    expect(inventory.get(project, 'other')).toEqual(records);
    expect(history.get(project).actions).toEqual([
      { at: expect.any(String), kind: 'docker-exclusion-removed', patterns: ['/tmp-other'] },
    ]);
    expect(service.getIgnores(project)).toEqual({ ignores: userPatterns, revision: 1 });
    expect(pushes).toEqual(['vm', 'home']);
    for (const side of [home, vm])
      expect((await side.installedIgnores(code)).ignore).toEqual([
        '/.git',
        '/tmp',
        '/tmp/db',
        ...userPatterns,
      ]);
  });

  it('retries a failed peer apply from committed settings without another evaluation or action', async () => {
    jest.spyOn(vm, 'updateFolder').mockRejectedValueOnce(new Error('VM unavailable'));
    await tick();
    expect(managed.get(project)).toEqual(['/tmp-other']);
    expect(history.get(project).actions).toHaveLength(1);
    expect(pushes).toEqual(['vm']);
    await tick();
    await tick();
    expect(pushes).toEqual(['vm', 'vm', 'home']);
    for (const side of [home, vm])
      expect((await side.installedIgnores(code)).ignore).toEqual([
        '/.git',
        '/tmp-other',
        ...userPatterns,
      ]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(history.get(project).actions).toHaveLength(1);
  });
});
