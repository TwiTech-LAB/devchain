import {
  listWorktrees,
  listWorktreeOverviews,
  listWorktreeActivity,
  listBranches,
  listTemplates,
  WorktreeApiError,
  previewMerge,
  triggerMerge,
  deleteWorktree,
  fetchTemplate,
  createWorktree,
} from './worktrees';

function mockResponse(input: {
  ok: boolean;
  status: number;
  jsonBody?: unknown;
  textBody?: string;
}): Response {
  return {
    ok: input.ok,
    status: input.status,
    json: jest.fn(async () => {
      if (input.jsonBody === undefined) {
        throw new Error('no-json');
      }
      return input.jsonBody;
    }),
    text: jest.fn(async () => input.textBody ?? ''),
  } as unknown as Response;
}

describe('orchestrator ui worktrees api', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('loads merge preview payload from preview endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: {
          canMerge: true,
          commitsAhead: 2,
          commitsBehind: 1,
          filesChanged: 3,
          insertions: 40,
          deletions: 7,
          conflicts: [],
        },
      }),
    );

    const result = await previewMerge('wt-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/wt-1/merge/preview', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(result.canMerge).toBe(true);
    expect(result.filesChanged).toBe(3);
  });

  it('throws WorktreeApiError with conflict payload on merge conflict response', async () => {
    const conflictBody = {
      message: 'Merge failed with conflicts',
      details: 'merge conflict details',
      conflicts: [
        { file: 'src/main.ts', type: 'merge' },
        { file: 'src/config.ts', type: 'merge' },
      ],
    };
    const response = mockResponse({
      ok: false,
      status: 409,
      jsonBody: conflictBody,
      textBody: JSON.stringify(conflictBody),
    });

    fetchMock.mockResolvedValueOnce(response);

    await expect(triggerMerge('wt-1')).rejects.toMatchObject({
      name: 'WorktreeApiError',
      message: 'Merge failed with conflicts',
      status: 409,
      details: 'merge conflict details',
      conflicts: [
        { file: 'src/main.ts', type: 'merge' },
        { file: 'src/config.ts', type: 'merge' },
      ],
    });

    expect(response.text).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });

  it('uses text fallback message when error body is not json', async () => {
    const response = mockResponse({
      ok: false,
      status: 500,
      textBody: 'container unreachable',
    });

    fetchMock.mockResolvedValueOnce(response);

    try {
      await deleteWorktree('wt-1');
      throw new Error('expected deleteWorktree to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorktreeApiError);
      expect((error as WorktreeApiError).message).toBe('container unreachable');
      expect((error as WorktreeApiError).status).toBe(500);
      expect(response.text).toHaveBeenCalledTimes(1);
      expect(response.json).not.toHaveBeenCalled();
    }
  });

  it('falls back to http status when error body is empty', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        textBody: '',
      }),
    );

    await expect(deleteWorktree('wt-1')).rejects.toMatchObject({
      name: 'WorktreeApiError',
      message: 'Request failed with HTTP 500',
      status: 500,
    });
  });

  it('sends deleteBranch=true by default when deleting a worktree', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { success: true },
      }),
    );

    await deleteWorktree('wt-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/wt-1?deleteBranch=true', {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    });
  });

  it('sends deleteBranch=false when requested', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { success: true },
      }),
    );

    await deleteWorktree('wt-1', { deleteBranch: false });

    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/wt-1?deleteBranch=false', {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    });
  });

  it('loads and sorts branches from /api/branches', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { branches: ['release/1.0', 'main', 'feature/auth'] },
      }),
    );

    const result = await listBranches();

    expect(fetchMock).toHaveBeenCalledWith('/api/branches', {
      headers: { accept: 'application/json' },
    });
    expect(result).toEqual(['feature/auth', 'main', 'release/1.0']);
  });

  it('loads worktrees without ownerProjectId filter by default', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: [],
      }),
    );

    await expect(listWorktrees()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees', {
      headers: { accept: 'application/json' },
    });
  });

  it('loads worktrees with ownerProjectId filter when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: [],
      }),
    );

    await expect(listWorktrees({ ownerProjectId: 'project-1' })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees?ownerProjectId=project-1', {
      headers: { accept: 'application/json' },
    });
  });

  it('loads worktree overviews without ownerProjectId filter by default', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: [],
      }),
    );

    await expect(listWorktreeOverviews()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/overview', {
      headers: { accept: 'application/json' },
    });
  });

  it('loads worktree overviews with ownerProjectId filter when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: [],
      }),
    );

    await expect(listWorktreeOverviews({ ownerProjectId: 'project-1' })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/worktrees/overview?ownerProjectId=project-1', {
      headers: { accept: 'application/json' },
    });
  });

  it('loads worktree activity without ownerProjectId filter by default', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: {
          items: [
            {
              id: 'evt-1',
              publishedAt: '2026-02-18T00:00:00.000Z',
              payload: {
                worktreeId: 'wt-1',
                worktreeName: 'feature-auth',
                type: 'started',
                message: "Worktree 'feature-auth' started",
              },
            },
          ],
        },
      }),
    );

    await expect(listWorktreeActivity()).resolves.toEqual([
      {
        id: 'evt-1',
        publishedAt: '2026-02-18T00:00:00.000Z',
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        type: 'started',
        message: "Worktree 'feature-auth' started",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/events?name=orchestrator.worktree.activity&limit=20',
      {
        headers: { accept: 'application/json' },
      },
    );
  });

  it('loads worktree activity with ownerProjectId filter when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: {
          items: [],
        },
      }),
    );

    await expect(listWorktreeActivity({ ownerProjectId: 'project-1' })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/events?name=orchestrator.worktree.activity&limit=20&ownerProjectId=project-1',
      {
        headers: { accept: 'application/json' },
      },
    );
  });

  it('throws a clear error when branch request fails', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 503,
      }),
    );

    await expect(listBranches()).rejects.toThrow('Failed to load branches: HTTP 503');
  });

  it('throws on invalid branch payload shape', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { items: ['main'] },
      }),
    );

    await expect(listBranches()).rejects.toThrow('Invalid branches response payload');
  });

  it('loads templates from /api/templates payload envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: {
          templates: [
            { slug: '5-agents-dev', name: '5 Agents Dev' },
            { slug: '3-agent-dev', name: '3-Agent Dev' },
          ],
          total: 2,
        },
      }),
    );

    await expect(listTemplates()).resolves.toEqual([
      { slug: '5-agents-dev', name: '5 Agents Dev' },
      { slug: '3-agent-dev', name: '3-Agent Dev' },
    ]);
  });

  it('throws a clear error when template request fails', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 502,
      }),
    );

    await expect(listTemplates()).rejects.toThrow('Failed to load templates: HTTP 502');
  });

  it('throws when template payload shape is invalid', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { items: [{ slug: '5-agents-dev' }] },
      }),
    );

    await expect(listTemplates()).rejects.toThrow('Invalid templates response payload');
  });

  it('throws when template payload resolves to empty list', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { templates: [] },
      }),
    );

    await expect(listTemplates()).rejects.toThrow('No templates available');
  });

  it('fetches template detail including presets array', async () => {
    const templateDetail = {
      slug: '3-agent-dev',
      name: '3-Agent Dev',
      content: {
        presets: [
          { name: 'Tier-A[opus]', description: 'All opus' },
          { name: 'Tier-B[sonnet]', description: 'All sonnet' },
        ],
      },
    };
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, jsonBody: templateDetail }),
    );

    const result = await fetchTemplate('3-agent-dev');
    expect(fetchMock).toHaveBeenCalledWith('/api/templates/3-agent-dev', {
      headers: { accept: 'application/json' },
    });
    expect(result.slug).toBe('3-agent-dev');
    expect(result.content?.presets).toHaveLength(2);
    expect(result.content?.presets?.[0].name).toBe('Tier-A[opus]');
  });

  it('fetches template detail without presets', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        jsonBody: { slug: 'simple', name: 'Simple', content: {} },
      }),
    );

    const result = await fetchTemplate('simple');
    expect(result.content?.presets).toBeUndefined();
  });

  it('throws when fetchTemplate request fails', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: false, status: 404 }));
    await expect(fetchTemplate('missing')).rejects.toThrow('Failed to load template: HTTP 404');
  });

  it('includes presetName in createWorktree POST body when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 201,
        jsonBody: { id: 'wt-1', name: 'feature-auth', status: 'creating' },
      }),
    );

    await createWorktree({
      name: 'feature-auth',
      branchName: 'feature-auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-1',
      presetName: 'Tier-A[opus]',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.presetName).toBe('Tier-A[opus]');
  });

  it('omits presetName from createWorktree POST body when not provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 201,
        jsonBody: { id: 'wt-1', name: 'feature-auth', status: 'creating' },
      }),
    );

    await createWorktree({
      name: 'feature-auth',
      branchName: 'feature-auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-1',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.presetName).toBeUndefined();
  });
});
