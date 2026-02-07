import {
  launchAgentSession,
  launchSession,
  restartAgentSession,
  SessionApiError,
  fetchJsonOrThrow,
  fetchOrThrow,
} from './sessions';

describe('ui/lib/sessions helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
    jest.clearAllMocks();
  });

  function makeSessionPayload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'session-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionId: 'tmux-1',
      status: 'running',
      startedAt: '2024-01-01T00:00:00.000Z',
      endedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    } as const;
  }

  it('launchAgentSession succeeds and returns ActiveSession', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/sessions/launch' && init?.method === 'POST') {
          return { ok: true, json: async () => makeSessionPayload() } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      },
    );

    const sess = await launchAgentSession('agent-1', 'project-1');
    expect(sess.id).toBe('session-1');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/sessions/launch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('launchSession forwards silent option when provided', async () => {
    let capturedBody: string | undefined;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return { ok: true, json: async () => makeSessionPayload() } as Response;
      },
    );

    await launchSession('agent-1', 'project-1', { silent: true });

    expect(JSON.parse(capturedBody!)).toEqual({
      agentId: 'agent-1',
      projectId: 'project-1',
      options: { silent: true },
    });
  });

  it('launchAgentSession propagates error message on failure', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/sessions/launch' && init?.method === 'POST') {
          return {
            ok: false,
            json: async () => ({ message: 'Preflight checks failed' }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      },
    );

    await expect(launchAgentSession('agent-1', 'project-1')).rejects.toThrow(
      /Preflight checks failed|Failed to launch session/,
    );
  });

  describe('restartAgentSession', () => {
    // Helper to create atomic restart response
    function makeRestartResponse(
      overrides: Partial<{
        session: Partial<Record<string, unknown>>;
        terminateStatus: string;
        terminateWarning?: string;
      }> = {},
    ) {
      return {
        session: makeSessionPayload(overrides.session ?? {}),
        terminateStatus: overrides.terminateStatus ?? 'not_found',
        terminateWarning: overrides.terminateWarning,
      };
    }

    it('calls atomic restart endpoint and returns session (terminateStatus: success)', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === '/api/agents/agent-1/restart' && init?.method === 'POST') {
            return {
              ok: true,
              json: async () =>
                makeRestartResponse({
                  session: { id: 'session-new' },
                  terminateStatus: 'success',
                }),
            } as Response;
          }
          return { ok: true, json: async () => ({}) } as Response;
        },
      );

      const result = await restartAgentSession('agent-1', 'project-1', 'old-session');
      expect(result.session.id).toBe('session-new');
      expect(result.terminateWarning).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/agents/agent-1/restart',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns session when no prior session existed (terminateStatus: not_found)', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () =>
          makeRestartResponse({
            session: { id: 'session-fresh' },
            terminateStatus: 'not_found',
          }),
      }));

      const result = await restartAgentSession('agent-1', 'project-1', 'nonexistent');
      expect(result.session.id).toBe('session-fresh');
      expect(result.terminateWarning).toBeUndefined();
    });

    it('returns session with warning when terminate failed (terminateStatus: error)', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () =>
          makeRestartResponse({
            session: { id: 'session-after-error' },
            terminateStatus: 'error',
            terminateWarning: 'Previous session may still be running: Terminate failed',
          }),
      }));

      const result = await restartAgentSession('agent-1', 'project-1', 'failing-session');
      expect(result.session.id).toBe('session-after-error');
      expect(result.terminateWarning).toContain('Previous session may still be running');
    });

    it('throws error when restart endpoint fails', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ message: 'Internal server error' }),
      }));

      await expect(restartAgentSession('agent-1', 'project-1', 'any-session')).rejects.toThrow(
        /Internal server error|Failed to restart session/,
      );
    });

    it('sends projectId in request body', async () => {
      let capturedBody: string | undefined;
      (global as unknown as { fetch: unknown }).fetch = jest.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedBody = init?.body as string;
          return {
            ok: true,
            json: async () => makeRestartResponse({ session: { id: 'session-1' } }),
          } as Response;
        },
      );

      await restartAgentSession('agent-1', 'project-123', 'old-session');
      expect(JSON.parse(capturedBody!)).toEqual({ projectId: 'project-123' });
    });
  });

  describe('SessionApiError', () => {
    it('includes status code in error', () => {
      const error = new SessionApiError('Not found', 404);
      expect(error.message).toBe('Not found');
      expect(error.status).toBe(404);
      expect(error.name).toBe('SessionApiError');
    });

    it('includes payload when provided', () => {
      const payload = {
        statusCode: 400,
        code: 'validation_error',
        message: 'Validation failed',
        details: { code: 'MCP_NOT_CONFIGURED', providerId: 'p1', providerName: 'claude' },
        timestamp: '2024-01-01T00:00:00Z',
        path: '/api/sessions/launch',
      };
      const error = new SessionApiError('Validation failed', 400, payload);
      expect(error.payload).toEqual(payload);
    });

    it('hasCode returns true when details.code matches', () => {
      const error = new SessionApiError('Error', 400, {
        statusCode: 400,
        code: 'validation_error',
        message: 'Error',
        details: { code: 'MCP_NOT_CONFIGURED' },
        timestamp: '2024-01-01T00:00:00Z',
        path: '/api/test',
      });
      expect(error.hasCode('MCP_NOT_CONFIGURED')).toBe(true);
      expect(error.hasCode('OTHER_CODE')).toBe(false);
    });

    it('hasCode returns false when no payload', () => {
      const error = new SessionApiError('Error', 400);
      expect(error.hasCode('MCP_NOT_CONFIGURED')).toBe(false);
    });
  });

  describe('fetchJsonOrThrow', () => {
    it('returns parsed JSON on success', async () => {
      const mockData = { id: 'test-id', name: 'Test' };
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => mockData,
      }));

      const result = await fetchJsonOrThrow<typeof mockData>('/api/test');
      expect(result).toEqual(mockData);
    });

    it('throws SessionApiError with server message on failure', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ message: 'Bad request from server' }),
      }));

      await expect(fetchJsonOrThrow('/api/test', {}, 'Fallback error')).rejects.toThrow(
        SessionApiError,
      );
      await expect(fetchJsonOrThrow('/api/test', {}, 'Fallback error')).rejects.toThrow(
        'Bad request from server',
      );
    });

    it('uses fallback message when server response has no message', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }));

      await expect(fetchJsonOrThrow('/api/test', {}, 'Custom fallback')).rejects.toThrow(
        'Custom fallback',
      );
    });

    it('uses fallback message when response body cannot be parsed', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      }));

      await expect(fetchJsonOrThrow('/api/test', {}, 'Network error fallback')).rejects.toThrow(
        'Network error fallback',
      );
    });

    it('includes status code in thrown error', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not found' }),
      }));

      try {
        await fetchJsonOrThrow('/api/test');
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionApiError);
        expect((error as SessionApiError).status).toBe(404);
      }
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
        await fetchJsonOrThrow('/api/sessions/launch');
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

      await expect(fetchOrThrow('/api/test', { method: 'DELETE' })).resolves.toBeUndefined();
    });

    it('throws SessionApiError with server message on failure', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
      }));

      await expect(
        fetchOrThrow('/api/test', { method: 'DELETE' }, 'Delete failed'),
      ).rejects.toThrow(SessionApiError);
      await expect(
        fetchOrThrow('/api/test', { method: 'DELETE' }, 'Delete failed'),
      ).rejects.toThrow('Forbidden');
    });

    it('includes status code in thrown error', async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ message: 'Conflict' }),
      }));

      try {
        await fetchOrThrow('/api/test');
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionApiError);
        expect((error as SessionApiError).status).toBe(409);
      }
    });
  });
});
