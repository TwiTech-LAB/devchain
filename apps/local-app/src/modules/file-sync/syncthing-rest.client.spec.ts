import { Agent, Response, fetch } from 'undici';
import { SyncthingRestError, SyncthingRestClient } from './syncthing-rest.client';

// Pure unit: only the abort and error wiring of one REST call is under test, so a
// stubbed undici fetch that mirrors the real one's signal behavior is cheaper than
// a Syncthing daemon and still proves which error the caller sees. The real fetch
// and dispatcher run in syncthing-rest.client.integration.spec.ts.
jest.mock('undici', () => ({ ...jest.requireActual('undici'), fetch: jest.fn() }));

const fetchMock = fetch as jest.MockedFunction<typeof fetch>;

/** A fetch whose pending request rejects with the signal reason, like undici. */
function abortWithSignalReason(_url: unknown, init?: { signal?: AbortSignal | null }) {
  return new Promise<never>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

afterEach(() => fetchMock.mockReset());

describe('SyncthingRestClient.request abort handling', () => {
  it('throws the outside signal reason, not an unreachable report, when it fires', async () => {
    fetchMock.mockImplementation(abortWithSignalReason as unknown as typeof fetch);
    const client = new SyncthingRestClient('http://127.0.0.1:8384', 'key');
    const controller = new AbortController();
    const pending = client
      .request('POST', '/rest/db/scan?folder=code%3Ap1', undefined, 10 * 60_000, controller.signal)
      .catch((error: unknown) => error);
    const reason = new Error('The Connect was cancelled.');
    controller.abort(reason);

    expect(await pending).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports Syncthing unreachable with the fetch cause chain when a call fails', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8384'), {
      code: 'ECONNREFUSED',
    });
    fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: refused }));
    const client = new SyncthingRestClient('http://127.0.0.1:8384', 'key');

    const error: unknown = await client
      .request('GET', '/rest/system/ping')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SyncthingRestError);
    expect(error).toMatchObject({
      code: 'SYNCTHING_REST_FAILED',
      message:
        'Syncthing is unreachable (GET /rest/system/ping): fetch failed <= ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8384',
    });
  });

  it("passes the client's undici Agent as the dispatcher", async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    const client = new SyncthingRestClient('http://127.0.0.1:8384', 'key');

    await client.request('POST', '/rest/db/scan?folder=code%3Ap1');

    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeInstanceOf(Agent);
  });
});
