import {
  addLocalSource,
  addCommunitySource,
  fetchLocalSources,
  fetchCommunitySources,
  removeLocalSource,
  removeCommunitySource,
  resolveSkillSlugs,
} from './skills';

const globalFetch = (input: RequestInfo | URL, init?: RequestInit) => global.fetch(input, init);

describe('ui/lib/skills resolveSkillSlugs', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
    jest.clearAllMocks();
  });

  it('returns empty object and skips network for empty slug input', async () => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    await expect(resolveSkillSlugs(globalFetch, ['', '   '])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts deduplicated normalized slugs and returns record payload', async () => {
    const payload = {
      'openai/review': {
        id: 'skill-1',
        slug: 'openai/review',
        name: 'review',
        displayName: 'Review',
        source: 'openai',
        category: 'development',
        shortDescription: 'Short',
        description: 'Long',
      },
    };

    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(_input).toBe('/api/skills/resolve');
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(init?.body).toBe(JSON.stringify({ slugs: ['openai/review', 'anthropic/pdf'] }));
        return {
          ok: true,
          json: async () => payload,
        } as Response;
      },
    );

    const result = await resolveSkillSlugs(globalFetch, [
      ' OpenAI/Review ',
      'openai/review',
      'anthropic/pdf',
    ]);

    expect(result).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('ui/lib/skills community source api', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
    jest.clearAllMocks();
  });

  it.each([
    {
      label: 'community',
      url: '/api/skills/community-sources',
      payload: [
        {
          id: 'source-1',
          name: 'claude-skills',
          repoOwner: 'Jeffallan',
          repoName: 'claude-skills',
          branch: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      request: () => fetchCommunitySources(globalFetch),
    },
    {
      label: 'local',
      url: '/api/skills/local-sources',
      payload: [
        {
          id: 'source-1',
          name: 'local-source',
          folderPath: '/tmp/local-source',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      request: () => fetchLocalSources(globalFetch),
    },
  ])('lists $label sources', async ({ url, payload, request }) => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => payload,
    })) as unknown as typeof fetch;
    await expect(request()).resolves.toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(url, {});
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'community',
      url: '/api/skills/community-sources',
      payload: {
        id: 'source-2',
        name: 'repo',
        repoOwner: 'owner',
        repoName: 'repo',
        branch: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      input: {
        name: 'repo',
        url: 'https://github.com/owner/repo',
        branch: 'main',
      },
      request: () =>
        addCommunitySource(globalFetch, {
          name: 'repo',
          url: 'https://github.com/owner/repo',
          branch: 'main',
        }),
    },
    {
      label: 'local',
      url: '/api/skills/local-sources',
      payload: {
        id: 'source-2',
        name: 'local-source',
        folderPath: '/tmp/local-source',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      input: {
        name: 'local-source',
        folderPath: '/tmp/local-source',
      },
      request: () =>
        addLocalSource(globalFetch, { name: 'local-source', folderPath: '/tmp/local-source' }),
    },
  ])('adds $label source', async ({ url, payload, input, request }) => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => payload,
    })) as unknown as typeof fetch;
    await expect(request()).resolves.toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'community',
      url: '/api/skills/community-sources/source-3',
      request: () => removeCommunitySource(globalFetch, 'source-3'),
    },
    {
      label: 'local',
      url: '/api/skills/local-sources/source-3',
      request: () => removeLocalSource(globalFetch, 'source-3'),
    },
  ])('deletes $label source', async ({ url, request }) => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })) as unknown as typeof fetch;
    await expect(request()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(url, { method: 'DELETE' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
