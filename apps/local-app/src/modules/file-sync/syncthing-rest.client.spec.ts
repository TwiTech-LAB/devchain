import { SyncthingRestError, SyncthingRestClient } from './syncthing-rest.client';

// Pure unit: only the abort wiring of one REST call is under test, so a stubbed
// fetch that mirrors the real one's signal behavior is cheaper than a Syncthing
// daemon and still proves which error the caller sees.

/** A fetch whose pending request rejects with the signal reason, like undici. */
function fetchAbortingWithSignalReason(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
        once: true,
      });
    })) as unknown as typeof fetch;
}

describe('SyncthingRestClient.request abort handling', () => {
  it('throws the outside signal reason, not an unreachable report, when it fires', async () => {
    const original = globalThis.fetch;
    const fetchMock = jest.fn(fetchAbortingWithSignalReason());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new SyncthingRestClient('http://127.0.0.1:8384', 'key');
      const controller = new AbortController();
      const pending = client
        .request(
          'POST',
          '/rest/db/scan?folder=code%3Ap1',
          undefined,
          10 * 60_000,
          controller.signal,
        )
        .catch((error: unknown) => error);
      const reason = new Error('The Connect was cancelled.');
      controller.abort(reason);

      expect(await pending).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('behaves as before without a signal: a failed call reports Syncthing unreachable', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('socket hang up'));
    try {
      const client = new SyncthingRestClient('http://127.0.0.1:8384', 'key');

      const error: unknown = await client
        .request('GET', '/rest/system/ping')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SyncthingRestError);
      expect(error).toMatchObject({
        code: 'SYNCTHING_REST_FAILED',
        message: expect.stringContaining('Syncthing is unreachable (GET /rest/system/ping)'),
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
