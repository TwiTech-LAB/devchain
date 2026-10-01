import { assertShareableFolder } from './file-sync-paths';
import { FolderSyncStatusSchema, type FolderSyncStatus } from './file-sync.dto';
import {
  FileSyncService,
  FileSyncTimeoutError,
  FileSyncUnavailableError,
  SCAN_TIMEOUT_MS,
  codeFolderId,
  evaluateCompletion,
  evaluateSymmetricCompletion,
} from './file-sync.service';

// Pure unit: the completion rule, the wait loop and the HOME guard are
// decisions over plain values and injected status sources; no Syncthing needed.

function status(overrides: Partial<FolderSyncStatus> = {}): FolderSyncStatus {
  return {
    folderId: 'code:p1',
    state: 'idle',
    localFiles: 10,
    localDirectories: 3,
    globalFiles: 10,
    globalDirectories: 3,
    needTotalItems: 0,
    needBytes: 0,
    receiveOnlyChangedFiles: 0,
    peer: null,
    ...overrides,
  };
}

const PEER_DONE = {
  deviceId: 'HOSTAAA',
  completion: 100,
  needItems: 0,
  needBytes: 0,
  remoteState: 'valid',
};

describe('evaluateCompletion', () => {
  const sender = status({ peer: PEER_DONE });
  const receiver = status();

  it('is done only when every signal holds', () => {
    expect(evaluateCompletion(sender, receiver)).toEqual({
      done: true,
      progress: { completion: 100, needItems: 0, needBytes: 0 },
    });
  });

  it.each<[string, FolderSyncStatus, FolderSyncStatus]>([
    ['the sender has no view of the receiver', status(), receiver],
    ['completion is below 100', status({ peer: { ...PEER_DONE, completion: 99.5 } }), receiver],
    ['the receiver still needs items', status({ peer: { ...PEER_DONE, needItems: 2 } }), receiver],
    [
      'the receiver index is not valid',
      status({ peer: { ...PEER_DONE, remoteState: 'unknown' } }),
      receiver,
    ],
    ['the sender is scanning', status({ peer: PEER_DONE, state: 'scanning' }), receiver],
    ['the receiver is syncing', sender, status({ state: 'syncing' })],
    ['the receiver needs items itself', sender, status({ needTotalItems: 1 })],
    ['the receiver has not seen every file', sender, status({ globalFiles: 9 })],
    ['the receiver holds extra local files', sender, status({ localFiles: 11 })],
    ['the receiver has not seen every directory', sender, status({ globalDirectories: 2 })],
  ])('is not done when %s', (_case, senderStatus, receiverStatus) => {
    expect(evaluateCompletion(senderStatus, receiverStatus).done).toBe(false);
  });
});

describe('FileSyncService.rescan', () => {
  it('waits for the whole scan, because Syncthing answers only when it ends', async () => {
    const request = jest.fn(async () => undefined);
    const syncthing = { getConnection: () => ({ client: { request } }), getState: () => ({}) };
    const service = new FileSyncService(syncthing as never, {} as never, {} as never, {} as never);

    await service.rescan('code:p1');

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/rest/db/scan?folder=code%3Ap1',
      undefined,
      SCAN_TIMEOUT_MS,
    );
    expect(SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

describe('FileSyncService.ensureAvailable', () => {
  it('starts Syncthing again, so a binary installed after boot is used without a restart', async () => {
    let running = false;
    const syncthing = {
      ensureRunning: jest.fn(async () => {
        running = true;
      }),
      getConnection: () =>
        running ? { client: {}, deviceId: 'D', listenAddress: 'tcp://x' } : null,
      getState: () => ({}),
    };
    const service = new FileSyncService(syncthing as never, {} as never, {} as never, {} as never);

    await expect(service.ensureAvailable()).resolves.toBeUndefined();
    expect(syncthing.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('throws the install guidance when Syncthing still cannot run', async () => {
    const guidance =
      'Syncthing was not found on PATH or in ~/.devchain/bin. Install Syncthing v2 from https://syncthing.net/downloads/';
    const syncthing = {
      ensureRunning: jest.fn(async () => undefined),
      getConnection: () => null,
      getState: () => ({ error: guidance }),
    };
    const service = new FileSyncService(syncthing as never, {} as never, {} as never, {} as never);

    const error = await service.ensureAvailable().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileSyncUnavailableError);
    expect((error as Error).message).toBe(`File sync is unavailable: ${guidance}`);
  });
});

describe('FileSyncService.waitForComplete', () => {
  const service = new FileSyncService({} as never, {} as never, {} as never, {} as never);

  it('reports progress on every poll and returns once complete', async () => {
    const senders = [
      status({ peer: { ...PEER_DONE, completion: 40, needItems: 6, needBytes: 600 } }),
      status({ peer: { ...PEER_DONE, completion: 100 }, state: 'scanning' }),
      status({ peer: PEER_DONE }),
    ];
    const onProgress = jest.fn();

    const result = await service.waitForComplete('code:p1', {
      sender: async () => senders.shift() ?? status({ peer: PEER_DONE }),
      receiver: async () => status(),
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      onProgress,
    });

    expect(result).toEqual({ completion: 100, needItems: 0, needBytes: 0 });
    expect(onProgress.mock.calls.map(([p]) => p.completion)).toEqual([40, 100, 100]);
  });

  it('keeps polling through failed status reads', async () => {
    let calls = 0;
    const result = await service.waitForComplete('code:p1', {
      sender: async () => {
        calls += 1;
        if (calls < 3) throw new Error('host unreachable');
        return status({ peer: PEER_DONE });
      },
      receiver: async () => status(),
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });

    expect(result.completion).toBe(100);
    expect(calls).toBe(3);
  });

  it('times out with the last progress and error', async () => {
    let calls = 0;
    const error: unknown = await service
      .waitForComplete('code:p1', {
        sender: async () => {
          calls += 1;
          if (calls > 1) throw new Error('host unreachable');
          return status({ peer: { ...PEER_DONE, completion: 50, needItems: 5 } });
        },
        receiver: async () => status(),
        timeoutMs: 30,
        pollIntervalMs: 5,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileSyncTimeoutError);
    expect(error).toMatchObject({
      code: 'FILE_SYNC_TIMEOUT',
      message: 'Folder code:p1 did not finish syncing in time: host unreachable',
      details: {
        folderId: 'code:p1',
        progress: { completion: 50, needItems: 5, needBytes: 0 },
        lastError: 'host unreachable',
      },
    });
  });
});

describe('assertShareableFolder', () => {
  it('rejects HOME, its ancestors and relative paths', () => {
    for (const path of ['/home/dev', '/home/dev/', '/home', '/', 'repos/demo']) {
      expect(() => assertShareableFolder(path, '/home/dev')).toThrow(
        expect.objectContaining({ code: 'validation_error' }),
      );
    }
  });

  it('accepts folders inside or beside HOME', () => {
    for (const path of [
      '/home/dev/repos/demo',
      '/home/dev/.claude/projects/-x',
      '/srv/demo',
      '/home/devx',
    ]) {
      expect(() => assertShareableFolder(path, '/home/dev')).not.toThrow();
    }
  });
});

describe('folder ids', () => {
  it('follows code:<projectId>', () => {
    expect(codeFolderId('p1')).toBe('code:p1');
  });
});

describe('symmetric completion', () => {
  const done = status({ peer: PEER_DONE });
  it('requires both peers to agree and both local copies to be idle and complete', () => {
    expect(evaluateSymmetricCompletion(done, done).done).toBe(true);
    for (const pending of [
      status(),
      status({ peer: { ...PEER_DONE, completion: 99 } }),
      status({ peer: PEER_DONE, needTotalItems: 1 }),
      status({ peer: PEER_DONE, state: 'scanning' }),
    ]) {
      expect(evaluateSymmetricCompletion(done, pending).done).toBe(false);
      expect(evaluateSymmetricCompletion(pending, done).done).toBe(false);
    }
  });
});

// Unit tests verify the REST-to-domain projection without running a Syncthing daemon.
describe('FileSyncService health status projection', () => {
  const setup = () => {
    const request = jest.fn();
    const syncthing = { getConnection: () => ({ client: { request } }) };
    const files = new FileSyncService(syncthing as never, {} as never, {} as never, {} as never);
    return { request, files };
  };

  it('preserves both folder devices so callers can exclude the home device', async () => {
    const { request, files } = setup();
    const configuration = {
      type: 'sendreceive',
      paused: true,
      devices: [{ deviceID: 'home' }, { deviceID: 'vm' }],
    };
    request.mockResolvedValue({ ...configuration, unrelated: true });
    expect(await files.folderConfiguration('code:p1')).toEqual(configuration);
    expect(request).toHaveBeenCalledWith('GET', '/rest/config/folders/code%3Ap1');
  });

  it('reads error and errors and requests peer completion on the home REST client', async () => {
    const { request, files } = setup();
    request
      .mockResolvedValueOnce({ ...status(), error: 'disk full', errors: 2, pullErrors: 99 })
      .mockResolvedValueOnce(PEER_DONE);
    const result = await files.status('code:p1', 'HOSTAAA');
    expect(result).toMatchObject({ error: 'disk full', errors: 2, peer: PEER_DONE });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/rest/db/completion?folder=code%3Ap1&device=HOSTAAA',
    );
    expect(FolderSyncStatusSchema.parse(result)).toMatchObject({ error: 'disk full', errors: 2 });
  });

  it('accepts status from an older VM that has no error fields', () => {
    expect(FolderSyncStatusSchema.parse(status())).toEqual(status());
  });
});
