import { RemoteApiKeyService } from '../auth/remote-api-key.service';
// Unit layer controls the response-body completion independently of headers to prove timeout lifetime.
import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { TranscriptFilesService } from '../transcripts/transcript-files.service';
import { TRANSCRIPT_TIMEOUT_MS, type TranscriptFile } from '../transcripts/transcript-transfer.dto';
import { RemoteHostClient } from './remote-host.client';

jest.mock('../transport/remote-tls', () => ({
  ...jest.requireActual('../transport/remote-tls'),
  remoteFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const file: TranscriptFile = { provider: 'codex', path: '2026/09/26/rollout-test.jsonl' };

describe('RemoteHostClient transcript cancellation', () => {
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
  it('authenticates transcript upload and download after each saved key', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const files = {
      read: async () => ({ stream: Readable.from(['x']), size: 1 }),
      write: async (_file: unknown, stream: Readable) => {
        for await (const chunk of stream) void chunk;
      },
    } as unknown as TranscriptFilesService;
    for (const key of ['first', 'replacement']) {
      await apiKeys.save('remote', key);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await client.uploadTranscript('remote', file, files);
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer ${key}`,
            'content-length': '1',
          }),
        }),
      );
      fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': '1' } }));
      await client.downloadTranscript('remote', file, files);
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

  it.each(['timeout', 'cancellation'])(
    'keeps %s active after download headers until the disk write finishes',
    async (reason) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('x', { headers: { 'content-length': '1' } }));
      let started!: () => void;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const files = {
        write: jest.fn(async (_file, body: Readable, _size, signal: AbortSignal) => {
          body.resume();
          started();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        }),
      } as unknown as TranscriptFilesService;
      const abort = new AbortController();
      const transfer = client.downloadTranscript('remote', file, files, abort.signal);
      const rejected = expect(transfer).rejects.toThrow('aborted');
      await writing;
      if (reason === 'timeout') jest.advanceTimersByTime(TRANSCRIPT_TIMEOUT_MS);
      else abort.abort();
      await rejected;
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
