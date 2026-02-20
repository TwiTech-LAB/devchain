import {
  installWorktreeFetchInterceptor,
  MAIN_INSTANCE_API_PREFIXES,
  WORKTREE_PROXY_UNAVAILABLE_EVENT,
  type WorktreeProxyUnavailableDetail,
  rewriteApiRequestUrl,
} from './worktree-fetch-interceptor';

const TEST_ORIGIN = 'http://localhost:3000';

function asRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

describe('rewriteApiRequestUrl', () => {
  it('leaves /api requests unchanged when main tab is active', () => {
    expect(
      rewriteApiRequestUrl('/api/epics?projectId=main', {
        apiBase: '',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/api/epics?projectId=main');
  });

  it('prepends /wt/:name for same-origin /api requests when worktree tab is active', () => {
    expect(
      rewriteApiRequestUrl('/api/epics?projectId=abc', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/wt/feature-auth/api/epics?projectId=abc');
  });

  it('does not modify non-api paths', () => {
    expect(
      rewriteApiRequestUrl('/health', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/health');
  });

  it('does not modify already-prefixed /wt paths', () => {
    expect(
      rewriteApiRequestUrl('/wt/feature-auth/api/epics', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/wt/feature-auth/api/epics');
  });

  it('does not modify external URLs', () => {
    expect(
      rewriteApiRequestUrl('https://example.com/api/epics', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('https://example.com/api/epics');
  });

  it('does not modify allowlisted main-instance endpoints', () => {
    expect(
      rewriteApiRequestUrl('/api/worktrees', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/api/worktrees');

    expect(
      rewriteApiRequestUrl('/api/templates', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/api/templates');

    expect(
      rewriteApiRequestUrl('/api/registry', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/api/registry');

    expect(
      rewriteApiRequestUrl('/api/registry/update-status', {
        apiBase: '/wt/feature-auth',
        origin: TEST_ORIGIN,
      }),
    ).toBe('/api/registry/update-status');
  });
});

describe('installWorktreeFetchInterceptor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      window.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
      delete (window as unknown as { fetch?: unknown }).fetch;
    }
    jest.clearAllMocks();
  });

  it('rewrites same-origin API requests and keeps dynamic apiBase', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    let apiBase = '';
    const uninstall = installWorktreeFetchInterceptor({
      getApiBase: () => apiBase,
      origin: TEST_ORIGIN,
      mainInstanceApiPrefixes: MAIN_INSTANCE_API_PREFIXES,
    });

    await window.fetch('/api/epics');
    expect(asRequestUrl(fetchMock.mock.calls[0][0] as RequestInfo | URL)).toBe('/api/epics');

    apiBase = '/wt/feature-auth';
    await window.fetch('/api/epics?limit=10');
    expect(asRequestUrl(fetchMock.mock.calls[1][0] as RequestInfo | URL)).toBe(
      '/wt/feature-auth/api/epics?limit=10',
    );

    await window.fetch('/api/worktrees');
    expect(asRequestUrl(fetchMock.mock.calls[2][0] as RequestInfo | URL)).toBe('/api/worktrees');

    uninstall();
    expect(window.fetch).toBe(fetchMock);
  });

  it('rewrites Request inputs without dropping request metadata', async () => {
    if (typeof Request === 'undefined') {
      return;
    }

    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    const uninstall = installWorktreeFetchInterceptor({
      getApiBase: () => '/wt/feature-auth',
      origin: TEST_ORIGIN,
    });

    const input = new Request(`${TEST_ORIGIN}/api/epics`, {
      method: 'POST',
      body: JSON.stringify({ title: 'test' }),
      headers: { 'content-type': 'application/json' },
    });
    await window.fetch(input);

    const forwarded = fetchMock.mock.calls[0][0] as Request;
    expect(forwarded).toBeInstanceOf(Request);
    expect(forwarded.url).toBe(`${TEST_ORIGIN}/wt/feature-auth/api/epics`);
    expect(forwarded.method).toBe('POST');

    uninstall();
  });

  it('dispatches unavailable events for proxied 503 responses', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      const payload = {
        statusCode: 503,
        message: 'Worktree is not running (status: stopped)',
        worktreeName: 'feature-auth',
      };
      return {
        ok: false,
        status: 503,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null,
        } as Headers,
        clone: () =>
          ({
            json: async () => payload,
          }) as Response,
        json: async () => payload,
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    const events: WorktreeProxyUnavailableDetail[] = [];
    const onUnavailable = (event: Event) => {
      events.push((event as CustomEvent<WorktreeProxyUnavailableDetail>).detail);
    };
    window.addEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, onUnavailable);

    const uninstall = installWorktreeFetchInterceptor({
      getApiBase: () => '/wt/feature-auth',
      origin: TEST_ORIGIN,
      mainInstanceApiPrefixes: MAIN_INSTANCE_API_PREFIXES,
    });

    try {
      await window.fetch('/api/epics?projectId=project-1');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        statusCode: 503,
        message: 'Worktree is not running (status: stopped)',
        worktreeName: 'feature-auth',
        requestUrl: '/wt/feature-auth/api/epics?projectId=project-1',
      });
    } finally {
      window.removeEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, onUnavailable);
      uninstall();
    }
  });
});
