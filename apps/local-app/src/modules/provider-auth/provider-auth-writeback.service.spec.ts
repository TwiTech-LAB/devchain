import { RemoteApiKeyService } from '../remotes/auth/remote-api-key.service';
import { ProviderAuthWritebackService } from './provider-auth-writeback.service';
import type { ProviderAuthVaultService } from './provider-auth-vault.service';
import type { ProviderAuthStorage, RemoteStorage } from '../storage/interfaces/storage.interface';
import type { Remote } from '../storage/models/domain.models';
import { fixtureTls } from '../../common/test/tls-fixture';

jest.mock('../remotes/transport/remote-tls', () => ({
  ...jest.requireActual('../remotes/transport/remote-tls'),
  remoteFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

function makeRemote(): Remote {
  return {
    id: 'remote-1',
    name: 'lab-host',
    baseUrl: 'https://127.0.0.1:9',
    kind: 'address',
    vmProviderConnectionId: null,
    vmIdentity: null,
    vmSpec: null,
    tlsCertificate: fixtureTls.cert,
    tlsFingerprint: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function familiesResponse(mtime: number) {
  return {
    ok: true,
    status: 200,
    json: async () => [
      {
        provider: 'codex',
        files: [
          {
            path: '.codex/auth.json',
            contentBase64: Buffer.from('{"tokens":{"refresh_token":"r2"}}').toString('base64'),
            mtime,
          },
        ],
      },
    ],
  };
}

describe('ProviderAuthWritebackService', () => {
  let storage: { getRemote: jest.Mock; listRemoteOperations: jest.Mock };
  let vault: { writeBackFamilies: jest.Mock; familiesOfRemote: jest.Mock };
  let fetchMock: jest.Mock;
  let service: ProviderAuthWritebackService;
  let apiKeys: RemoteApiKeyService;

  beforeEach(() => {
    storage = {
      getRemote: jest.fn().mockResolvedValue(makeRemote()),
      listRemoteOperations: jest.fn().mockResolvedValue([]),
    };
    vault = {
      writeBackFamilies: jest.fn().mockResolvedValue([]),
      familiesOfRemote: jest
        .fn()
        .mockResolvedValue([{ provider: 'codex', entryId: 'e1', lastWritebackAt: '2026-01-01' }]),
    };
    let key = 'first';
    apiKeys = new RemoteApiKeyService({
      readRemoteApiKey: async () => key,
      saveRemoteApiKey: async (_id: string, value: string) => {
        key = value;
      },
    } as never);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new ProviderAuthWritebackService(
      storage as unknown as ProviderAuthStorage & RemoteStorage,
      vault as unknown as ProviderAuthVaultService,
      apiKeys,
    );
  });

  // Unit transport assertions detect missing headers even when loopback peers allow anonymous calls.
  it('uses a saved replacement key on the next request', async () => {
    fetchMock.mockResolvedValue(familiesResponse(1000));
    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { authorization: 'Bearer first' } }),
    );
    await apiKeys.save('remote-1', 'second');
    fetchMock.mockClear();
    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { authorization: 'Bearer second' } }),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('updates the vault only when the host reports a changed file', async () => {
    fetchMock.mockResolvedValueOnce(familiesResponse(1000)).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    expect(vault.writeBackFamilies).toHaveBeenCalledTimes(1);

    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    expect(vault.writeBackFamilies).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1500, 1500],
    [1790497465557.3618, 1790497465558],
  ])('uses mtime %s as since=%s', async (mtime, since) => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    fetchMock.mockResolvedValueOnce(familiesResponse(mtime));

    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);

    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://host/api/host/provider-auth/families?since=${since}`,
      expect.anything(),
    );
  });

  it('skips silently when the host has no families route or is a plain instance', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
    });

    for (let i = 0; i < 3; i++) {
      await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    }
    expect(vault.writeBackFamilies).not.toHaveBeenCalled();
  });

  it('skips the host request when no family is checked out to the remote', async () => {
    vault.familiesOfRemote.mockResolvedValueOnce([]);

    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a network failure without touching the vault', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert),
    ).resolves.toBeUndefined();
    expect(vault.writeBackFamilies).not.toHaveBeenCalled();
  });

  it('pullFamiliesNow reports the stored write-back when the host is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.pullFamiliesNow('remote-1')).resolves.toEqual({
      pulled: false,
      families: [{ provider: 'codex', entryId: 'e1', lastWritebackAt: '2026-01-01' }],
    });
  });

  it('pullFamiliesNow reports no pull for a remote without a certificate', async () => {
    storage.getRemote.mockResolvedValue({ ...makeRemote(), tlsCertificate: null });

    await expect(service.pullFamiliesNow('remote-1')).resolves.toMatchObject({ pulled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pullFamiliesNow does not report a pull when the host refuses or answers an unexpected body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(service.pullFamiliesNow('remote-1')).resolves.toMatchObject({ pulled: false });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
    });
    await expect(service.pullFamiliesNow('remote-1')).resolves.toMatchObject({ pulled: false });

    expect(vault.writeBackFamilies).not.toHaveBeenCalled();
  });

  it('pullFamiliesNow pulls fresh content first when the host answers', async () => {
    fetchMock.mockResolvedValueOnce(familiesResponse(2000));

    await expect(service.pullFamiliesNow('remote-1')).resolves.toMatchObject({
      pulled: true,
      families: [{ provider: 'codex', entryId: 'e1' }],
    });
    expect(vault.writeBackFamilies).toHaveBeenCalledWith('remote-1', expect.anything());
  });
  it('drains an in-flight poll and blocks further pulls until resumed', async () => {
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vault.writeBackFamilies.mockImplementationOnce(async () => {
      started();
      await blocked;
    });
    fetchMock.mockResolvedValue(familiesResponse(1000));
    const pull = service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    await entered;
    let drained = false;
    const pause = service.pause('remote-1', 'operation-1').then(() => {
      drained = true;
    });
    const skipped = service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    expect(drained).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([pull, pause, skipped]);
    expect(drained).toBe(true);
    expect((await service.pullFamiliesNow('remote-1')).pulled).toBe(false);
    service.resume('operation-1');
    await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://host/api/host/provider-auth/families?since=0',
      expect.anything(),
    );
  });

  it.each(['running', 'failed'])(
    'honors a persisted %s handover pause after a restart',
    async (state) => {
      storage.listRemoteOperations.mockResolvedValue([
        { state, details: { writebackPaused: true } },
      ]);
      await service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
      expect((await service.pullFamiliesNow('remote-1')).pulled).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('serializes a manual pull behind an older poll so stale bytes cannot win', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      entered();
      await pending;
      return familiesResponse(1000);
    });
    fetchMock.mockResolvedValueOnce(familiesResponse(2000));
    const poll = service.pullIfChanged('remote-1', 'https://host', fixtureTls.cert);
    await started;
    const manual = service.pullFamiliesNow('remote-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([poll, manual]);
    expect(
      vault.writeBackFamilies.mock.calls.map(([, reports]) => reports[0].files[0].mtime),
    ).toEqual([1000, 2000]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://127.0.0.1:9/api/host/provider-auth/families?since=1000',
      expect.anything(),
    );
  });
});
