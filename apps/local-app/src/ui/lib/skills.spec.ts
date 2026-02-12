import {
  addCommunitySource,
  fetchCommunitySources,
  removeCommunitySource,
  resolveSkillSlugs,
} from './skills';

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

    await expect(resolveSkillSlugs(['', '   '])).resolves.toEqual({});
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

    const result = await resolveSkillSlugs([' OpenAI/Review ', 'openai/review', 'anthropic/pdf']);

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

  it('fetchCommunitySources requests community source list', async () => {
    const payload = [
      {
        id: 'source-1',
        name: 'claude-skills',
        repoOwner: 'Jeffallan',
        repoName: 'claude-skills',
        branch: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe('/api/skills/community-sources');
      return {
        ok: true,
        json: async () => payload,
      } as Response;
    });

    await expect(fetchCommunitySources()).resolves.toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('addCommunitySource posts payload to community source endpoint', async () => {
    const payload = {
      id: 'source-2',
      name: 'repo',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('/api/skills/community-sources');
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(init?.body).toBe(
          JSON.stringify({
            name: 'repo',
            url: 'https://github.com/owner/repo',
            branch: 'main',
          }),
        );
        return {
          ok: true,
          json: async () => payload,
        } as Response;
      },
    );

    await expect(
      addCommunitySource({
        name: 'repo',
        url: 'https://github.com/owner/repo',
        branch: 'main',
      }),
    ).resolves.toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('removeCommunitySource sends delete request by id', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('/api/skills/community-sources/source-3');
        expect(init?.method).toBe('DELETE');
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as Response;
      },
    );

    await expect(removeCommunitySource('source-3')).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
