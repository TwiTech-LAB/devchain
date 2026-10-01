import {
  HOME_BACKEND,
  apiFetch,
  buildApiUrl,
  createApiFetch,
  resolveBackend,
  RoutingUnknownError,
  type BackendResolutionContext,
} from './api-transport';

const REMOTE_A = '11111111-1111-4111-8111-111111111111';
const REMOTE_B = '22222222-2222-4222-8222-222222222222';
const BOUND_ACTIVE = 'project-active';
const BOUND_OTHER = 'project-other';
const LOCAL_PROJECT = 'project-local';

const context: BackendResolutionContext = {
  bindings: new Map([
    [BOUND_ACTIVE, REMOTE_A],
    [BOUND_OTHER, REMOTE_B],
  ]),
  activeProjectId: BOUND_ACTIVE,
  authority: 'known',
};

// jsdom has no fetch Request; this stand-in carries the two fields the transport reads.
class FakeRequest {
  readonly url: string;
  readonly method: string;

  constructor(input: string | FakeRequest, init?: { method?: string }) {
    this.url = typeof input === 'string' ? input : input.url;
    this.method = (
      init?.method ??
      (typeof input === 'string' ? undefined : input.method) ??
      'GET'
    ).toUpperCase();
  }
}

const originalRequest = (globalThis as { Request?: unknown }).Request;
beforeAll(() => {
  (globalThis as { Request?: unknown }).Request = FakeRequest;
});
afterAll(() => {
  (globalThis as { Request?: unknown }).Request = originalRequest;
});

const localActiveContext: BackendResolutionContext = { ...context, activeProjectId: LOCAL_PROJECT };

describe('resolveBackend', () => {
  it('lets an explicit backend win over every other rule', () => {
    expect(resolveBackend('/api/epics/e1', undefined, { backend: HOME_BACKEND }, context)).toBe(
      HOME_BACKEND,
    );
    expect(resolveBackend('/api/projects', undefined, { backend: REMOTE_B }, context)).toBe(
      REMOTE_B,
    );
  });

  it('resolves backend "project:<id>" through the binding map', () => {
    expect(
      resolveBackend('/api/epics', undefined, { backend: `project:${BOUND_OTHER}` }, context),
    ).toBe(REMOTE_B);
    expect(
      resolveBackend('/api/epics', undefined, { backend: `project:${LOCAL_PROJECT}` }, context),
    ).toBe(HOME_BACKEND);
  });

  it('keeps /api/projects/:id home even when that project is bound', () => {
    expect(resolveBackend(`/api/projects/${BOUND_OTHER}`, { method: 'PUT' }, {}, context)).toBe(
      HOME_BACKEND,
    );
    expect(resolveBackend(`/api/projects/${BOUND_ACTIVE}/stats`, undefined, {}, context)).toBe(
      HOME_BACKEND,
    );
  });

  it('sends entity-id routes to the active project backend', () => {
    expect(resolveBackend('/api/epics/e1', undefined, undefined, context)).toBe(REMOTE_A);
    expect(resolveBackend('/api/epics/e1', undefined, undefined, localActiveContext)).toBe(
      HOME_BACKEND,
    );
    expect(
      resolveBackend('/api/epics/e1', undefined, undefined, { ...context, activeProjectId: null }),
    ).toBe(HOME_BACKEND);
  });

  it('routes a bound projectId query or JSON body to its remote even when another project is active', () => {
    expect(
      resolveBackend(`/api/epics?projectId=${BOUND_OTHER}&limit=5`, undefined, {}, context),
    ).toBe(REMOTE_B);
    expect(
      resolveBackend(
        '/api/epics',
        { method: 'POST', body: JSON.stringify({ projectId: BOUND_OTHER, title: 't' }) },
        {},
        localActiveContext,
      ),
    ).toBe(REMOTE_B);
    expect(
      resolveBackend(
        new URL(`http://localhost/api/agents?projectId=${BOUND_OTHER}`),
        undefined,
        {},
        localActiveContext,
      ),
    ).toBe(REMOTE_B);
  });

  it('routes a named but unbound project home even when the active project is remote', () => {
    expect(resolveBackend(`/api/epics?projectId=${LOCAL_PROJECT}`, undefined, {}, context)).toBe(
      HOME_BACKEND,
    );
  });

  it('reads the project id from the settings autoclean path', () => {
    expect(
      resolveBackend(
        `/api/settings/autoclean/${BOUND_OTHER}`,
        { method: 'POST' },
        {},
        localActiveContext,
      ),
    ).toBe(REMOTE_B);
  });

  it.each([
    '/api/remotes',
    '/api/remotes/bindings',
    '/api/vm-providers',
    '/api/workspaces',
    '/api/projects',
    '/api/projects/from-template',
    '/api/projects/setup-preview',
    '/api/projects/by-path?path=%2Ftmp%2Fx',
    `/api/projects/${BOUND_ACTIVE}/export`,
    `/api/projects/${BOUND_ACTIVE}/upgrade-template`,
    '/api/cloud/devices',
    '/api/auth/cloud/login',
    '/api/e2ee/devices',
    '/api/integrations/connections',
    '/api/provider-auth',
    '/api/provider-clis',
    '/api/provider-clis/check',
    '/api/provider-clis/claude',
    '/api/runtime',
    '/api/fs/browse',
    '/api/templates',
    '/api/registry/check-updates/p1',
    '/api/preflight',
    '/api/agent-time-buffers',
    '/api/epics/import-external-task',
    '/api/epics/external-sources',
    '/api/epics/external-sources/batch',
    '/api/epics/e1/time-logs',
    '/api/epics/e1/time',
    '/api/epics/time-summary/batch',
  ])('sends home-always route %s home', (path) => {
    expect(resolveBackend(path, undefined, {}, context)).toBe(HOME_BACKEND);
    expect(
      resolveBackend(
        `${path}${path.includes('?') ? '&' : '?'}projectId=${BOUND_OTHER}`,
        undefined,
        {},
        context,
      ),
    ).toBe(HOME_BACKEND);
  });

  it('sends epic time-log writes home but other epic time writes to the project backend', () => {
    expect(resolveBackend('/api/epics/e1/time-logs', { method: 'POST' }, {}, context)).toBe(
      HOME_BACKEND,
    );
    expect(resolveBackend('/api/epics/e1/time', { method: 'PUT' }, {}, context)).toBe(REMOTE_A);
  });

  it('keeps the bound epic time preview and its estimate-log submission on the same home source', () => {
    // Preview and submission must share one backend: the logged projection
    // validates against the mirrored time data the preview displayed.
    expect(resolveBackend('/api/epics/e1/time-logs', undefined, {}, context)).toBe(HOME_BACKEND);
    expect(
      resolveBackend(
        `/api/integrations/my-work/clickup/tasks/abc/estimate-time-entries?projectId=${BOUND_ACTIVE}`,
        { method: 'POST' },
        {},
        context,
      ),
    ).toBe(HOME_BACKEND);
  });

  it('sends the epic time-summary batch POST home even with a remote project active', () => {
    expect(resolveBackend('/api/epics/time-summary/batch', { method: 'POST' }, {}, context)).toBe(
      HOME_BACKEND,
    );
  });

  it('does not treat look-alike prefixes as home-always', () => {
    expect(resolveBackend('/api/projectsx', undefined, {}, context)).toBe(REMOTE_A);
    expect(resolveBackend('/api/epics/e1/timeline', undefined, {}, context)).toBe(REMOTE_A);
    expect(resolveBackend('/api/provider-clisx', undefined, {}, context)).toBe(REMOTE_A);
  });

  it('keeps non-API and already-proxied paths home', () => {
    expect(resolveBackend('/health', undefined, {}, context)).toBe(HOME_BACKEND);
    expect(resolveBackend('/assets/logo.svg', undefined, {}, context)).toBe(HOME_BACKEND);
    expect(resolveBackend(`/r/${REMOTE_A}/api/epics`, undefined, {}, context)).toBe(HOME_BACKEND);
  });

  it('uses the method of a Request input', () => {
    const request = new FakeRequest('http://localhost/api/epics/e1/time', {
      method: 'PUT',
    }) as unknown as Request;
    expect(resolveBackend(request, undefined, {}, context)).toBe(REMOTE_A);
  });
});

describe('resolveBackend with unknown routing authority', () => {
  const unknown: BackendResolutionContext = { ...context, authority: 'unknown' };

  it('resolves home-always, non-API and explicit-home requests', () => {
    expect(resolveBackend('/api/remotes/bindings', undefined, undefined, unknown)).toBe(
      HOME_BACKEND,
    );
    expect(resolveBackend('/api/projects/p1', undefined, undefined, unknown)).toBe(HOME_BACKEND);
    expect(resolveBackend('/health', undefined, undefined, unknown)).toBe(HOME_BACKEND);
    expect(resolveBackend('/api/epics/e1', undefined, { backend: HOME_BACKEND }, unknown)).toBe(
      HOME_BACKEND,
    );
    expect(resolveBackend('/api/epics/e1', undefined, { backend: REMOTE_B }, unknown)).toBe(
      REMOTE_B,
    );
  });

  it('refuses entity-id routes, named projects and project selectors with ROUTING_UNKNOWN', () => {
    const attempts: Array<() => unknown> = [
      () => resolveBackend('/api/epics/e1', undefined, undefined, unknown),
      () => resolveBackend(`/api/epics?projectId=${LOCAL_PROJECT}`, undefined, undefined, unknown),
      () =>
        resolveBackend('/api/epics/e1', undefined, { backend: `project:${BOUND_ACTIVE}` }, unknown),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(RoutingUnknownError);
      expect(attempt).toThrow(expect.objectContaining({ name: 'ROUTING_UNKNOWN' }));
    }
  });

  it('turns the refusal into a rejected promise without calling fetch', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const boundFetch = createApiFetch(() => unknown);
      await expect(boundFetch('/api/epics/e1')).rejects.toMatchObject({
        name: 'ROUTING_UNKNOWN',
        message: 'Project routing is not known yet',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('buildApiUrl', () => {
  it('leaves home paths unchanged', () => {
    expect(buildApiUrl(HOME_BACKEND, '/api/records/r1/download?format=zip')).toBe(
      '/api/records/r1/download?format=zip',
    );
  });

  it('prefixes remote paths with /r/<remoteId>', () => {
    expect(buildApiUrl(REMOTE_A, '/api/records/r1/download?format=zip')).toBe(
      `/r/${REMOTE_A}/api/records/r1/download?format=zip`,
    );
    expect(buildApiUrl(REMOTE_A, 'api/runtime')).toBe(`/r/${REMOTE_A}/api/runtime`);
  });

  it('does not double-prefix an already proxied path', () => {
    expect(buildApiUrl(REMOTE_A, `/r/${REMOTE_A}/api/runtime`)).toBe(`/r/${REMOTE_A}/api/runtime`);
  });
});

describe('apiFetch', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('passes home requests to fetch unchanged', async () => {
    const init = { method: 'POST', body: '{}' };
    await apiFetch('/api/epics?projectId=p1', init, { backend: HOME_BACKEND });
    expect(fetchMock).toHaveBeenCalledWith('/api/epics?projectId=p1', init);
  });

  it('sends an explicit remote backend through the proxy path', async () => {
    await apiFetch('/api/epics/e1', undefined, { backend: REMOTE_B });
    expect(fetchMock).toHaveBeenCalledWith(`/r/${REMOTE_B}/api/epics/e1`, undefined);
  });

  it('rejects a project selector, which needs the binding map', async () => {
    await expect(
      apiFetch('/api/epics/e1', undefined, { backend: `project:${BOUND_ACTIVE}` }),
    ).rejects.toThrow('use the bound fetch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites remote requests to the proxy path and keeps query and init', async () => {
    const boundFetch = createApiFetch(() => context);
    const init = { method: 'PATCH', body: '{"title":"x"}' };
    await boundFetch('/api/epics/e1?include=children', init);
    expect(fetchMock).toHaveBeenCalledWith(`/r/${REMOTE_A}/api/epics/e1?include=children`, init);
  });

  it('resolves home-always routes home through a remote-bound instance', async () => {
    const boundFetch = createApiFetch(() => context);
    await boundFetch('/api/projects');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/projects', undefined);
  });

  it('rewrites absolute URL and Request inputs', async () => {
    const remoteFetch = createApiFetch(() => context);

    await remoteFetch('http://localhost:5175/api/epics/e1');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://localhost:5175/r/${REMOTE_A}/api/epics/e1`,
      undefined,
    );

    await remoteFetch(new URL('http://localhost:5175/api/epics/e1?x=1'));
    expect(String(fetchMock.mock.lastCall?.[0])).toBe(
      `http://localhost:5175/r/${REMOTE_A}/api/epics/e1?x=1`,
    );

    await remoteFetch(
      new FakeRequest('http://localhost:5175/api/epics/e1', {
        method: 'DELETE',
      }) as unknown as Request,
    );
    const request = fetchMock.mock.lastCall?.[0] as FakeRequest;
    expect(request).toBeInstanceOf(FakeRequest);
    expect(request.url).toBe(`http://localhost:5175/r/${REMOTE_A}/api/epics/e1`);
    expect(request.method).toBe('DELETE');
  });
});
