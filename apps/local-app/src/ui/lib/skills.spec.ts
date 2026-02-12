import { resolveSkillSlugs } from './skills';

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
