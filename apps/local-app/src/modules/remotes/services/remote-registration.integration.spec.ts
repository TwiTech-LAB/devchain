import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { certificateFingerprint, normalizeCertificate } from '../../../common/tls/certificate';
import { RemoteApiKeyManagementService } from '../auth/remote-api-key-management.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemotesService } from './remotes.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

const key = `dck_${'k'.repeat(43)}`;

/**
 * A VM stand-in over real TLS that records every request that reaches it.
 * `serve` changes the certificate for new connections, as a machine that
 * takes over the address between two calls would.
 */
async function fakeVm(): Promise<{
  baseUrl: string;
  seen: SeenRequest[];
  serve(pair: { key: string; cert: string }): void;
  close(): Promise<void>;
}> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer(
    { key: fixtureTls.key, cert: fixtureTls.cert },
    (req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url === '/api/runtime' ? JSON.stringify({ version: '1.0.0' }) : '{}');
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    serve: (pair) => server.setSecureContext({ key: pair.key, cert: pair.cert }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Integration: real TLS sockets through the production discovery, pinned fetch,
// key check and create order; only storage and the key store are in-memory fakes.
describe('add a VM by address with a pasted fingerprint', () => {
  let vm: Awaited<ReturnType<typeof fakeVm>>;
  let storage: { createRemote: jest.Mock; deleteRemote: jest.Mock };
  let keys: { save: jest.Mock };
  let service: RemotesService;

  beforeEach(async () => {
    vm = await fakeVm();
    storage = {
      createRemote: jest.fn(async (data: Record<string, unknown>) => ({ id: 'vm-1', ...data })),
      deleteRemote: jest.fn(),
    };
    keys = { save: jest.fn(async () => undefined) };
    service = new RemotesService(
      storage as never,
      {} as never,
      new RemoteHostClient(storage as never, keys as never),
      {} as never,
      {} as never,
      new RemoteApiKeyManagementService(storage as never, keys as never, {} as never),
      keys as never,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await vm.close();
  });

  const add = (fingerprint: string) =>
    service.create({
      name: 'vm',
      baseUrl: vm.baseUrl,
      kind: 'address',
      apiKey: key,
      certificateFingerprint: fingerprint,
    });

  it('sends the key only after the fingerprint matched, and saves the pinned certificate', async () => {
    await add(certificateFingerprint(fixtureTls.cert));

    expect(vm.seen).toEqual([
      { method: 'GET', path: '/api/runtime', authorization: undefined, body: '' },
      { method: 'GET', path: '/api/host/stats', authorization: `Bearer ${key}`, body: '' },
    ]);
    expect(storage.createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ tlsCertificate: normalizeCertificate(fixtureTls.cert) }),
    );
    expect(keys.save).toHaveBeenCalledWith('vm-1', key);
  });

  it('on a mismatch saves nothing and the VM sees only the discovery request', async () => {
    vm.serve(otherTls);

    await expect(add(certificateFingerprint(fixtureTls.cert))).rejects.toMatchObject({
      details: { code: 'REMOTE_TLS_FINGERPRINT_MISMATCH' },
    });

    expect(vm.seen).toEqual([
      { method: 'GET', path: '/api/runtime', authorization: undefined, body: '' },
    ]);
    expect(storage.createRemote).not.toHaveBeenCalled();
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('never sends the key when another certificate answers after discovery', async () => {
    const discover = RemoteHostClient.prototype.discoverRuntime;
    jest.spyOn(RemoteHostClient.prototype, 'discoverRuntime').mockImplementation(async function (
      this: RemoteHostClient,
      origin: string,
    ) {
      const answer = await discover.call(this, origin);
      vm.serve(otherTls);
      return answer;
    });

    await expect(add(certificateFingerprint(fixtureTls.cert))).rejects.toMatchObject({
      code: 'HOST_API_KEY_REQUEST_FAILED',
    });

    expect(vm.seen.map((request) => request.authorization)).toEqual([undefined]);
    expect(storage.createRemote).not.toHaveBeenCalled();
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('fails with a clear error when nothing answers at the address', async () => {
    await vm.close();

    await expect(add(certificateFingerprint(fixtureTls.cert))).rejects.toMatchObject({
      code: 'REMOTE_UNREACHABLE',
      message: `Nothing answers over HTTPS at ${vm.baseUrl}. Start the VM, then check the address.`,
    });
    expect(storage.createRemote).not.toHaveBeenCalled();
  });
});
