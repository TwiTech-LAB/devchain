import { RemoteApiKeyService } from '../auth/remote-api-key.service';
/**
 * The freeze answer is the host-issued cursor, so the client must parse it as
 * a typed response. Test layer: service unit — a stubbed fetch proves parsing
 * and the error shape without a second instance; the sync methods' unreachable
 * case uses a real closed loopback port.
 */
import { ConflictError } from '../../../common/errors/error-types';
import { fixtureTls } from '../../../common/test/tls-fixture';
import type { Remote } from '../../storage/models/domain.models';
import { SCAN_TIMEOUT_MS } from '../../file-sync/file-sync.service';
import { RemoteHostClient, RemoteHostRequestError, dialAddress } from './remote-host.client';

const mockPinnedTo: string[] = [];
jest.mock('../transport/remote-tls', () => ({
  ...jest.requireActual('../transport/remote-tls'),
  remoteFetch: (url: string, init: RequestInit, certificate: string) => {
    mockPinnedTo.push(certificate);
    return globalThis.fetch(url, init);
  },
}));

const T = '2026-09-22T10:00:00.000Z';
const REMOTE: Remote = {
  id: 'remote-1',
  name: 'vm-1',
  baseUrl: 'https://127.0.0.1:9',
  kind: 'address',
  vmProviderConnectionId: null,
  vmIdentity: null,
  vmSpec: null,
  tlsCertificate: fixtureTls.cert,
  tlsFingerprint: null,
  createdAt: T,
  updatedAt: T,
};

const originalFetch = global.fetch;

function makeClient(): RemoteHostClient {
  return new RemoteHostClient(
    {
      getRemote: async () => REMOTE,
    } as never,
    { get: async () => null, headers: async () => ({}) } as never,
  );
}

afterEach(() => {
  global.fetch = originalFetch;
  mockPinnedTo.length = 0;
});

it.each(['ubuntu', null])('parses the runtime claim identity with holder %p', async (holder) => {
  const body = {
    uid: 1001,
    gid: 20,
    requestedUid: 501,
    requestedGid: 20,
    primaryGroup: 'dialout',
    uidConflict: { requestedUid: 501, holder },
  };
  global.fetch = jest.fn(async () => new Response(JSON.stringify(body))) as typeof fetch;
  await expect(makeClient().runtimeAt(REMOTE.baseUrl!, fixtureTls.cert)).resolves.toEqual(body);
});

it('accepts runtime reports without claim identity from older hosts', async () => {
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ uid: 1000, gid: 1000 })),
  ) as typeof fetch;
  await expect(makeClient().runtimeAt(REMOTE.baseUrl!, fixtureTls.cert)).resolves.toEqual({
    uid: 1000,
    gid: 1000,
  });
});

it('posts public keys to the claimed host with its VM API key', async () => {
  const fetchMock = jest.fn(async () => ({ status: 200, body: null }));
  global.fetch = fetchMock as unknown as typeof fetch;
  const client = new RemoteHostClient(
    { getRemote: async () => REMOTE } as never,
    { get: async () => 'vm-api-key' } as never,
  );
  await client.applySshKeys(REMOTE.id, ['public-key']);
  expect(fetchMock).toHaveBeenCalledWith(`${REMOTE.baseUrl}/api/host/ssh-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer vm-api-key' },
    body: JSON.stringify({ keys: ['public-key'] }),
    signal: expect.any(AbortSignal),
  });
});

describe('RemoteHostClient.syncScan', () => {
  afterEach(() => jest.useRealTimers());

  it('waits for the host scan past the 15 s control limit', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    let answer: (() => void) | undefined;
    global.fetch = jest.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((resolve) => {
        answer = () => resolve({ status: 204, body: null } as unknown as Response);
      });
    }) as unknown as typeof fetch;

    const scan = makeClient().syncScan('remote-1', 'code:p1');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
    answer?.();
    await scan;
  });
});

it.each([200, 404])('posts owner repairs and handles a host response of %s', async (status) => {
  const input = {
    root: '/home/alice/project',
    items: [{ path: 'source.ts', mode: 'automatic' as const }],
  };
  const body = {
    user: { uid: 1001, name: 'alice' },
    items: [{ path: 'source.ts', state: 'repaired', paths: ['source.ts'] }],
  };
  const fetchMock = jest.fn(async () => new Response(JSON.stringify(body), { status }));
  global.fetch = fetchMock as typeof fetch;
  const result = await makeClient().syncChown(REMOTE.id, input);
  expect(fetchMock).toHaveBeenCalledWith(
    `${REMOTE.baseUrl}/api/host/sync/chown`,
    expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
  );
  expect(result.items[0]).toMatchObject({
    path: 'source.ts',
    state: status === 200 ? 'repaired' : 'unsupported',
  });
  if (status === 404) expect(result.items[0].reason).toContain('copy command');
});

describe('RemoteHostClient.freeze', () => {
  it('returns the parsed { projectId, frozenAt }', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      json: async () => ({ projectId: 'A', frozenAt: T }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(makeClient().freeze('remote-1', 'A')).resolves.toEqual({
      projectId: 'A',
      frozenAt: T,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://127.0.0.1:9/api/host/projects/A/freeze', {
      method: 'POST',
      headers: {},
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects with RemoteHostRequestError when the body does not parse', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      json: async () => ({ unexpected: true }),
    })) as unknown as typeof fetch;

    const error: unknown = await makeClient()
      .freeze('remote-1', 'A')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteHostRequestError);
    expect(error).toMatchObject({
      code: 'REMOTE_HOST_REQUEST_FAILED',
      details: { remoteId: 'remote-1', status: 200, hostCode: null },
    });
  });
});

// Client-unit coverage owns the encoded paths, request bodies and typed answers.
describe('RemoteHostClient git guard', () => {
  it('reads typed project sessions without using terminal titles as agent names', async () => {
    const response = [
      {
        id: 'session',
        agentId: 'agent',
        name: 'terminal title',
        status: 'running',
        startedAt: '2026-10-05T12:00:00.000Z',
      },
    ];
    const fetchMock = jest.fn(async () => ({ status: 200, json: async () => response }));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await makeClient().listSessions('remote-1', 'project')).toEqual([
      {
        id: 'session',
        agentId: 'agent',
        status: 'running',
        startedAt: '2026-10-05T12:00:00.000Z',
        activityState: null,
        busySince: null,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${REMOTE.baseUrl}/api/sessions?projectId=project`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it.each(['install', 'remove'] as const)(
    'sends and parses the %s guard request',
    async (action) => {
      const result =
        action === 'install'
          ? { warning: 'old git' }
          : { removed: false, indexRefreshed: null, warning: null };
      const fetchMock = jest.fn(async () => ({ status: 200, json: async () => result }));
      global.fetch = fetchMock as unknown as typeof fetch;
      const request = { homeName: 'home-pc', reason: 'disconnect' as const };
      const client = makeClient();

      await expect(
        action === 'install'
          ? client.installGitGuard('remote-1', 'A/B', request)
          : client.removeGitGuard('remote-1', 'A/B'),
      ).resolves.toEqual(result);
      expect(fetchMock).toHaveBeenCalledWith(
        `${REMOTE.baseUrl}/api/host/projects/A%2FB/git-guard`,
        {
          method: action === 'install' ? 'POST' : 'DELETE',
          headers: action === 'install' ? { 'content-type': 'application/json' } : {},
          signal: expect.any(AbortSignal),
          ...(action === 'install' ? { body: JSON.stringify(request) } : {}),
        },
      );
    },
  );

  it.each(['install', 'remove'] as const)(
    'rejects an invalid %s answer so the step can Retry',
    async (action) => {
      global.fetch = jest.fn(async () => ({
        status: 200,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      const client = makeClient();
      await expect(
        action === 'install'
          ? client.installGitGuard('remote-1', 'A', { homeName: 'home-pc', reason: 'disconnect' })
          : client.removeGitGuard('remote-1', 'A'),
      ).rejects.toMatchObject({
        code: 'REMOTE_HOST_REQUEST_FAILED',
        status: 200,
      });
    },
  );
});

describe('RemoteHostClient epic methods', () => {
  const epic = {
    projectId: 'A',
    statusId: 'A-status',
    title: 'Imported',
    description: null,
    data: { idempotencyKey: 'import:jira:scope:ENG-1' },
  };

  it('looks the key up URI-encoded and answers null for a 404', async () => {
    const fetchMock = jest.fn(async () => ({ status: 404, body: null }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      makeClient().findEpicByIdempotencyKey('remote-1', 'A', 'import:jira:a/b:ENG 1'),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://127.0.0.1:9/api/host/projects/A/epics/by-idempotency-key/import%3Ajira%3Aa%2Fb%3AENG%201',
      { method: 'GET', signal: expect.any(AbortSignal), headers: {} },
    );
  });

  it('returns the epic id the host found', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      json: async () => ({ epicId: 'epic-9' }),
    })) as unknown as typeof fetch;

    await expect(makeClient().findEpicByIdempotencyKey('remote-1', 'A', 'k')).resolves.toBe(
      'epic-9',
    );
  });

  it('creates through POST /api/epics and returns the new id', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 201,
      json: async () => ({ id: 'epic-9', title: 'Imported' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(makeClient().createEpic('remote-1', epic)).resolves.toEqual({ id: 'epic-9' });
    expect(fetchMock).toHaveBeenCalledWith('https://127.0.0.1:9/api/epics', {
      method: 'POST',
      signal: expect.any(AbortSignal),
      body: JSON.stringify(epic),
      headers: { 'content-type': 'application/json' },
    });
  });

  it('maps a 423 from a frozen host to a retryable conflict', async () => {
    global.fetch = jest.fn(async () => ({
      status: 423,
      json: async () => ({ code: 'PROJECT_FROZEN' }),
    })) as unknown as typeof fetch;

    const error: unknown = await makeClient()
      .createEpic('remote-1', epic)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toMatchObject({
      code: 'REMOTE_PROJECT_LOCKED',
      retryable: true,
      hostCode: 'PROJECT_FROZEN',
    });
  });

  it('rejects with RemoteHostRequestError for any other status', async () => {
    global.fetch = jest.fn(async () => ({
      status: 400,
      json: async () => ({ code: 'validation' }),
    })) as unknown as typeof fetch;

    await expect(makeClient().createEpic('remote-1', epic)).rejects.toBeInstanceOf(
      RemoteHostRequestError,
    );
  });
});

describe('RemoteHostClient sync methods', () => {
  const HOME_ID = Array(8).fill('HOMEAAA').join('-');

  it('encodes the remote-need folder/device and validates the returned report', async () => {
    const report = {
      total: 24,
      deleted: 2,
      sample: [{ path: 'gone.txt', deleted: true }],
      conflictPaths: [],
      conflictsOverCap: false,
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }));
    global.fetch = fetchMock;
    await expect(makeClient().syncRemoteNeed('remote-1', 'code:A/B', HOME_ID)).resolves.toEqual(
      report,
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${REMOTE.baseUrl}/api/host/sync/folders/code%3AA%2FB/remote-need?device=${HOME_ID}`,
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...report, total: -1 }), { status: 200 }),
    );
    await expect(makeClient().syncRemoteNeed('remote-1', 'code:A', HOME_ID)).rejects.toMatchObject({
      code: 'REMOTE_HOST_REQUEST_FAILED',
      status: 200,
    });
  });

  async function closedPort(): Promise<number> {
    const { createServer } = await import('net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it('maps an unreachable host to RemoteHostRequestError with status null', async () => {
    const baseUrl = `https://127.0.0.1:${await closedPort()}`;
    const client = new RemoteHostClient(
      {
        getRemote: async () => ({ ...REMOTE, baseUrl }),
      } as never,
      { get: async () => null, headers: async () => ({}) } as never,
    );

    const calls: Array<() => Promise<unknown>> = [
      () => client.syncDevice('remote-1'),
      () => client.syncPeer('remote-1', { deviceId: HOME_ID, address: 'tcp://127.0.0.1:1' }),
      () =>
        client.syncFolders('remote-1', {
          projectId: 'A',
          kind: 'code',
          type: 'receiveonly',
          peerDeviceId: HOME_ID,
          ignores: [],
        }),
      () => client.syncFolderType('remote-1', 'code:A', { type: 'sendonly' }),
      () => client.syncStatus('remote-1', 'code:A', HOME_ID),
      () => client.syncFolderExists('remote-1', 'code:A'),
      () => client.syncRemoteNeed('remote-1', 'code:A', HOME_ID),
      () => client.syncInspect('remote-1', { path: '/home/alice/project', scan: true, paths: [] }),
    ];
    for (const call of calls) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteHostRequestError);
      expect((error as RemoteHostRequestError).status).toBeNull();
    }
  });
});

describe('dialAddress', () => {
  it('points the listen address at the host name in the base URL', () => {
    expect(dialAddress('tcp://0.0.0.0:22001', 'http://192.168.1.20:3000')).toBe(
      'tcp://192.168.1.20:22001',
    );
    expect(dialAddress('tcp://[::]:22001', 'http://vm-1.lan:3000/')).toBe('tcp://vm-1.lan:22001');
    expect(dialAddress('quic://127.0.0.1:22001', 'http://[fd00::5]:3000')).toBe(
      'quic://[fd00::5]:22001',
    );
    expect(dialAddress('dynamic', 'http://192.168.1.20:3000')).toBe('dynamic');
  });
});

describe('RemoteHostClient.remoteRuntime', () => {
  it('accepts a provider CLI report in a shape this build does not know', async () => {
    // Home is newer than a VM during Update VM; the health poll reads this
    // report on its own, so the operations' runtime parse must not reject it.
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        version: '1.0.0',
        providerClis: { claude: { installedVersion: '2.1.0', futureField: true }, other: {} },
      }),
    });
    await expect(makeClient().remoteRuntime('remote-1')).resolves.toMatchObject({
      version: '1.0.0',
    });
  });
});

describe('RemoteHostClient Docker contract', () => {
  it('returns the detached job id and parses status separately', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 202, json: async () => ({ jobId: 'job' }) })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ status: { jobId: 'job', state: 'installing', at: T } }),
      });
    const host = makeClient();
    await expect(host.requestDocker('remote-1')).resolves.toEqual({ jobId: 'job' });
    await expect(host.dockerStatus('remote-1')).resolves.toMatchObject({
      jobId: 'job',
      state: 'installing',
    });
  });

  it('preserves the manual migration command in an outdated-helper refusal', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ details: { code: 'HOST_HELPER_OUTDATED' } }),
    });
    await expect(makeClient().requestDocker('remote-1')).rejects.toMatchObject({
      message: expect.stringContaining(
        'sudo npm install -g /opt/devchain-host/current/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz',
      ),
      details: { hostCode: 'HOST_HELPER_OUTDATED', status: 409 },
    });
  });
});

// Unit transport assertions cover auth on the common request path and the bootstrap URL path.
describe('RemoteHostClient authorization', () => {
  it('reads the replacement key on its next call and permits anonymous runtime probes', async () => {
    let key = 'first';
    const keys = new RemoteApiKeyService({
      readRemoteApiKey: async () => key,
      saveRemoteApiKey: async (_id: string, value: string) => {
        key = value;
      },
    } as never);
    const client = new RemoteHostClient({ getRemote: async () => REMOTE } as never, keys);
    const fetchMock = jest.fn(async () => ({
      status: 200,
      json: async () => ({ projectId: 'A', frozenAt: T }),
      body: null,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    for (const current of ['first', 'replacement']) {
      await keys.save(REMOTE.id, current);
      await client.freeze(REMOTE.id, 'A');
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${current}` }),
        }),
      );
      await client.claim('https://bootstrap', fixtureTls.cert, {} as never, current);
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://bootstrap/api/host/claim',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${current}` }),
        }),
      );
    }
    fetchMock.mockResolvedValue({
      status: 200,
      json: async () => ({ version: null }),
      body: null,
    } as never);
    await client.runtimeAt('https://bootstrap', fixtureTls.cert);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://bootstrap/api/runtime',
      expect.objectContaining({ headers: {} }),
    );
    expect(new Set(mockPinnedTo)).toEqual(new Set([fixtureTls.cert]));
  });
});

describe('RemoteHostClient VM certificate', () => {
  it('pins each call to the certificate stored for the remote', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      json: async () => ({ projectId: 'A', frozenAt: T }),
    })) as unknown as typeof fetch;

    await makeClient().freeze('remote-1', 'A');
    await expect(makeClient().certificateOf('remote-1')).resolves.toBe(fixtureTls.cert);
    expect(mockPinnedTo).toEqual([fixtureTls.cert]);
  });

  it('refuses a remote without a certificate before any request goes out', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new RemoteHostClient(
      { getRemote: async () => ({ ...REMOTE, tlsCertificate: null }) } as never,
      { get: async () => null, headers: async () => ({}) } as never,
    );

    for (const call of [
      () => client.remoteRuntime('remote-1'),
      () => client.freeze('remote-1', 'A'),
      () => client.certificateOf('remote-1'),
    ]) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({
        code: 'REMOTE_TLS_CERTIFICATE_MISSING',
        remoteId: 'remote-1',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
