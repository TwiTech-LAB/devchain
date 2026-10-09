import { assertShareableFolder } from './file-sync-paths';
import { FolderSyncStatusSchema, SCAN_TIMEOUT_MS, type FolderSyncStatus } from './file-sync.dto';
import {
  FileSyncService,
  FileSyncTimeoutError,
  FileSyncUnavailableError,
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
  it('overrides a send-only folder through Syncthing', async () => {
    const request = jest.fn(async () => undefined);
    const service = new FileSyncService(
      { getConnection: () => ({ client: { request } }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.override('git:p1');
    expect(request).toHaveBeenCalledWith('POST', '/rest/db/override?folder=git%3Ap1');
  });

  it('reports the receive-only count and at most 200 changed names', async () => {
    const request = jest.fn(async (_method: string, path: string) =>
      path.startsWith('/rest/db/localchanged')
        ? { files: Array.from({ length: 201 }, (_, i) => ({ name: `file-${i}` })) }
        : status({ receiveOnlyChangedFiles: 300 }),
    );
    const service = new FileSyncService(
      { getConnection: () => ({ client: { request } }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const changes = await service.localChanges('code:p1');
    expect(changes.count).toBe(300);
    expect(changes.sample).toHaveLength(200);
    expect(changes.sample.at(-1)).toBe('file-199');
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/rest/db/localchanged?folder=code%3Ap1&page=1&perpage=200',
    );
  });

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
      undefined,
    );
    expect(SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('hands a cancel signal to the scan request so it can end early', async () => {
    const request = jest.fn(async () => undefined);
    const syncthing = { getConnection: () => ({ client: { request } }), getState: () => ({}) };
    const service = new FileSyncService(syncthing as never, {} as never, {} as never, {} as never);
    const controller = new AbortController();

    await service.rescan('code:p1', controller.signal);

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/rest/db/scan?folder=code%3Ap1',
      undefined,
      SCAN_TIMEOUT_MS,
      controller.signal,
    );
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

describe('FileSyncService.status', () => {
  const FILE_ERROR = { path: 'pkg/a.py', error: 'chmod pkg/a.py: operation not permitted' };

  it.each([false, true])('keeps a three-file sample unless allErrors=%s', async (allErrors) => {
    const errors = Array.from({ length: 5 }, (_, index) => ({
      ...FILE_ERROR,
      path: `logs/${index}`,
    }));
    const request = jest.fn(async (_method: string, path: string) =>
      path.startsWith('/rest/folder/errors') ? { errors } : { ...status(), errors: 5 },
    );
    const service = new FileSyncService(
      { getConnection: () => ({ client: { request } }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.status('code:p1', undefined, { allErrors });
    expect(result.fileErrors).toEqual(allErrors ? errors : errors.slice(0, 3));
    expect(request).toHaveBeenCalledWith(
      'GET',
      allErrors
        ? '/rest/folder/errors?folder=code%3Ap1'
        : '/rest/folder/errors?folder=code%3Ap1&page=1&perpage=3',
    );
  });

  it('rejects an unreadable full error list instead of reporting no failures', async () => {
    const service = new FileSyncService(
      {
        getConnection: () => ({
          client: {
            request: async (_method: string, path: string) => {
              if (path.startsWith('/rest/folder/errors')) throw new Error('errors unavailable');
              return { ...status(), errors: 5 };
            },
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.status('code:p1', undefined, { allErrors: true })).rejects.toThrow(
      'errors unavailable',
    );
  });

  it.each<[string, number, () => Promise<unknown>, (typeof FILE_ERROR)[] | undefined]>([
    ['reports no errors', 0, async () => ({ errors: [FILE_ERROR] }), undefined],
    ['reports errors', 1181, async () => ({ errors: [FILE_ERROR] }), [FILE_ERROR]],
    [
      'reports errors but cannot list them',
      1181,
      async () => {
        throw new Error('folder is paused');
      },
      undefined,
    ],
  ])('names the failed files only when Syncthing %s', async (_case, errors, list, expected) => {
    const request = jest.fn(async (_method: string, path: string) =>
      path.startsWith('/rest/folder/errors?folder=code%3Ap1')
        ? list()
        : { ...status(), folderId: undefined, peer: undefined, errors },
    );
    const syncthing = { getConnection: () => ({ client: { request } }), getState: () => ({}) };
    const service = new FileSyncService(syncthing as never, {} as never, {} as never, {} as never);

    const result = await service.status('code:p1');

    expect(result.errors).toBe(errors);
    expect(result.fileErrors).toEqual(expected);
  });
});

describe('FileSyncService.waitForComplete', () => {
  const service = new FileSyncService({} as never, {} as never, {} as never, {} as never);

  // Injected indexes and timers prove asynchronous Revert cannot finish the copy early.
  it('waits for receive-only changes to clear when the copy requires it', async () => {
    jest.useFakeTimers();
    try {
      let changes = 1;
      let finished = false;
      const copy = service
        .waitForComplete('code:p1', {
          sender: async () => status({ peer: PEER_DONE }),
          receiver: async () => status({ receiveOnlyChangedFiles: changes }),
          timeoutMs: 5_000,
          pollIntervalMs: 10,
          requireNoReceiveOnlyChanges: true,
        })
        .then((result) => {
          finished = true;
          return result;
        });
      await jest.advanceTimersByTimeAsync(10);
      expect(finished).toBe(false);
      changes = 0;
      await jest.advanceTimersByTimeAsync(10);
      expect(await copy).toEqual({ completion: 100, needItems: 0, needBytes: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

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

  it("times out with Syncthing's own errors and the side they happened on", async () => {
    const error: unknown = await service
      .waitForComplete('code:p1', {
        sender: async () =>
          status({ error: 'folder marker missing', peer: { ...PEER_DONE, completion: 52 } }),
        receiver: async () =>
          status({
            errors: 1181,
            fileErrors: [{ path: 'pkg/a.py', error: 'chmod pkg/a.py: operation not permitted' }],
          }),
        timeoutMs: 30,
        pollIntervalMs: 5,
        sides: { sender: 'this PC', receiver: 'the VM' },
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'FILE_SYNC_TIMEOUT',
      message:
        'Folder code:p1 did not finish syncing in time: 1181 files failed to sync on the VM. ' +
        'First: pkg/a.py: chmod pkg/a.py: operation not permitted; folder marker missing on this PC',
    });
  });

  it('ends at once with the signal reason and never polls when the signal is already aborted', async () => {
    const reason = new Error('The Connect was cancelled.');
    const controller = new AbortController();
    controller.abort(reason);
    const sender = jest.fn(async () => status({ peer: PEER_DONE }));

    const error: unknown = await service
      .waitForComplete('code:p1', {
        sender,
        receiver: async () => status(),
        timeoutMs: 5_000,
        pollIntervalMs: 1,
        signal: controller.signal,
      })
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(sender).not.toHaveBeenCalled();
  });

  it('ends an in-flight wait with the signal reason instead of the timeout, polling no further', async () => {
    const controller = new AbortController();
    const sender = jest.fn(async () => {
      controller.abort(new Error('The Connect was cancelled.'));
      return status({ peer: { ...PEER_DONE, completion: 10 } });
    });

    const error: unknown = await service
      .waitForComplete('code:p1', {
        sender,
        receiver: async () => status(),
        timeoutMs: 10 * 60_000,
        pollIntervalMs: 5,
        signal: controller.signal,
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ message: 'The Connect was cancelled.' });
    // One poll, then the abort ended the loop before the next one.
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['answers complete', PEER_DONE, 5_000],
    ['answers incomplete at the deadline', { ...PEER_DONE, completion: 10 }, 0],
  ])(
    'ends with the signal reason when the cancel arrives while the poll %s',
    async (_case, peer, timeoutMs) => {
      const reason = new Error('The Connect was cancelled.');
      const controller = new AbortController();

      const error: unknown = await service
        .waitForComplete('code:p1', {
          sender: async () => {
            controller.abort(reason);
            return status({ peer });
          },
          receiver: async () => status(),
          timeoutMs,
          pollIntervalMs: 1,
          signal: controller.signal,
        })
        .catch((e: unknown) => e);

      expect(error).toBe(reason);
    },
  );
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
    expect(result).toMatchObject({
      error: 'disk full',
      errors: 2,
      pullErrors: 99,
      peer: PEER_DONE,
    });
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
