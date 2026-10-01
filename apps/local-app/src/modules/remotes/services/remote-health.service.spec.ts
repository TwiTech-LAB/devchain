import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { homedir } from 'node:os';
import { RemoteHealthService } from './remote-health.service';
import type { RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RealtimeBroadcaster } from '../../realtime/ports/realtime-broadcaster.port';
import type { Remote } from '../../storage/models/domain.models';
import { resetEnvConfig } from '../../../common/config/env.config';
import { fixtureTls } from '../../../common/test/tls-fixture';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../transport/remote-tls', () => ({
  ...jest.requireActual('../transport/remote-tls'),
  remoteFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

jest.mock('../../../common/app-version', () => ({
  getAppVersion: jest.fn(() => '1.2.3'),
}));

function makeRemote(overrides: Partial<Remote> = {}): Remote {
  return {
    id: 'remote-1',
    name: 'home-nas',
    baseUrl: 'https://10.0.0.1',
    kind: 'address',
    vmProviderConnectionId: null,
    vmIdentity: null,
    vmSpec: null,
    tlsCertificate: fixtureTls.cert,
    tlsFingerprint: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const HOST_STATS = {
  cpuPercent: 5,
  load1: 0.1,
  load5: 0.2,
  memTotalBytes: 1000,
  memUsedBytes: 200,
  diskTotalBytes: 2000,
  diskUsedBytes: 400,
  uptimeSec: 120,
  sampledAt: '2024-01-01T00:00:00.000Z',
};

describe('RemoteHealthService', () => {
  let storage: { listRemotes: jest.Mock; getRemote: jest.Mock };
  let broadcaster: { broadcastEvent: jest.Mock };
  let familyWriteback: { pullIfChanged: jest.Mock };
  let skillSettings: { createPollCycle: jest.Mock; pushIfChanged: jest.Mock; prune: jest.Mock };
  let vmProviders: { forRemote: jest.Mock };
  let fetchMock: jest.Mock;
  let service: RemoteHealthService;
  let apiKeys: RemoteApiKeyService;
  let cliSettings: { pushIfChanged: jest.Mock; checkNow: jest.Mock };
  let cliVersions: { registerRemoteCheck: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.REMOTES_HEALTH_INTERVAL_MS = '10000';
    resetEnvConfig();

    storage = {
      listRemotes: jest.fn().mockResolvedValue({ items: [makeRemote()] }),
      getRemote: jest.fn().mockResolvedValue(makeRemote()),
    };
    broadcaster = { broadcastEvent: jest.fn() };
    familyWriteback = { pullIfChanged: jest.fn().mockResolvedValue(undefined) };
    vmProviders = { forRemote: jest.fn() };
    skillSettings = {
      createPollCycle: jest.fn(() => jest.fn()),
      pushIfChanged: jest.fn().mockResolvedValue(undefined),
      prune: jest.fn(),
    };
    cliSettings = {
      pushIfChanged: jest.fn().mockResolvedValue(undefined),
      checkNow: jest.fn().mockResolvedValue(undefined),
    };
    cliVersions = { registerRemoteCheck: jest.fn().mockReturnValue(jest.fn()) };
    let key = 'first';
    apiKeys = new RemoteApiKeyService({
      readRemoteApiKey: async () => key,
      saveRemoteApiKey: async (_id: string, value: string) => {
        key = value;
      },
    } as never);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new RemoteHealthService(
      storage as unknown as RemoteStorage,
      broadcaster as unknown as RealtimeBroadcaster,
      familyWriteback as never,
      vmProviders as never,
      skillSettings as never,
      cliSettings as never,
      cliVersions as never,
      apiKeys,
    );
  });

  it('keeps runtime/version online on key rejection, skips side effects and clears on acceptance', async () => {
    let rejected = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/runtime')) return jsonResponse({ version: '1.2.3' });
      return rejected
        ? { ok: false, status: 401, json: async () => ({ code: 'HOST_API_KEY_REJECTED' }) }
        : jsonResponse(HOST_STATS);
    });
    await service.refresh('remote-1');
    await service.refresh('remote-1');
    expect(service.getState('remote-1')).toMatchObject({
      online: true,
      apiKeyRejected: true,
      version: '1.2.3',
      versionMatches: true,
      stats: null,
    });
    expect(familyWriteback.pullIfChanged).not.toHaveBeenCalled();
    expect(skillSettings.pushIfChanged).not.toHaveBeenCalled();
    expect(cliSettings.pushIfChanged).not.toHaveBeenCalled();
    rejected = false;
    await service.refresh('remote-1');
    expect(service.getState('remote-1')).toMatchObject({ online: true, apiKeyRejected: false });
    expect(familyWriteback.pullIfChanged).toHaveBeenCalled();
  });

  it('does not count rejected polls toward the offline threshold', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/api/runtime')
        ? jsonResponse({ version: '1.2.3' })
        : { ok: false, status: 401, json: async () => ({ code: 'HOST_API_KEY_REJECTED' }) },
    );
    await service.refresh('remote-1');
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1);
    fetchMock.mockRejectedValue(new Error('unreachable'));
    await tick();
    expect(service.getState('remote-1').online).toBe(true);
    await tick();
    expect(service.getState('remote-1').online).toBe(false);
  });

  it('invalidates an in-flight accepted poll when a rotation save fails', async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/api/runtime')
        ? Promise.resolve(jsonResponse({ version: '1.2.3' }))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    const pending = service.refresh('remote-1');
    await jest.advanceTimersByTimeAsync(1);
    service.rejectApiKey('remote-1');
    release(jsonResponse(HOST_STATS));
    await pending;
    expect(service.getState('remote-1').apiKeyRejected).toBe(true);
    expect(familyWriteback.pullIfChanged).not.toHaveBeenCalled();
  });

  it('keeps a refresh answer when a timer poll comes due while it runs', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async (url: string) => {
      await held;
      return jsonResponse(url.endsWith('/api/runtime') ? { version: '1.2.3' } : HOST_STATS);
    });
    const pending = service.refresh('remote-1');
    await jest.advanceTimersByTimeAsync(1);
    const refreshCalls = fetchMock.mock.calls.length;
    // A timer poll that ran now would supersede the refresh and, failing, report offline.
    fetchMock.mockRejectedValue(new Error('unreachable'));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls.length).toBe(refreshCalls);
    release();
    await expect(pending).resolves.toMatchObject({ online: true, version: '1.2.3' });
  });

  it('runs overlapping refreshes one after another, each returning a polled answer', async () => {
    let release!: () => void;
    let held: Promise<void> | null = new Promise<void>((resolve) => (release = resolve));
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (held) await held;
        return jsonResponse(url.endsWith('/api/runtime') ? { version: '1.2.3' } : HOST_STATS);
      } finally {
        inFlight -= 1;
      }
    });
    const first = service.refresh('remote-1');
    const second = service.refresh('remote-1');
    await jest.advanceTimersByTimeAsync(1);
    // Only the first refresh's runtime and stats requests are open.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    held = null;
    release();
    await expect(first).resolves.toMatchObject({ online: true });
    await expect(second).resolves.toMatchObject({ online: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(2);
  });

  // Unit transport assertions detect missing headers even when loopback peers allow anonymous calls.
  it('uses a saved replacement key on the next request', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(url.endsWith('/api/runtime') ? { version: '1.2.3' } : HOST_STATS),
    );
    await service.refresh('remote-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://10.0.0.1/api/host/stats',
      expect.objectContaining({ headers: { authorization: 'Bearer first' } }),
    );
    await apiKeys.save('remote-1', 'second');
    fetchMock.mockClear();
    await service.refresh('remote-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://10.0.0.1/api/host/stats',
      expect.objectContaining({ headers: { authorization: 'Bearer second' } }),
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    delete process.env.REMOTES_HEALTH_INTERVAL_MS;
    resetEnvConfig();
    jest.clearAllMocks();
  });

  async function tick(): Promise<void> {
    await jest.advanceTimersByTimeAsync(10000);
  }

  it('starts skill work after write-back without waiting, and shares one cycle across remotes', async () => {
    storage.listRemotes.mockResolvedValue({
      items: [makeRemote(), makeRemote({ id: 'remote-2' })],
    });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse(url.endsWith('/api/runtime') ? { version: '1.2.3' } : HOST_STATS),
      ),
    );
    skillSettings.pushIfChanged.mockImplementation(() => new Promise(() => undefined));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(skillSettings.createPollCycle).toHaveBeenCalledTimes(1);
    expect(skillSettings.pushIfChanged).toHaveBeenCalledTimes(2);
    expect(skillSettings.pushIfChanged.mock.calls[0][1]).toBe(
      skillSettings.pushIfChanged.mock.calls[1][1],
    );
    expect(familyWriteback.pullIfChanged.mock.invocationCallOrder[0]).toBeLessThan(
      skillSettings.pushIfChanged.mock.invocationCallOrder[0],
    );
    await tick();
    expect(skillSettings.pushIfChanged).toHaveBeenCalledTimes(4);
    expect(service.getState('remote-1').online).toBe(true);
  });

  it('pushes and checks CLI policy only for online version-matched VMs', async () => {
    storage.listRemotes.mockResolvedValue({
      items: [
        makeRemote(),
        makeRemote({ id: 'old', baseUrl: 'https://old' }),
        makeRemote({ id: 'offline', baseUrl: 'https://offline' }),
      ],
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://offline')) throw new Error('offline');
      return jsonResponse(
        url.endsWith('/api/runtime')
          ? { version: url.startsWith('https://old') ? '0.0.1' : '1.2.3' }
          : HOST_STATS,
      );
    });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(cliSettings.pushIfChanged.mock.calls).toEqual([['remote-1']]);
    await cliVersions.registerRemoteCheck.mock.calls[0][0]();
    expect(cliSettings.checkNow.mock.calls).toEqual([['remote-1']]);
    service.onModuleDestroy();
    expect(cliVersions.registerRemoteCheck.mock.results[0].value).toHaveBeenCalled();
  });

  it('broadcasts changes to CLI versions even when all other runtime fields stay equal', async () => {
    const report = {
      claude: {
        installedVersion: '1.0.0',
        desiredVersion: 'latest',
        state: 'idle',
        error: null,
        checkedAt: null,
      },
    };
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(
        url.endsWith('/api/runtime') ? { version: '1.2.3', providerClis: report } : HOST_STATS,
      ),
    );
    await service.refresh('remote-1');
    broadcaster.broadcastEvent.mockClear();
    report.claude.installedVersion = '2.0.0';
    await service.refresh('remote-1');
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
      'remotes',
      'state',
      expect.objectContaining({ providerClis: report }),
    );
  });

  it('broadcasts a claim-time CLI version change and retains it offline', async () => {
    let agy = '1.0.0';
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(
        url.endsWith('/api/runtime') ? { version: '1.2.3', cliVersions: { agy } } : HOST_STATS,
      ),
    );
    await service.refresh('remote-1');
    broadcaster.broadcastEvent.mockClear();
    agy = '2.0.0';
    await service.refresh('remote-1');
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
      'remotes',
      'state',
      expect.objectContaining({ cliVersions: { agy: '2.0.0' } }),
    );
    fetchMock.mockRejectedValue(new Error('offline'));
    await service.refresh('remote-1');
    expect(service.getState('remote-1')).toMatchObject({
      online: false,
      cliVersions: { agy: '2.0.0' },
    });
  });

  it('returns an offline default for a remote that has never been polled', () => {
    expect(service.getState('unknown')).toEqual({
      online: false,
      apiKeyRejected: false,
      version: null,
      versionMatches: false,
      homePath: null,
      uid: null,
      gid: null,
      stats: null,
      lastSeenAt: null,
      error: null,
      powerState: 'unknown',
    });
  });

  it('goes online after one successful poll and reports an exact version match', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    const state = service.getState('remote-1');
    expect(state.online).toBe(true);
    expect(state.version).toBe('1.2.3');
    expect(state.versionMatches).toBe(true);
    expect(state.homePath).toBeNull();
    expect(state.stats).toEqual(HOST_STATS);
    expect(state.error).toBeNull();
    expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
      'remotes',
      'state',
      expect.objectContaining({ remoteId: 'remote-1', online: true }),
    );
    // A successful poll also asks the host for changed provider login families.
    expect(familyWriteback.pullIfChanged).toHaveBeenCalledWith(
      'remote-1',
      'https://10.0.0.1',
      fixtureTls.cert,
    );
  });

  it.each([
    undefined,
    {
      installed: false,
      engineVersion: null,
      composeVersion: null,
      userInGroup: false,
      dataRootFreeBytes: null,
    },
    { unexpected: 'bad Docker data' },
  ])('keeps the remote healthy when Docker is absent or unavailable: %p', async (docker) => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3', docker })
          : jsonResponse(HOST_STATS),
      ),
    );
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.getState('remote-1')).toMatchObject({
      online: true,
      versionMatches: true,
      error: null,
    });
  });

  it.each([
    ["this PC's home folder", homedir(), true],
    ['a different home folder', '/home/devchain-test-other-user', false],
    ['no home folder', undefined, null],
  ])('carries %s and whether it matches in the state event', async (_label, homePath, matches) => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3', homePath })
          : jsonResponse(HOST_STATS),
      ),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(service.getState('remote-1').homePath).toBe(homePath ?? null);
    expect(service.getState('remote-1')).not.toHaveProperty('homePathMatches');
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
      'remotes',
      'state',
      expect.objectContaining({ homePath: homePath ?? null, homePathMatches: matches }),
    );
  });

  it('carries the real account ids the runtime reports, null when absent', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3', uid: 1000, gid: 1000 })
          : jsonResponse(HOST_STATS),
      ),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(service.getState('remote-1').uid).toBe(1000);
    expect(service.getState('remote-1').gid).toBe(1000);

    // An older remote reports no ids; the state falls back to null.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );
    await tick();
    expect(service.getState('remote-1').uid).toBeNull();
    expect(service.getState('remote-1').gid).toBeNull();
  });

  it('carries the provider env overrides the runtime reports, null when absent or malformed', async () => {
    const overrides = [
      { key: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'provider-env', provider: 'claude' },
      {
        key: 'COPILOT_GITHUB_TOKEN',
        source: 'provider-env-scoped',
        provider: 'copilot',
        projects: ['Alpha'],
      },
    ];
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3', providerEnvOverrides: overrides })
          : jsonResponse(HOST_STATS),
      ),
    );
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.getState('remote-1').providerEnvOverrides).toEqual(overrides);

    // An older remote reports no overrides; the state falls back to null.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );
    await tick();
    expect(service.getState('remote-1').providerEnvOverrides).toBeNull();

    // Malformed data is treated the same as absent, never carried half-parsed.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3', providerEnvOverrides: [{ key: 1 }] })
          : jsonResponse(HOST_STATS),
      ),
    );
    await tick();
    expect(service.getState('remote-1').providerEnvOverrides).toBeNull();
  });

  it('skips the families pull on a failed poll', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await tick();

    expect(service.getState('remote-1').online).toBe(false);
    expect(familyWriteback.pullIfChanged).not.toHaveBeenCalled();
  });

  it('uses Proxmox power state after the host stops answering', async () => {
    storage.listRemotes.mockResolvedValue({
      items: [
        makeRemote({ kind: 'proxmox', vmIdentity: 'abc', vmProviderConnectionId: 'connection-1' }),
      ],
    });
    vmProviders.forRemote.mockResolvedValue({
      getPowerState: jest.fn().mockResolvedValue('stopped'),
    });
    fetchMock.mockRejectedValue(new Error('network down'));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await tick();
    expect(service.getState('remote-1').powerState).toBe('stopped');
    expect(familyWriteback.pullIfChanged).not.toHaveBeenCalled();
  });

  it('keeps a refresh answer when a failed timer poll finishes loading the power state later', async () => {
    const proxmox = makeRemote({
      kind: 'proxmox',
      vmIdentity: 'abc',
      vmProviderConnectionId: 'connection-1',
    });
    storage.listRemotes.mockResolvedValue({ items: [proxmox] });
    storage.getRemote.mockResolvedValue(proxmox);
    let release!: (state: 'running') => void;
    vmProviders.forRemote.mockResolvedValue({
      getPowerState: jest.fn(() => new Promise((resolve) => (release = resolve))),
    });
    fetchMock.mockRejectedValue(new Error('network down'));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    // The second failure reaches the offline threshold and waits for the power state.
    await tick();
    expect(vmProviders.forRemote).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(url.endsWith('/api/runtime') ? { version: '1.2.3' } : HOST_STATS),
    );
    await expect(service.refresh('remote-1')).resolves.toMatchObject({ online: true });
    release('running');
    await jest.advanceTimersByTimeAsync(0);

    expect(service.getState('remote-1')).toMatchObject({ online: true, version: '1.2.3' });
  });

  it('never polls a remote without an address', async () => {
    storage.listRemotes.mockResolvedValue({
      items: [makeRemote({ kind: 'proxmox', baseUrl: null })],
    });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.getState('remote-1').online).toBe(false);
  });

  it('reports a remote without a certificate offline without contacting it', async () => {
    storage.listRemotes.mockResolvedValue({ items: [makeRemote({ tlsCertificate: null })] });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await tick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.getState('remote-1')).toMatchObject({
      online: false,
      error: expect.stringContaining('Add the VM again or reset it'),
    });
    expect(familyWriteback.pullIfChanged).not.toHaveBeenCalled();
  });

  it('reports versionMatches false on an exact-string mismatch', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.4' })
          : jsonResponse(HOST_STATS),
      ),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(service.getState('remote-1').versionMatches).toBe(false);
    expect(skillSettings.pushIfChanged).not.toHaveBeenCalled();
  });

  it('marks a remote offline only after two consecutive failed polls, then online after one success', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.getState('remote-1').online).toBe(true);
    broadcaster.broadcastEvent.mockClear();

    // First consecutive failure: state must not flip yet, and nothing broadcasts.
    fetchMock.mockRejectedValue(new Error('network down'));
    await tick();
    expect(service.getState('remote-1').online).toBe(true);
    expect(broadcaster.broadcastEvent).not.toHaveBeenCalled();

    // Second consecutive failure: now offline, with the error recorded.
    await tick();
    const offlineState = service.getState('remote-1');
    expect(offlineState.online).toBe(false);
    expect(offlineState.error).toContain('network down');
    // Last known version/stats are preserved through the offline transition.
    expect(offlineState.version).toBe('1.2.3');
    expect(offlineState.stats).toEqual(HOST_STATS);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
    broadcaster.broadcastEvent.mockClear();

    // One success brings it back online immediately.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );
    await tick();
    expect(service.getState('remote-1').online).toBe(true);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
  });

  it('does not emit on a no-op poll where nothing changed', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);

    // Identical successful poll again: no state change, no second emit.
    await tick();
    expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(1);
  });

  it('treats a non-2xx response the same as a network failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await tick();

    expect(service.getState('remote-1').online).toBe(false);
  });

  it('drops tracked state for a remote no longer returned by storage', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/api/runtime')
          ? jsonResponse({ version: '1.2.3' })
          : jsonResponse(HOST_STATS),
      ),
    );
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.getState('remote-1').online).toBe(true);

    storage.listRemotes.mockResolvedValue({ items: [] });
    await tick();

    // Pruned back to the never-polled default rather than a stale "online" snapshot.
    expect(service.getState('remote-1')).toEqual({
      online: false,
      apiKeyRejected: false,
      version: null,
      versionMatches: false,
      homePath: null,
      uid: null,
      gid: null,
      stats: null,
      lastSeenAt: null,
      error: null,
      powerState: 'unknown',
    });
  });

  describe('stats history', () => {
    function mockStatsPerPoll(): void {
      let poll = 0;
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.endsWith('/api/runtime')
            ? jsonResponse({ version: '1.2.3' })
            : jsonResponse({ ...HOST_STATS, cpuPercent: ++poll }),
        ),
      );
    }

    it('appends one sample per successful poll, oldest first', async () => {
      mockStatsPerPoll();
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      await tick();

      expect(service.getStatsHistory('remote-1').map((sample) => sample.cpuPercent)).toEqual([
        1, 2,
      ]);
    });

    it('caps the history at 60 samples, dropping the oldest', async () => {
      mockStatsPerPoll();
      service.onModuleInit();
      // Initial poll plus 60 timer ticks -> 61 samples for a 60-slot buffer.
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 60; i += 1) {
        await tick();
      }

      const history = service.getStatsHistory('remote-1');
      expect(history).toHaveLength(60);
      expect(history[0]?.cpuPercent).toBe(2);
      expect(history[history.length - 1]?.cpuPercent).toBe(61);
    });

    it('skips appending when a successful poll returns null stats', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.endsWith('/api/runtime') ? jsonResponse({ version: '1.2.3' }) : jsonResponse(null),
        ),
      );
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      await tick();

      expect(service.getState('remote-1').online).toBe(true);
      expect(service.getState('remote-1').stats).toBeNull();
      expect(service.getStatsHistory('remote-1')).toEqual([]);
    });

    it('drops the history together with the remote state on prune', async () => {
      mockStatsPerPoll();
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getStatsHistory('remote-1')).toHaveLength(1);

      storage.listRemotes.mockResolvedValue({ items: [] });
      await tick();

      expect(service.getStatsHistory('remote-1')).toEqual([]);
    });

    it('returns an empty list for a remote with no history', () => {
      expect(service.getStatsHistory('never-polled')).toEqual([]);
    });
  });
});
