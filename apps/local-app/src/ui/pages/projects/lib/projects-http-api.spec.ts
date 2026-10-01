import { ProjectsHttpApi } from './projects-http-api';
import type {
  ImportProjectResponse,
  SetupPreviewResponse,
  UpgradeProjectResponse,
} from './project-contracts';

function response(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? (options.ok === false ? 500 : 200),
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function rejectedJson(options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? (options.ok === false ? 500 : 200),
    json: jest.fn(async () => Promise.reject(new SyntaxError('invalid json'))),
  } as unknown as Response;
}

const setupPreview = {
  payload: { version: 1, profiles: [], agents: [], teams: [] },
  providerSummary: [],
  familyAlternatives: [],
  presetProviderCoverage: [],
  localAvailability: { installedProviders: [] },
} as SetupPreviewResponse;

describe('ProjectsHttpApi', () => {
  const originalFetch = window.fetch;
  let api: ProjectsHttpApi;

  beforeEach(() => {
    api = new ProjectsHttpApi();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('loads projects and keeps per-project statistics fail-soft', async () => {
    window.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 'one',
              name: 'One',
              description: null,
              rootPath: '/one',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'two',
              name: 'Two',
              description: null,
              rootPath: '/two',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          total: 2,
        }),
      )
      .mockResolvedValueOnce(response({ epicsCount: 3, agentsCount: 4 }))
      .mockRejectedValueOnce(new Error('stats unavailable')) as jest.MockedFunction<typeof fetch>;

    const result = await api.listProjects();
    expect(result).toEqual({
      items: [
        expect.objectContaining({ id: 'one', stats: { epicsCount: 3, agentsCount: 4 } }),
        expect.objectContaining({ id: 'two' }),
      ],
      total: 2,
    });
    expect(result.items[1]).not.toHaveProperty('stats');
    expect(window.fetch).toHaveBeenNthCalledWith(1, '/api/projects', undefined);
    expect(window.fetch).toHaveBeenNthCalledWith(2, '/api/projects/one/stats', undefined);
    expect(window.fetch).toHaveBeenNthCalledWith(3, '/api/projects/two/stats', undefined);
  });

  it('resolves the current window.fetch at call time', async () => {
    const staleFetch = jest.fn();
    window.fetch = staleFetch;
    api = new ProjectsHttpApi();

    const liveFetch = jest.fn(async () => response({ exists: true, isFile: false }));
    window.fetch = liveFetch as unknown as typeof fetch;

    await expect(api.statPath('/live')).resolves.toEqual({ exists: true, isFile: false });
    expect(staleFetch).not.toHaveBeenCalled();
    expect(liveFetch).toHaveBeenCalledWith('/api/fs/stat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/live' }),
    });
  });

  it('preserves path-stat body, absence, and rejection semantics', async () => {
    window.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ exists: false }))
      .mockResolvedValueOnce(response({ message: 'not found' }, { ok: false, status: 404 }))
      .mockResolvedValueOnce(rejectedJson()) as jest.MockedFunction<typeof fetch>;

    await expect(api.statPath('/body-absent')).resolves.toEqual({
      exists: false,
      isFile: false,
    });
    await expect(api.statPath('/http-absent')).resolves.toEqual({
      exists: false,
      isFile: false,
    });
    await expect(api.statPath('/bad-json')).rejects.toThrow('invalid json');
  });

  it('preserves exact routes, methods, bodies, and ID encoding', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({ templates: [] }))
      .mockResolvedValueOnce(response({ name: 'Manifest' }))
      .mockResolvedValueOnce(response(setupPreview))
      .mockResolvedValueOnce(response(setupPreview))
      .mockResolvedValueOnce(response({ project: { id: 'a/b' }, provisioningWarnings: [] }))
      .mockResolvedValueOnce(response(undefined))
      .mockResolvedValueOnce(
        response({
          dryRun: true,
          missingProviders: [],
          counts: { toImport: {}, toDelete: {} },
        }),
      )
      .mockResolvedValueOnce(
        response({ success: true, counts: { imported: {}, deleted: {} }, mappings: {} }),
      )
      .mockResolvedValueOnce(response({ success: true, newVersion: '2.0.0' }));
    window.fetch = fetchMock as unknown as typeof fetch;

    await api.listTemplates();
    await api.readTemplateManifest('a/b');
    await api.loadSetupPreview({ slug: 'demo', version: '1.0.0' });
    await api.loadUpgradePreview('a/b', '2.0.0');
    await api.updateProject('a/b', { name: 'Renamed' });
    await api.deleteProject('a/b');
    await api.runImportDryRun('a/b', { version: 1 });
    await api.commitImport('a/b', { version: 1 });
    await api.commitUpgrade('a/b', { targetVersion: '2.0.0' });

    expect(fetchMock.mock.calls).toEqual([
      ['/api/templates'],
      ['/api/projects/a/b/template-manifest'],
      [
        '/api/projects/setup-preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: 'demo', version: '1.0.0' }),
        },
      ],
      [
        '/api/projects/a%2Fb/upgrade-template/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetVersion: '2.0.0' }),
        },
      ],
      [
        '/api/projects/a/b',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' }),
        },
      ],
      ['/api/projects/a/b', { method: 'DELETE' }],
      [
        '/api/projects/a%2Fb/import?dryRun=true',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1 }),
        },
      ],
      [
        '/api/projects/a%2Fb/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1 }),
        },
      ],
      [
        '/api/projects/a%2Fb/upgrade-template',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetVersion: '2.0.0' }),
        },
      ],
    ]);
  });

  it('normalizes an empty create version and returns structured HTTP-200 outcomes', async () => {
    const createOutcome = {
      success: false,
      providerMappingRequired: {
        missingProviders: ['claude'],
        familyAlternatives: [],
        canImport: false,
      },
    } as const;
    const importOutcome: ImportProjectResponse = {
      success: false,
      mutationStarted: false,
      error: 'Import blocked',
    };
    const upgradeOutcome: UpgradeProjectResponse = {
      success: false,
      mutationStarted: true,
      error: 'Upgrade failed',
      restored: true,
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(createOutcome))
      .mockResolvedValueOnce(response(importOutcome))
      .mockResolvedValueOnce(response(upgradeOutcome));
    window.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      api.createFromTemplate({ name: 'Demo', rootPath: '/demo', templateId: 'tpl', version: '' }),
    ).resolves.toEqual(createOutcome);
    await expect(api.commitImport('project', { version: 1 })).resolves.toEqual(importOutcome);
    await expect(api.commitUpgrade('project', { targetVersion: '2.0.0' })).resolves.toEqual(
      upgradeOutcome,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          name: 'Demo',
          rootPath: '/demo',
          templateId: 'tpl',
          version: null,
        }),
      }),
    );
  });

  it('uses the workspace management HTTP contract with encoded identifiers', async () => {
    const workspace = {
      id: 'team/a',
      name: 'Team A',
      isDefault: false,
      position: 1,
      projectCount: 0,
      deviceGrantCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response([workspace]))
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(response({ ...workspace, name: 'Renamed' }))
      .mockResolvedValueOnce(response([workspace]))
      .mockResolvedValueOnce(response({ movedProjectCount: 2, remappedDeviceGrantCount: 3 }));
    window.fetch = fetchMock as unknown as typeof fetch;

    await api.listWorkspaces();
    await api.createWorkspace('Team A');
    await api.renameWorkspace('team/a', 'Renamed');
    await api.reorderWorkspaces(['default', 'team/a']);
    await api.deleteWorkspace('team/a', 'default');

    expect(fetchMock.mock.calls).toEqual([
      ['/api/workspaces'],
      [
        '/api/workspaces',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Team A' }),
        },
      ],
      [
        '/api/workspaces/team%2Fa',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' }),
        },
      ],
      [
        '/api/workspaces/reorder',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceIds: ['default', 'team/a'] }),
        },
      ],
      [
        '/api/workspaces/team%2Fa',
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ replacementWorkspaceId: 'default' }),
        },
      ],
    ]);
  });

  it('keeps manifest lookup fail-soft', async () => {
    window.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response({}, { ok: false, status: 404 })) as jest.MockedFunction<
      typeof fetch
    >;

    await expect(api.readTemplateManifest('one')).resolves.toBeNull();
    await expect(api.readTemplateManifest('two')).resolves.toBeNull();
  });

  it('keeps legacy operation fallbacks and configured-replace error precedence', async () => {
    window.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ message: 'Update rejected' }, { ok: false, status: 400 }))
      .mockResolvedValueOnce(rejectedJson({ ok: false, status: 500 }))
      .mockResolvedValueOnce(
        response({ message: 'Primary', error: 'Secondary' }, { ok: false, status: 409 }),
      )
      .mockResolvedValueOnce(response({ error: 'Secondary' }, { ok: false, status: 409 }))
      .mockResolvedValueOnce(rejectedJson({ ok: false, status: 503 })) as jest.MockedFunction<
      typeof fetch
    >;

    await expect(api.updateProject('one', { name: 'X' })).rejects.toThrow('Update rejected');
    await expect(api.updateProject('one', { name: 'X' })).rejects.toThrow(
      'Failed to update project',
    );
    await expect(api.commitImport('one', {})).rejects.toThrow('Primary');
    await expect(api.commitImport('one', {})).rejects.toThrow('Secondary');
    await expect(api.commitImport('one', {})).rejects.toThrow('Request failed with status 503');
  });
});
