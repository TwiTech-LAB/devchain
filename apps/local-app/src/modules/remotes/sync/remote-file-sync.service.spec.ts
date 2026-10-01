import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { RemoteFileSyncService } from './remote-file-sync.service';

// Unit tests exercise lifecycle gates and retries; actual file survival uses real Syncthing below.
function setup() {
  const files = Object.assign(new FakeFileSyncService(), {
    folderPath: jest.fn(async () => '/checkout'),
  });
  const hostFiles = new FakeFileSyncService();
  files.gitProjects.add('p');
  const initial = {
    type: 'receiveonly' as const,
    paused: false,
    peerDeviceId: 'peer',
    ignores: [],
  };
  files.peers.add('peer');
  files.folders.set('code:p', initial);
  hostFiles.folders.set('code:p', { ...initial, type: 'sendonly' });
  const host = {
    syncDevice: jest.fn(async () => hostFiles.device()),
    syncPeer: jest.fn(async () => undefined),
    syncFolders: jest.fn((_: string, request: Parameters<typeof files.ensureFolder>[0]) =>
      hostFiles.ensureFolder(request),
    ),
    syncFolderType: jest.fn(
      (_: string, id: string, patch: Parameters<typeof files.updateFolder>[1]) =>
        hostFiles.updateFolder(id, patch),
    ),
    syncScan: jest.fn(async () => undefined),
    syncStatus: jest.fn((_: string, id: string, peer?: string) => hostFiles.status(id, peer)),
  };
  const binding = { state: 'remote', remoteId: 'r' };
  const health: { online: boolean; versionMatches: boolean; apiKeyRejected?: boolean } = {
    online: true,
    versionMatches: true,
  };
  const git = {
    mirroredHead: jest.fn(async () => 'head1'),
    refreshIndexFromHead: jest.fn(async () => undefined),
  };
  const guard = { install: jest.fn(async () => undefined) };
  const service = new RemoteFileSyncService(
    files as never,
    host as never,
    { get: async () => binding } as never,
    { getState: () => health } as never,
    { get: () => ['/managed'] } as never,
    git as never,
    guard as never,
  );
  const tick = (active = () => true) => service.tick('p', 'r', active);
  return { service, files, hostFiles, host, binding, health, git, guard, tick };
}

describe('remote file maintenance', () => {
  it('gates all work by ownership, health version, and the live lifecycle', async () => {
    const s = setup();
    for (const state of ['attaching', 'detaching', 'failed']) {
      s.binding.state = state;
      await s.tick();
    }
    s.binding.state = 'remote';
    s.health.versionMatches = false;
    await s.tick();
    s.health.versionMatches = true;
    s.health.apiKeyRejected = true;
    await s.tick();
    s.health.apiKeyRejected = false;
    await s.tick(() => false);
    expect(s.host.syncFolders).not.toHaveBeenCalled();
  });

  it('moves Git first, applies system ignores before user negations and changes host code first', async () => {
    const s = setup();
    s.files.setIgnores('p', ['!/.git', '!/managed']);
    await s.tick();
    expect(s.files.folders.get('git:p')).toMatchObject({
      type: 'receiveonly',
      ignores: ['*.lock', '/hooks', '/index'],
    });
    expect(s.hostFiles.folders.get('git:p')).toMatchObject({ type: 'sendonly' });
    for (const files of [s.files, s.hostFiles]) {
      expect(files.folders.get('code:p')).toMatchObject({
        type: 'sendreceive',
        ignores: ['/.git', '/managed', '!/.git', '!/managed'],
      });
    }
    expect(s.guard.install).toHaveBeenCalledWith('p', 'r');
    expect(s.git.refreshIndexFromHead).not.toHaveBeenCalled();
  });

  it('only reverts idle receive-only Git; index refresh runs once per mirrored HEAD', async () => {
    const s = setup();
    const revert = jest.spyOn(s.files, 'revertLocalChanges');
    await s.tick();
    await s.tick();
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(1);
    s.git.mirroredHead.mockResolvedValue('head2');
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
    const status = await s.files.status('git:p');
    const statusSpy = jest
      .spyOn(s.files, 'status')
      .mockResolvedValue({ ...status, receiveOnlyChangedFiles: 1, state: 'scanning' });
    await s.tick();
    expect(revert).not.toHaveBeenCalled();
    statusSpy.mockResolvedValue({ ...status, receiveOnlyChangedFiles: 1 });
    s.files.folders.get('git:p')!.type = 'sendreceive';
    await s.tick();
    expect(revert).not.toHaveBeenCalled();
    s.files.folders.get('git:p')!.type = 'receiveonly';
    await s.tick();
    expect(revert).toHaveBeenCalledWith('git:p');
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
  });

  it('keeps a guard skip warning visible after successful upkeep', async () => {
    const s = setup();
    s.guard.install.mockResolvedValue('Custom hooksPath: guard was skipped' as never);
    await s.tick();
    await s.tick();
    expect(s.service.warning('p')).toContain('guard was skipped');
  });

  it('retries an index refresh failure and ignores an unborn HEAD', async () => {
    const s = setup();
    await s.tick();
    s.git.refreshIndexFromHead.mockRejectedValueOnce(new Error('index locked'));
    await s.tick();
    expect(s.service.warning('p')).toContain('retry automatically');
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
    expect(s.service.warning('p')).toBeNull();
    s.git.mirroredHead.mockResolvedValue(null as never);
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
  });

  it('replays an interrupted migration after losing its in-memory progress', async () => {
    const s = setup();
    s.guard.install.mockRejectedValueOnce(new Error('busy'));
    await s.tick();
    s.service.forget('p');
    await s.tick();
    expect(s.guard.install).toHaveBeenCalledTimes(2);
    expect(s.files.folders.get('code:p')?.type).toBe('sendreceive');
    expect(s.service.warning('p')).toBeNull();
  });

  it.each(['create', 'ignores', 'directions', 'guard'])(
    'retries failed %s without reverting code',
    async (step) => {
      const s = setup();
      const revert = jest.spyOn(s.files, 'revertLocalChanges');
      if (step === 'create') s.host.syncFolders.mockRejectedValueOnce(new Error('offline'));
      else if (step === 'guard') s.guard.install.mockRejectedValueOnce(new Error('filesystem'));
      else {
        const update = s.host.syncFolderType.getMockImplementation()!;
        let failed = false;
        s.host.syncFolderType.mockImplementation(async (...args) => {
          if (
            !failed &&
            args[1] === 'code:p' &&
            (step === 'ignores' ? args[2].ignores : args[2].type)
          ) {
            failed = true;
            throw new Error('offline');
          }
          return update(...args);
        });
      }
      await s.tick();
      expect(s.service.warning('p')).toContain('retry automatically');
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      expect(s.files.folders.get('code:p')?.type).toBe('sendreceive');
      expect(s.guard.install).toHaveBeenCalledTimes(step === 'guard' ? 2 : 1);
      expect(revert).not.toHaveBeenCalledWith('code:p');
    },
  );

  it('does not switch code before Git settles, and stops before subsequent migration steps', async () => {
    const s = setup();
    const read = s.files.status.bind(s.files);
    jest
      .spyOn(s.files, 'status')
      .mockImplementation(async (...args) => ({ ...(await read(...args)), needTotalItems: 1 }));
    await s.tick();
    expect(s.files.folders.get('code:p')?.type).toBe('receiveonly');
    expect(s.service.warning('p')).toContain('settling');
    let active = true;
    s.files.status = async (...args) => {
      active = false;
      return read(...args);
    };
    await s.tick(() => active);
    expect(s.guard.install).not.toHaveBeenCalled();
  });
});

// Unit tests keep elapsed-time boundaries deterministic without waiting on network transfers.
describe('connected file sync checks', () => {
  const start = new Date(2026, 8, 28, 16, 15).getTime();
  beforeEach(() => jest.useFakeTimers().setSystemTime(start));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const at = (seconds: number) => jest.setSystemTime(start + seconds * 1000);
  const ready = async (hasGit = true) => {
    const s = setup();
    if (!hasGit) s.files.gitProjects.clear();
    await s.tick();
    return s;
  };

  it.each([true, false])(
    'debounces disconnection and clears at recovery (git: %s)',
    async (hasGit) => {
      const s = await ready(hasGit);
      const connected = jest.spyOn(s.files, 'isConnected').mockResolvedValue(false);
      await s.tick();
      at(90);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      at(120);
      await s.tick();
      expect(s.service.warning('p')).toContain('No file sync connection to the VM since 16:15');
      expect(connected).toHaveBeenCalledWith('peer');
      expect(connected).not.toHaveBeenCalledWith(s.files.deviceId);
      connected.mockResolvedValue(true);
      at(150);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      connected.mockResolvedValue(false);
      at(180);
      await s.tick();
      connected.mockResolvedValue(true);
      at(270);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      connected.mockResolvedValue(false);
      at(300);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
    },
  );

  it.each([
    ['paused', {}, true, 'folder is paused'],
    ['state', { state: 'error' }, false, 'folder is in an error state'],
    ['message', { error: 'permission denied' }, false, 'permission denied'],
    ['count', { errors: 3 }, false, '3 files failed'],
  ] as const)(
    'debounces a folder %s problem using the check clock',
    async (_name, patch, paused, text) => {
      const s = await ready();
      const read = s.files.status.bind(s.files);
      const status = jest.spyOn(s.files, 'status').mockImplementation(async (...args) => ({
        ...(await read(...args)),
        ...(args[0] === 'git:p' ? { ...patch, ...(paused ? { state: '' } : {}) } : {}),
      }));
      s.files.folders.get('git:p')!.paused = paused;
      await s.tick();
      at(90);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      at(120);
      await s.tick();
      expect(s.service.warning('p')).toBe(`File sync at home has an error since 16:15: ${text}.`);
      status.mockRestore();
      s.files.folders.get('git:p')!.paused = false;
      at(150);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
    },
  );

  it.each(['code:p', 'git:p', 'peer'])('detects and clears stalled %s items', async (side) => {
    const s = await ready();
    let count = 12;
    const read = s.files.status.bind(s.files);
    jest.spyOn(s.files, 'status').mockImplementation(async (...args) => {
      const status = await read(...args);
      if (side === 'peer' && status.peer) status.peer.needItems = count;
      else if (args[0] === side) status.needTotalItems = count;
      return status;
    });
    await s.tick();
    at(570);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    at(600);
    await s.tick();
    expect(s.service.warning('p')).toContain(
      side === 'peer' ? 'The VM has not received 12' : 'This PC has not received 12',
    );
    expect(s.service.warning('p')).toContain('since 16:15');
    count = 11;
    at(630);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    count = 13;
    at(1200);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    at(1230);
    await s.tick();
    expect(s.service.warning('p')).toContain('13 pending');
    count = 0;
    at(1260);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    count = 1;
    at(1290);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
  });

  it.each([true, false])(
    'retains a failed-check warning until successful retry (git: %s)',
    async (hasGit) => {
      const s = await ready(hasGit);
      const check = jest
        .spyOn(s.files, 'isConnected')
        .mockRejectedValueOnce(new Error('unavailable'));
      await s.tick();
      expect(s.service.warning('p')).toContain('could not read the file sync status');
      at(5);
      await s.tick();
      expect(s.service.warning('p')).toContain('could not read the file sync status');
      expect(check).toHaveBeenCalledTimes(1);
      at(30);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      expect(check).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps upkeep and guard warnings independent, with check warnings first', async () => {
    const s = setup();
    s.guard.install.mockResolvedValue('guard skipped' as never);
    await s.tick();
    s.git.mirroredHead.mockRejectedValue(new Error('locked'));
    const check = jest
      .spyOn(s.files, 'isConnected')
      .mockRejectedValueOnce(new Error('unavailable'));
    await s.tick();
    expect(s.service.warning('p')).toContain('could not read');
    s.files.folders.get('git:p')!.paused = true;
    at(30);
    await s.tick();
    expect(check).toHaveBeenCalledTimes(2);
    expect(s.service.warning('p')).toContain('could not finish updating');
    s.files.folders.get('git:p')!.paused = false;
    s.git.mirroredHead.mockResolvedValue('head');
    at(60);
    await s.tick();
    expect(s.service.warning('p')).toBe('guard skipped');
  });

  it('throttles checks, gates offline/version mismatch, and resets on forget', async () => {
    const s = setup();
    const check = jest.spyOn(s.files, 'isConnected');
    await s.tick();
    expect(check).not.toHaveBeenCalled();
    await s.tick();
    at(29);
    await s.tick();
    expect(check).toHaveBeenCalledTimes(1);
    at(30);
    await s.tick();
    expect(check).toHaveBeenCalledTimes(2);
    at(60);
    s.health.online = false;
    await s.tick();
    s.health.online = true;
    s.health.versionMatches = false;
    await s.tick();
    s.health.versionMatches = true;
    await s.tick(() => false);
    expect(check).toHaveBeenCalledTimes(2);
    s.service.forget('p');
    await s.tick();
    await s.tick();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('keeps each project timer and warning independent', async () => {
    const s = await ready(false);
    s.files.folders.set('code:other', {
      ...s.files.folders.get('code:p')!,
      peerDeviceId: 'other-peer',
    });
    s.hostFiles.folders.set('code:other', { ...s.files.folders.get('code:other')! });
    s.files.peers.add('other-peer');
    const otherTick = () => s.service.tick('other', 'r', () => true);
    await otherTick();
    s.files.peers.delete('peer');
    const check = jest.spyOn(s.files, 'isConnected');
    await s.tick();
    await otherTick();
    expect(check).toHaveBeenCalledTimes(2);
    at(120);
    await s.tick();
    await otherTick();
    expect(s.service.warning('p')).toContain('No file sync connection');
    expect(s.service.warning('other')).toBeNull();
  });

  it('discards a completed check when the live lifecycle stopped during the read', async () => {
    const s = await ready(false);
    let active = true;
    jest.spyOn(s.files, 'status').mockImplementationOnce(async () => {
      active = false;
      throw new Error('read interrupted');
    });
    await s.tick(() => active);
    expect(s.service.warning('p')).toBeNull();
  });
});
