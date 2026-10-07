import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { RemoteApiKeyService } from './remote-api-key.service';
import { RemoteApiKeyManagementService } from './remote-api-key-management.service';
import { RemoteHealthService } from '../services/remote-health.service';
import { remoteFetch } from '../transport/remote-tls';

jest.mock('../transport/remote-tls', () => ({
  ...jest.requireActual('../transport/remote-tls'),
  remoteFetch: jest.fn(),
}));

const key = `dck_${'a'.repeat(43)}`;
// Unit transport fakes let us prove write order and refusal paths without making a VM.
describe('Remote API key changes', () => {
  let service: RemoteApiKeyManagementService;
  let keys: { save: jest.Mock; headers: jest.Mock };
  let health: { getState: jest.Mock; refresh: jest.Mock; rejectApiKey: jest.Mock };
  let fetchMock: jest.MockedFunction<typeof remoteFetch>;
  let remote: { id: string; name: string; baseUrl: string; tlsCertificate: string | null };
  beforeEach(async () => {
    remote = { id: 'vm', name: 'vm', baseUrl: 'https://vm', tlsCertificate: fixtureTls.cert };
    keys = {
      save: jest.fn().mockResolvedValue(undefined),
      headers: jest.fn().mockResolvedValue({ authorization: `Bearer ${key}` }),
    };
    health = {
      getState: jest.fn().mockReturnValue({ online: true, apiKeyRejected: false }),
      refresh: jest.fn().mockResolvedValue({ online: true }),
      rejectApiKey: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        RemoteApiKeyManagementService,
        {
          provide: STORAGE_SERVICE,
          useValue: { getRemote: async () => remote },
        },
        { provide: RemoteApiKeyService, useValue: keys },
        { provide: RemoteHealthService, useValue: health },
      ],
    }).compile();
    service = module.get(RemoteApiKeyManagementService);
    fetchMock = jest.mocked(remoteFetch);
    fetchMock.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a keyless registration when the address does not answer over the pinned connection', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    await expect(service.validate('https://vm', fixtureTls.cert)).rejects.toMatchObject({
      code: 'HOST_API_KEY_REQUEST_FAILED',
    });
  });

  it('checks a keyless registration without an Authorization header, pinned to the certificate', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await service.validate('https://vm', fixtureTls.cert);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vm/api/host/stats',
      expect.objectContaining({ headers: {} }),
      fixtureTls.cert,
    );
  });

  it('refuses to enter or reset a key for a remote without a certificate', async () => {
    remote.tlsCertificate = null;
    await expect(service.enter('vm', key)).rejects.toMatchObject({
      message: expect.stringContaining('Add the VM again or reset it'),
      details: { code: 'REMOTE_TLS_CERTIFICATE_MISSING' },
    });
    await expect(service.reset('vm')).rejects.toMatchObject({
      details: { code: 'REMOTE_TLS_CERTIFICATE_MISSING' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('requires a key when a keyless stats check returns the explicit host rejection', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'HOST_API_KEY_REJECTED' }), { status: 401 }),
    );
    await expect(service.validate('https://vm', fixtureTls.cert)).rejects.toMatchObject({
      code: 'HOST_API_KEY_REJECTED',
      statusCode: 401,
    });
  });

  it.each([
    [404, '{}'],
    [401, '{}'],
    [401, 'not-json'],
  ])('allows keyless registration for a non-host response %s/%s', async (status, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status }));
    await expect(service.validate('https://vm', fixtureTls.cert)).resolves.toBeUndefined();
  });

  it.each([401, 404])('still refuses a supplied key when stats answers %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(service.validate('https://vm', fixtureTls.cert, key)).rejects.toThrow();
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('tests an entered key on the direct protected stats route before saving and polling', async () => {
    fetchMock.mockImplementation(async () => {
      expect(keys.save).not.toHaveBeenCalled();
      return new Response('{}');
    });
    await service.enter('vm', key);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vm/api/host/stats',
      expect.objectContaining({ headers: { authorization: `Bearer ${key}` } }),
      fixtureTls.cert,
    );
    expect(keys.save).toHaveBeenCalledWith('vm', key);
    expect(health.refresh).toHaveBeenCalledWith('vm');
  });

  it('never saves a refused candidate', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(service.enter('vm', key)).rejects.toThrow('The VM refused this key.');
    expect(keys.save).not.toHaveBeenCalled();
    expect(health.refresh).not.toHaveBeenCalled();
  });

  it('sends only the new hash with the current bearer and saves only after 204', async () => {
    fetchMock.mockImplementation(async () => {
      expect(keys.save).not.toHaveBeenCalled();
      return new Response(null, { status: 204 });
    });
    await service.reset('vm');
    const newKey = keys.save.mock.calls[0][1] as string;
    expect(newKey).toMatch(/^dck_[A-Za-z0-9_-]{43}$/);
    expect(newKey).not.toBe(key);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vm/api/host/api-key',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: createHash('sha256').update(newKey).digest('hex') }),
      }),
      fixtureTls.cert,
    );
    expect(health.refresh).toHaveBeenCalledWith('vm');
  });

  it.each([400, 401])('keeps the old key if the VM refuses reset with %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(service.reset('vm')).rejects.toThrow('The VM could not reset its API key.');
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('publishes rejected state and a safe recovery error if home save fails after VM applied the hash', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    keys.save.mockRejectedValue(new Error(`secret ${key}`));
    await expect(service.reset('vm')).rejects.toThrow('Run devchain host api-key reset');
    expect(health.rejectApiKey).toHaveBeenCalledWith('vm');
    expect(health.refresh).not.toHaveBeenCalled();
  });

  it('sanitizes transport failures and does not forward the bearer to redirects', async () => {
    fetchMock.mockRejectedValue(new Error(`secret ${key}`));
    await expect(service.enter('vm', key)).rejects.toThrow('Could not reach the VM');
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('refuses reset while the known key is rejected', async () => {
    health.getState.mockReturnValue({ online: true, apiKeyRejected: true });
    await expect(service.reset('vm')).rejects.toThrow('accepted API key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
