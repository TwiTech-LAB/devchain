import { RemoteApiKeyService } from '../auth/remote-api-key.service';
/** Unit layer controls header/body timing to verify request budgets and upload cancellation without wall-clock waits. */
import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { RemoteHostClient } from './remote-host.client';

jest.mock('../transport/remote-tls', () => ({
  ...jest.requireActual('../transport/remote-tls'),
  remoteFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

describe('skill settings client budgets', () => {
  let client: RemoteHostClient;
  let apiKeys: RemoteApiKeyService;
  beforeEach(async () => {
    jest.useFakeTimers();
    let key = 'first';
    const module = await Test.createTestingModule({
      providers: [
        RemoteApiKeyService,
        RemoteHostClient,
        {
          provide: STORAGE_SERVICE,
          useValue: {
            getRemote: async () => ({
              id: 'remote',
              name: 'host',
              baseUrl: 'https://host.test',
              tlsCertificate: fixtureTls.cert,
            }),
            readRemoteApiKey: async () => key,
            saveRemoteApiKey: async (_id: string, value: string) => {
              key = value;
            },
          },
        },
      ],
    }).compile();
    client = module.get(RemoteHostClient);
    apiKeys = module.get(RemoteApiKeyService);
  });
  it('authenticates settings requests after each saved key', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 503 }));
    for (const key of ['first', 'replacement']) {
      await apiKeys.save('remote', key);
      await expect(client.getSkillSettingsStatus('remote')).rejects.toThrow();
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { authorization: `Bearer ${key}` } }),
      );
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps the status budget active through response body parsing', async () => {
    let signal: AbortSignal | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return {
        status: 200,
        body: null,
        json: () =>
          new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
          ),
      } as Response;
    });
    const request = client.getSkillSettingsStatus('remote');
    const rejected = expect(request).rejects.toThrow('invalid answer');
    await jest.advanceTimersByTimeAsync(2999);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'cancel'])(
    'uses a separate upload budget and destroys the stream on %s',
    async (mode) => {
      let signal: AbortSignal | undefined;
      jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      });
      const stream = Readable.from(['archive']);
      const controller = new AbortController();
      const request = client.uploadSkillSourceContent(
        'remote',
        'source',
        'hash',
        stream,
        controller.signal,
      );
      const rejected = expect(request).rejects.toThrow('aborted');
      await jest.advanceTimersByTimeAsync(3000);
      expect(signal?.aborted).toBe(false);
      if (mode === 'cancel') controller.abort();
      else await jest.advanceTimersByTimeAsync(57_000);
      await rejected;
      expect(stream.destroyed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
