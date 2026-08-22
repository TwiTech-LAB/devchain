import { SafeVendorHttpClient, SafeVendorHttpError } from './safe-vendor-http-client';

const ALLOWED_ORIGIN = 'https://api.clickup.com';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('SafeVendorHttpClient', () => {
  it('rejects non-HTTPS, credentialed, IP, and non-allowlisted destinations before fetch', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const client = new SafeVendorHttpClient({ fetchImpl });

    for (const url of [
      'http://api.clickup.com/api/v2/user',
      'https://token@api.clickup.com/api/v2/user',
      'https://127.0.0.1/api/v2/user',
      'https://example.com/api/v2/user',
    ]) {
      await expect(
        client.requestJson({ url, allowedOrigins: [ALLOWED_ORIGIN] }),
      ).rejects.toMatchObject<SafeVendorHttpError>({ reason: 'unsafe_url' });
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects redirects and disposes their response body', async () => {
    const response = new Response('redirect body', {
      status: 302,
      headers: { location: 'https://example.com/secret' },
    });
    const cancel = jest.spyOn(response.body!, 'cancel');
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => response) as typeof fetch,
    });

    await expect(
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/user`,
        allowedOrigins: [ALLOWED_ORIGIN],
      }),
    ).rejects.toMatchObject<SafeVendorHttpError>({ reason: 'redirect_rejected' });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('times out the complete request with a sanitized error', async () => {
    const fetchImpl = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('contains-sensitive-vendor-detail', 'AbortError'));
        });
      });
    }) as typeof fetch;
    const client = new SafeVendorHttpClient({ fetchImpl, defaultTimeoutMs: 10 });

    const promise = client.requestJson({
      url: `${ALLOWED_ORIGIN}/api/v2/user`,
      allowedOrigins: [ALLOWED_ORIGIN],
    });

    await expect(promise).rejects.toMatchObject<SafeVendorHttpError>({ reason: 'timeout' });
    await expect(promise).rejects.not.toThrow('contains-sensitive-vendor-detail');
  });

  it('bounds streamed decompressed bytes instead of trusting Content-Length', async () => {
    const response = new Response('0123456789abcdef', {
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
        'content-encoding': 'gzip',
      },
    });
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => response) as typeof fetch,
      defaultMaxResponseBytes: 8,
    });

    await expect(
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/user`,
        allowedOrigins: [ALLOWED_ORIGIN],
      }),
    ).rejects.toMatchObject<SafeVendorHttpError>({ reason: 'response_too_large' });
  });

  it('disposes non-success bodies without exposing them in the error', async () => {
    const response = new Response('vendor-secret-body', { status: 401 });
    const cancel = jest.spyOn(response.body!, 'cancel');
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => response) as typeof fetch,
    });

    const promise = client.requestJson({
      url: `${ALLOWED_ORIGIN}/api/v2/user`,
      allowedOrigins: [ALLOWED_ORIGIN],
    });

    await expect(promise).rejects.toMatchObject<SafeVendorHttpError>({
      reason: 'http_error',
      upstreamStatus: 401,
    });
    await expect(promise).rejects.not.toThrow('vendor-secret-body');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('normalizes a valid upstream rate-limit reset header into safe retry guidance', async () => {
    const response = new Response('{}', {
      status: 429,
      headers: { 'x-ratelimit-reset': '2000000000' },
    });
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => response) as typeof fetch,
    });

    await expect(
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/user`,
        allowedOrigins: [ALLOWED_ORIGIN],
      }),
    ).rejects.toMatchObject<SafeVendorHttpError>({
      reason: 'http_error',
      upstreamStatus: 429,
      retryAt: '2033-05-18T03:33:20.000Z',
    });
  });

  it('normalizes Jira Retry-After seconds and prefers them over vendor reset headers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const response = new Response('{}', {
      status: 429,
      headers: { 'retry-after': '5', 'x-ratelimit-reset': '2000000000' },
    });
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => response) as typeof fetch,
    });

    await expect(
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/user`,
        allowedOrigins: [ALLOWED_ORIGIN],
      }),
    ).rejects.toMatchObject<SafeVendorHttpError>({
      reason: 'http_error',
      upstreamStatus: 429,
      retryAt: '2026-08-19T12:00:05.000Z',
    });
    jest.useRealTimers();
  });

  it('limits active requests and rejects when the bounded queue is full', async () => {
    const pending: Array<(response: Response) => void> = [];
    let active = 0;
    let peakActive = 0;
    const fetchImpl = jest.fn(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      const response = await new Promise<Response>((resolve) => pending.push(resolve));
      active -= 1;
      return response;
    }) as typeof fetch;
    const client = new SafeVendorHttpClient({
      fetchImpl,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
    });
    const request = () =>
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/user`,
        allowedOrigins: [ALLOWED_ORIGIN],
      });

    const first = request();
    const second = request();
    await expect(request()).rejects.toMatchObject<SafeVendorHttpError>({
      reason: 'concurrency_limit',
    });

    pending.shift()!(jsonResponse({ first: true }));
    await expect(first).resolves.toEqual({ first: true });
    await new Promise((resolve) => setImmediate(resolve));
    pending.shift()!(jsonResponse({ second: true }));
    await expect(second).resolves.toEqual({ second: true });
    expect(peakActive).toBe(1);
  });

  it('returns parsed JSON for an exact allowlisted origin', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: true })) as typeof fetch;
    const client = new SafeVendorHttpClient({ fetchImpl });

    await expect(
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/user`,
        allowedOrigins: [ALLOWED_ORIGIN],
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ALLOWED_ORIGIN}/api/v2/user`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }),
    );
  });

  it('accepts only an explicit 204 through the no-content response contract', async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const client = new SafeVendorHttpClient({ fetchImpl });

    await expect(
      client.requestNoContent({
        url: `${ALLOWED_ORIGIN}/api/v2/task/task-1/status`,
        allowedOrigins: [ALLOWED_ORIGIN],
        method: 'POST',
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps JSON requests fail-closed for a real 204 response', async () => {
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    });

    await expect(
      client.requestJson({
        url: `${ALLOWED_ORIGIN}/api/v2/task/task-1/status`,
        allowedOrigins: [ALLOWED_ORIGIN],
        method: 'POST',
      }),
    ).rejects.toMatchObject<SafeVendorHttpError>({ reason: 'invalid_response' });
  });

  it.each([
    ['JSON success body', () => jsonResponse({ vendorSecret: 'must-not-leak' })],
    ['empty 200 success', () => new Response(null, { status: 200 })],
    [
      '204 with an advertised body',
      () => new Response(null, { status: 204, headers: { 'content-length': '1' } }),
    ],
  ])('rejects and safely disposes an unexpected no-content %s', async (_case, responseFactory) => {
    const response = responseFactory();
    const cancel = response.body ? jest.spyOn(response.body, 'cancel') : null;
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(async () => response) as typeof fetch,
    });

    const promise = client.requestNoContent({
      url: `${ALLOWED_ORIGIN}/api/v2/task/task-1/status`,
      allowedOrigins: [ALLOWED_ORIGIN],
      method: 'POST',
    });
    await expect(promise).rejects.toMatchObject<SafeVendorHttpError>({
      reason: 'invalid_response',
    });
    await expect(promise).rejects.not.toThrow('must-not-leak');
    if (cancel) expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves safe rate-limit metadata on the no-content request path', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const client = new SafeVendorHttpClient({
      fetchImpl: jest.fn(
        async () =>
          new Response('private vendor response', {
            status: 429,
            headers: { 'retry-after': '5' },
          }),
      ) as typeof fetch,
    });

    await expect(
      client.requestNoContent({
        url: `${ALLOWED_ORIGIN}/api/v2/task/task-1/status`,
        allowedOrigins: [ALLOWED_ORIGIN],
        method: 'POST',
      }),
    ).rejects.toMatchObject<SafeVendorHttpError>({
      reason: 'http_error',
      upstreamStatus: 429,
      retryAt: '2026-08-19T12:00:05.000Z',
    });
    jest.useRealTimers();
  });

  describe('dispatched outcome classification', () => {
    it('marks a timeout during fetch as dispatched', async () => {
      const fetchImpl = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }) as typeof fetch;
      const client = new SafeVendorHttpClient({ fetchImpl, defaultTimeoutMs: 10 });

      const error = await client
        .requestJson({ url: `${ALLOWED_ORIGIN}/api/v2/task/x`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(error).toBeInstanceOf(SafeVendorHttpError);
      expect(error.reason).toBe('timeout');
      expect(error.dispatched).toBe(true);
    });

    it('marks a network failure during fetch as dispatched', async () => {
      const client = new SafeVendorHttpClient({
        fetchImpl: jest.fn(async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
      });
      const error = await client
        .requestJson({ url: `${ALLOWED_ORIGIN}/api/v2/task/x`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(error.reason).toBe('network_error');
      expect(error.dispatched).toBe(true);
    });

    it('marks a 5xx as dispatched but a 4xx as not dispatched', async () => {
      const serverError = new Response('boom', { status: 503 });
      const clientError = new Response('nope', { status: 400 });
      const responses = [serverError, clientError];
      let call = 0;
      const client = new SafeVendorHttpClient({
        fetchImpl: jest.fn(async () => responses[call++]!) as typeof fetch,
      });

      const fiveHundred = await client
        .requestJson({ url: `${ALLOWED_ORIGIN}/x`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(fiveHundred.reason).toBe('http_error');
      expect(fiveHundred.upstreamStatus).toBe(503);
      expect(fiveHundred.dispatched).toBe(true);

      const fourHundred = await client
        .requestJson({ url: `${ALLOWED_ORIGIN}/x`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(fourHundred.upstreamStatus).toBe(400);
      expect(fourHundred.dispatched).toBe(false);
    });

    it('marks pre-dispatch failures (unsafe URL, queue admission) as not dispatched', async () => {
      const client = new SafeVendorHttpClient({ fetchImpl: jest.fn() as unknown as typeof fetch });
      const unsafe = await client
        .requestJson({ url: 'https://evil.example.com/x', allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(unsafe.reason).toBe('unsafe_url');
      expect(unsafe.dispatched).toBe(false);

      // One held request plus one queued request saturate a 1+1 admission
      // budget; the third request is rejected before any fetch starts.
      const deferreds: Array<(response: Response) => void> = [];
      const queuedClient = new SafeVendorHttpClient({
        fetchImpl: (() => {
          let call = 0;
          return () =>
            new Promise<Response>((resolve) => {
              deferreds[call] = resolve;
              call += 1;
            });
        })() as typeof fetch,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 1,
      });
      const first = queuedClient.requestJson({
        url: `${ALLOWED_ORIGIN}/one`,
        allowedOrigins: [ALLOWED_ORIGIN],
      });
      const second = queuedClient.requestJson({
        url: `${ALLOWED_ORIGIN}/two`,
        allowedOrigins: [ALLOWED_ORIGIN],
      });
      await Promise.resolve();
      const rejected = await queuedClient
        .requestJson({ url: `${ALLOWED_ORIGIN}/three`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(rejected.reason).toBe('concurrency_limit');
      expect(rejected.dispatched).toBe(false);
      deferreds[0]!(jsonResponse({ done: true }));
      await first;
      deferreds[1]!(jsonResponse({ done: true }));
      await second;
    });

    it('upgrades post-fetch response failures to dispatched', async () => {
      // A garbled 200 body arrives after the vendor already saw the request;
      // the mutation outcome is unknown, so dispatched must be true.
      const garbled = new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const wrongType = new Response('plain', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
      const responses = [garbled, wrongType];
      let call = 0;
      const client = new SafeVendorHttpClient({
        fetchImpl: jest.fn(async () => responses[call++]!) as typeof fetch,
      });

      const parseFailure = await client
        .requestJson({ url: `${ALLOWED_ORIGIN}/x`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(parseFailure.reason).toBe('invalid_response');
      expect(parseFailure.dispatched).toBe(true);

      const typeFailure = await client
        .requestJson({ url: `${ALLOWED_ORIGIN}/x`, allowedOrigins: [ALLOWED_ORIGIN] })
        .catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(typeFailure.reason).toBe('invalid_response');
      expect(typeFailure.dispatched).toBe(true);
    });

    it('keeps a queue-wait timeout not dispatched', async () => {
      // The queued request never reaches fetchImpl before its own abort, so
      // the classification must stay pre-dispatch.
      let releaseFirst: ((response: Response) => void) | undefined;
      const client = new SafeVendorHttpClient({
        fetchImpl: (() =>
          new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          })) as unknown as typeof fetch,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 1,
        defaultTimeoutMs: 10,
      });
      const first = client.requestJson({
        url: `${ALLOWED_ORIGIN}/one`,
        allowedOrigins: [ALLOWED_ORIGIN],
      });
      const queued = client.requestJson({
        url: `${ALLOWED_ORIGIN}/two`,
        allowedOrigins: [ALLOWED_ORIGIN],
      });
      const error = await queued.catch((reason: unknown) => reason as SafeVendorHttpError);
      expect(error.reason).toBe('timeout');
      expect(error.dispatched).toBe(false);
      releaseFirst!(jsonResponse({ done: true }));
      await first;
    });
  });
});
