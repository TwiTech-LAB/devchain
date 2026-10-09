import { Readable } from 'node:stream';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
/**
 * The freeze answer is the host-issued cursor, so the client must parse it as
 * a typed response. Test layer: service unit — a stubbed fetch proves parsing
 * and the error shape without a second instance.
 */
import { ConflictError } from '../../../common/errors/error-types';
import { fixtureTls } from '../../../common/test/tls-fixture';
import type { Remote } from '../../storage/models/domain.models';
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

/** Answers every request of the client with one JSON body. */
function stubHost(status: number, body: unknown): void {
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as typeof fetch;
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
  stubHost(200, body);
  await expect(makeClient().runtimeAt(REMOTE.baseUrl!, fixtureTls.cert)).resolves.toEqual(body);
});

it('accepts runtime reports without claim identity from older hosts', async () => {
  stubHost(200, { uid: 1000, gid: 1000 });
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

// Client units are the cheapest layer for request-dependent echoes: transport schemas only check shape.
describe('RemoteHostClient settings echoes', () => {
  const methods = ['putProviderCliSettings', 'putSkillSettings'] as const;

  it.each(methods)('accepts the requested revision for %s', async (method) => {
    stubHost(202, { revision: 'requested-revision' });
    await expect(
      makeClient()[method](REMOTE.id, { revision: 'requested-revision' } as never),
    ).resolves.toBeUndefined();
  });

  it.each(methods)('rejects another revision for %s', async (method) => {
    stubHost(202, { revision: 'another-revision' });
    await expect(
      makeClient()[method](REMOTE.id, { revision: 'requested-revision' } as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Host returned an invalid answer to'),
      details: { remoteId: REMOTE.id, status: 202, hostCode: null },
    });
  });

  // Only the client knows the requested source identity; its unit also observes stream cleanup.
  function uploadEchoedAs(echo: { name: string; contentHash: string }) {
    const stream = Readable.from(['archive']);
    stubHost(200, echo);
    const request = makeClient().uploadSkillSourceContent(REMOTE.id, 'source', 'hash', stream);
    return { request, stream };
  }

  it('accepts a source upload the host echoes back', async () => {
    const { request, stream } = uploadEchoedAs({ name: 'source', contentHash: 'hash' });
    await expect(request).resolves.toBeUndefined();
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    { name: 'other', contentHash: 'hash' },
    { name: 'source', contentHash: 'other' },
  ])('rejects a source upload echoed as $name/$contentHash', async (echo) => {
    const { request, stream } = uploadEchoedAs(echo);
    await expect(request).rejects.toMatchObject({
      message:
        'Host returned an invalid answer to /api/host/skill-settings/local-sources/source/content.',
      details: { remoteId: REMOTE.id, status: 200, hostCode: null },
    });
    expect(stream.destroyed).toBe(true);
  });
});

// Client units isolate claim/update outcomes from the shared HTTP status decoding.
describe('RemoteHostClient claim outcomes', () => {
  const claim = () => makeClient().claim('https://bootstrap', fixtureTls.cert, {} as never);

  it.each([
    { status: 200, code: null, outcome: 'claimed' },
    { status: 409, code: 'ALREADY_CLAIMED', outcome: 'already_claimed' },
    { status: 504, code: 'TIMEOUT', outcome: 'starting' },
  ])('maps a claim response of $status/$code to $outcome', async ({ status, code, outcome }) => {
    stubHost(status, { details: { code } });
    await expect(claim()).resolves.toBe(outcome);
  });

  it('refuses a claim answered 409/NOT_A_HOST', async () => {
    stubHost(409, { details: { code: 'NOT_A_HOST' } });
    await expect(claim()).rejects.toMatchObject({
      message: 'The VM refused the claim (NOT_A_HOST).',
      details: { remoteId: 'https://bootstrap', status: 409, hostCode: 'NOT_A_HOST' },
    });
  });
});

// The client owns the import conflict outcome; no second instance is required for this mapping.
describe('RemoteHostClient import conflicts', () => {
  it('reports an existing project as not imported', async () => {
    stubHost(409, { details: { code: 'PROJECT_EXISTS' } });
    await expect(makeClient().importProject(REMOTE.id, {} as never)).resolves.toEqual({
      imported: false,
      reason: 'PROJECT_EXISTS',
    });
  });

  it.each(['OTHER_CONFLICT', null])('refuses import conflict %p', async (code) => {
    stubHost(409, { details: { code } });
    await expect(makeClient().importProject(REMOTE.id, {} as never)).rejects.toMatchObject({
      message: 'Host refused the project import.',
      details: { remoteId: REMOTE.id, status: 409, hostCode: code },
    });
  });
});

// Client unit responses cover update interpretation; transport tests cover code extraction.
describe('RemoteHostClient update outcomes', () => {
  it.each([
    { status: 202, code: null, outcome: 'started' },
    { status: 409, code: 'UPDATE_IN_PROGRESS', outcome: 'in_progress' },
  ])('maps an update response of $status/$code to $outcome', async ({ status, code, outcome }) => {
    stubHost(status, { details: { code } });
    await expect(makeClient().requestHostUpdate(REMOTE.id, '1.0.0')).resolves.toBe(outcome);
  });

  it('refuses an update answered 409/OTHER_CONFLICT', async () => {
    stubHost(409, { details: { code: 'OTHER_CONFLICT' } });
    await expect(makeClient().requestHostUpdate(REMOTE.id, '1.0.0')).rejects.toMatchObject({
      message: 'The host refused the update (OTHER_CONFLICT).',
      details: { remoteId: REMOTE.id, status: 409, hostCode: 'OTHER_CONFLICT' },
    });
  });
});
