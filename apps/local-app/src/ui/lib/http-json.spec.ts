import {
  fetchJsonOrThrow,
  fetchOrThrow,
  fetchJsonWithMessageOrThrow,
  SessionApiError,
} from './http-json';
import { SessionApiError as ReexportedSessionApiError } from './sessions';
import type { FetchFn } from './api-transport';

// Helper unit tests exercise response policies without component or backend setup.

const globalFetch = (input: RequestInfo | URL, init?: RequestInit) => global.fetch(input, init);

describe('ui/lib/http-json', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
    jest.clearAllMocks();
  });

  describe('fetchJsonOrThrow', () => {
    it('returns parsed JSON on success', async () => {
      const mockData = { id: 'test-id', name: 'Test' };
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => mockData,
      }));

      const result = await fetchJsonOrThrow<typeof mockData>(
        '/api/test',
        undefined,
        undefined,
        globalFetch,
      );
      expect(result).toEqual(mockData);
    });

    it('throws the typed server error with message and status', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ message: 'Bad request from server' }),
      }));

      await expect(
        fetchJsonOrThrow('/api/test', {}, 'Fallback error', globalFetch),
      ).rejects.toThrow(SessionApiError);
      await expect(
        fetchJsonOrThrow('/api/test', {}, 'Fallback error', globalFetch),
      ).rejects.toThrow('Bad request from server');

      await expect(
        fetchJsonOrThrow('/api/test', {}, 'Fallback error', globalFetch),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('uses fallback message when server response has no message', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }));

      await expect(
        fetchJsonOrThrow('/api/test', {}, 'Custom fallback', globalFetch),
      ).rejects.toThrow('Custom fallback');
    });

    it('uses fallback message when response body cannot be parsed', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      }));

      await expect(
        fetchJsonOrThrow('/api/test', {}, 'Network error fallback', globalFetch),
      ).rejects.toThrow('Network error fallback');
    });

    it('preserves full error payload for MCP_NOT_CONFIGURED errors', async () => {
      const errorPayload = {
        statusCode: 400,
        code: 'validation_error',
        message: 'Provider MCP is not configured',
        details: {
          code: 'MCP_NOT_CONFIGURED',
          providerId: 'provider-1',
          providerName: 'claude',
          mcpStatus: 'warn',
          mcpMessage: "MCP alias 'devchain' not found.",
        },
        timestamp: '2024-01-01T00:00:00Z',
        path: '/api/sessions/launch',
      };
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => errorPayload,
      }));

      try {
        await fetchJsonOrThrow('/api/sessions/launch', undefined, undefined, globalFetch);
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionApiError);
        const apiError = error as SessionApiError;
        expect(apiError.hasCode('MCP_NOT_CONFIGURED')).toBe(true);
        expect(apiError.payload?.details?.providerId).toBe('provider-1');
        expect(apiError.payload?.details?.providerName).toBe('claude');
      }
    });
  });

  describe('fetchOrThrow', () => {
    it('resolves without error on success', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
      }));

      await expect(
        fetchOrThrow('/api/test', { method: 'DELETE' }, undefined, globalFetch),
      ).resolves.toBeUndefined();
    });

    it('throws the typed server error with message and status', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
      }));

      await expect(
        fetchOrThrow('/api/test', { method: 'DELETE' }, 'Delete failed', globalFetch),
      ).rejects.toThrow(SessionApiError);
      await expect(
        fetchOrThrow('/api/test', { method: 'DELETE' }, 'Delete failed', globalFetch),
      ).rejects.toThrow('Forbidden');

      await expect(
        fetchOrThrow('/api/test', { method: 'DELETE' }, 'Delete failed', globalFetch),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
  it('keeps the sessions re-export compatible with instanceof checks', () => {
    const error = new SessionApiError('failure', 409);
    expect(error).toBeInstanceOf(ReexportedSessionApiError);
    expect(error.name).toBe('SessionApiError');
    expect(error.hasCode('MCP_NOT_CONFIGURED')).toBe(false);
  });

  it.each([
    ['server message', 'server message', 'server message'],
    ['  server message  ', '  server message  ', '  server message  '],
    ['   ', '   ', 'fallback'],
    [42, '42', 'fallback'],
    [null, 'null', 'fallback'],
    [undefined, 'undefined', 'fallback'],
  ])(
    'preserves distinct error policies for message %p',
    async (message, typedMessage, plainMessage) => {
      const fetchFn: FetchFn = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ message }),
      });
      await expect(fetchJsonOrThrow('/test', {}, 'fallback', fetchFn)).rejects.toMatchObject({
        message: typedMessage,
        status: 400,
      });
      const request = fetchJsonWithMessageOrThrow(fetchFn, '/test', {}, 'fallback');
      await expect(request).rejects.toHaveProperty('constructor', Error);
      await expect(request).rejects.toHaveProperty('message', plainMessage);
    },
  );

  it.each([fetchJsonOrThrow, fetchOrThrow])(
    'propagates network rejection unchanged',
    async (helper) => {
      const error = new TypeError('Network unavailable');
      const fetchFn: FetchFn = jest.fn().mockRejectedValue(error);
      await expect(helper('/test', {}, 'fallback', fetchFn)).rejects.toBe(error);
    },
  );

  describe('fetchJsonWithMessageOrThrow', () => {
    it('returns parsed JSON through the bound fetcher', async () => {
      const payload = { items: ['skill'] };
      const fetchFn: FetchFn = jest.fn().mockResolvedValue({ ok: true, json: async () => payload });
      const options = { method: 'POST' };
      await expect(
        fetchJsonWithMessageOrThrow(fetchFn, '/test', options, 'fallback'),
      ).resolves.toEqual(payload);
      expect(fetchFn).toHaveBeenCalledWith('/test', options);
    });

    it('uses the fallback when an error body is malformed', async () => {
      const fetchFn: FetchFn = jest.fn().mockResolvedValue({
        ok: false,
        json: async () => {
          throw new SyntaxError('Invalid JSON');
        },
      });
      await expect(fetchJsonWithMessageOrThrow(fetchFn, '/test', {}, 'fallback')).rejects.toThrow(
        'fallback',
      );
    });

    it('propagates network rejection unchanged', async () => {
      const error = new TypeError('Network unavailable');
      const fetchFn: FetchFn = jest.fn().mockRejectedValue(error);
      await expect(fetchJsonWithMessageOrThrow(fetchFn, '/test', {}, 'fallback')).rejects.toBe(
        error,
      );
    });
  });
});
