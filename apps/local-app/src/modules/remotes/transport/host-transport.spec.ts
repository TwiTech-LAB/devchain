import { Readable } from 'node:stream';
import { z } from 'zod';
import { SCAN_TIMEOUT_MS } from '../../file-sync/file-sync.dto';
import { hostRoutes } from '../contract/host-routes';
import type { HostRoute } from '../contract/host-routes';
import { RemoteHostRequestError, send } from './host-transport';
import type { HostTarget } from './host-transport';
import { remoteFetch } from './remote-tls';

jest.mock('./remote-tls', () => ({ remoteFetch: jest.fn() }));
const fetchMock = jest.mocked(remoteFetch);
const target: HostTarget = {
  baseUrl: 'https://host.test///',
  certificate: 'pinned-certificate',
  apiKey: 'vm-key',
  label: 'Remote "vm"',
  remoteId: 'remote-1',
};
const route = {
  method: 'POST',
  path: ({ id }: { id: string }) => `/answer/${encodeURIComponent(id)}?full=true`,
  body: z.object({ value: z.string() }),
  timeoutMs: 1000,
  statuses: {
    200: z.object({ answer: z.string() }),
    202: 'none',
    204: 'none',
    409: 'error-code',
  },
} as const satisfies HostRoute;
const params = { id: 'a/b' };

/** Stubs the network seam to hang until the request's signal aborts; returns that signal once seen. */
function hangUntilAborted(): () => AbortSignal | undefined {
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementation((_url, init) => {
    signal = init.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  return () => signal;
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// A stub of the network seam is the cheapest way to observe URL, TLS and wire serialization together.
it.each([undefined, 'application/vnd.example+json'])(
  'joins the URL, pins TLS and serializes JSON with content type %p',
  async (contentType) => {
    fetchMock.mockResolvedValue(new Response('{"answer":"ok"}'));
    await expect(
      send(target, { ...route, contentType }, params, { body: { value: 'input' } }),
    ).resolves.toEqual({ status: 200, body: { answer: 'ok' } });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://host.test/answer/a%2Fb?full=true',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer vm-key',
          'content-type': contentType ?? 'application/json',
        },
        body: '{"value":"input"}',
        signal: expect.any(AbortSignal),
      },
      'pinned-certificate',
    );
    expect(jest.getTimerCount()).toBe(0);
  },
);

// Transport unit timers exercise the request budget without network latency or wall-clock waits.
async function expectAbortAfter(budget: number, start: () => Promise<unknown>): Promise<void> {
  const signal = hangUntilAborted();
  const rejected = expect(start()).rejects.toMatchObject({
    message: 'Remote "vm" is unreachable: aborted',
    status: null,
  });
  await jest.advanceTimersByTimeAsync(budget - 1);
  expect(signal()?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await rejected;
  expect(signal()?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
}

it.each([
  { name: 'route default', override: undefined, budget: 1000 },
  { name: 'call override', override: 250, budget: 250 },
])('aborts at the $name timeout', ({ override, budget }) =>
  expectAbortAfter(budget, () => send(target, route, params, { timeoutMs: override })),
);

// The budget is pinned to the Syncthing scan bound plus the control allowance, not read from the contract.
it('aborts at the long host scan timeout', () =>
  expectAbortAfter(SCAN_TIMEOUT_MS + 15_000, () =>
    send(target, hostRoutes.syncScan, { folderId: 'code:p1' }),
  ));

// Transport unit response timing is the cheapest layer that catches a timer cleared after headers.
it('keeps the timeout active while parsing a response', async () => {
  let signal: AbortSignal | undefined;
  const cancel = jest.fn(async () => undefined);
  fetchMock.mockImplementation(async (_url, init) => {
    signal = init.signal ?? undefined;
    return {
      status: 200,
      body: { cancel },
      json: () =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('body timed out')), {
            once: true,
          });
        }),
    } as unknown as Response;
  });
  const request = send(target, route, params);
  const rejected = expect(request).rejects.toMatchObject({
    message: 'Host returned an invalid answer to /answer/a%2Fb.',
    status: 200,
  });
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

// The transport owns signal composition; a stubbed fetch observes cancellation without a real host.
const abortedByCaller = {
  code: 'REMOTE_HOST_REQUEST_FAILED',
  details: { remoteId: 'remote-1', status: null },
};

it('aborts on an external signal before send', async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  hangUntilAborted();
  controller.abort();
  await expect(send(target, route, params, { signal: controller.signal })).rejects.toMatchObject(
    abortedByCaller,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(jest.getTimerCount()).toBe(0);
});

it('aborts on an external signal in flight', async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  const signal = hangUntilAborted();
  const rejected = expect(
    send(target, route, params, { signal: controller.signal }),
  ).rejects.toMatchObject(abortedByCaller);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  expect(signal()?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(jest.getTimerCount()).toBe(0);
});

// A rejected network seam proves reachability error details without a nondeterministic closed port.
it.each([new Error('connection refused'), 'connection refused'])(
  'wraps an unreachable host failure %p',
  async (failure) => {
    fetchMock.mockRejectedValue(failure);
    const request = send({ ...target, remoteId: undefined }, route, params);
    await expect(request).rejects.toBeInstanceOf(RemoteHostRequestError);
    await expect(request).rejects.toMatchObject({
      message: 'Remote "vm" is unreachable: connection refused',
      details: {
        remoteId: target.baseUrl,
        path: '/answer/a%2Fb?full=true',
        status: null,
        hostCode: null,
      },
    });
    expect(jest.getTimerCount()).toBe(0);
  },
);

// Response policy lives in the transport, so unit responses are sufficient for host-code precedence.
it.each([
  { payload: '{"code":"rejected"}', code: 'rejected' },
  { payload: '{"code":"CONFLICT","details":{"code":"rejected"}}', code: 'rejected' },
  { payload: 'not json', code: null },
])('rejects an unaccepted status with host code $code', async ({ payload, code }) => {
  fetchMock.mockResolvedValue(new Response(payload, { status: 400 }));
  await expect(send(target, route, params)).rejects.toMatchObject({
    message: `Remote "vm" answered 400 to POST /answer/a%2Fb${code ? ` (${code})` : ''}.`,
    details: { remoteId: 'remote-1', path: '/answer/a%2Fb?full=true', status: 400, hostCode: code },
  });
});

// A generic route map isolates message selection; the client spec owns the Docker migration contract.
it('uses a route host-code message while retaining its code', async () => {
  fetchMock.mockResolvedValue(new Response('{"details":{"code":"NEEDS_ACTION"}}', { status: 400 }));
  await expect(
    send(target, { ...route, hostCodes: { NEEDS_ACTION: 'Take action on the host.' } }, params),
  ).rejects.toMatchObject({
    message: 'Take action on the host.',
    details: { hostCode: 'NEEDS_ACTION' },
  });
});

// Transport parsing is the cheapest layer for schema and malformed-JSON error normalization.
it.each(['{"answer":7}', 'not json'])('rejects an invalid schema body %s', async (payload) => {
  fetchMock.mockResolvedValue(new Response(payload));
  await expect(send(target, route, params)).rejects.toMatchObject({
    message: 'Host returned an invalid answer to /answer/a%2Fb.',
    details: { remoteId: 'remote-1', path: '/answer/a%2Fb?full=true', status: 200, hostCode: null },
  });
});

// Unit responses exercise per-status decoding directly; no client-specific outcome is involved.
it.each([
  { status: 204, payload: null, expected: undefined },
  {
    status: 409,
    payload: '{"code":"CONFLICT","details":{"code":"ALREADY_EXISTS"}}',
    expected: 'ALREADY_EXISTS',
  },
  { status: 409, payload: 'not json', expected: null },
])('decodes status $status as $expected', async ({ status, payload, expected }) => {
  fetchMock.mockResolvedValue(new Response(payload, { status }));
  await expect(send(target, route, params)).resolves.toEqual({ status, body: expected });
});

// The transport owns pooled response lifetimes; inspecting a real Response avoids mocking consumption.
function stubResponse(status: number, payload: string) {
  const response = new Response(payload, { status });
  const cancel = jest.spyOn(response.body!, 'cancel');
  fetchMock.mockResolvedValue(response);
  return { response, cancel };
}

function expectReleased(response: Response, cancel: jest.SpyInstance): void {
  expect(response.bodyUsed).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
}

it.each([
  { name: 'schema success', status: 200, payload: '{"answer":"ok"}' },
  { name: 'error code', status: 409, payload: '{"code":"CONFLICT"}' },
  { name: 'ignored body', status: 202, payload: 'unread body' },
])('releases the response after $name', async ({ status, payload }) => {
  const { response, cancel } = stubResponse(status, payload);
  await send(target, route, params);
  expectReleased(response, cancel);
});

it.each([
  { name: 'invalid schema', status: 200, payload: '{}' },
  { name: 'invalid JSON', status: 200, payload: 'not json' },
  { name: 'unaccepted status', status: 400, payload: '{"code":"refused"}' },
  { name: 'unaccepted non-JSON', status: 400, payload: 'not json' },
])('releases the response after $name', async ({ status, payload }) => {
  const { response, cancel } = stubResponse(status, payload);
  await expect(send(target, route, params)).rejects.toBeInstanceOf(RemoteHostRequestError);
  expectReleased(response, cancel);
});

// The network seam exposes duplex and body identity, the cheapest reliable test for streamed uploads.
it('sends a Readable body with duplex half and the route content type', async () => {
  const stream = Readable.from(['archive']);
  fetchMock.mockResolvedValue(new Response('{"name":"source","contentHash":"hash"}'));
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  try {
    await expect(
      send(
        target,
        hostRoutes.uploadSkillSourceContent,
        { name: 'source', contentHash: 'hash' },
        { body: stream, signal: controller.signal },
      ),
    ).resolves.toEqual({
      status: 200,
      body: { name: 'source', contentHash: 'hash' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://host.test/api/host/skill-settings/local-sources/source/content?contentHash=hash',
      expect.objectContaining({
        body: stream,
        duplex: 'half',
        headers: {
          authorization: 'Bearer vm-key',
          'content-type': 'application/x-tar',
        },
      }),
      target.certificate,
    );
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    stream.destroy();
  }
});
