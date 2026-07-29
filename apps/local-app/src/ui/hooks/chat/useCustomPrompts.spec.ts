import {
  fetchCustomPrompts,
  fetchValidatedCustomPrompt,
  type CustomPromptApiTarget,
  type PromptFetch,
} from './useCustomPrompts';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

function target(fetchFn: PromptFetch, apiBase = ''): CustomPromptApiTarget {
  return {
    projectId: 'project-1',
    apiBase,
    fetchFn,
  };
}

describe('custom prompt API', () => {
  it('loads one explicitly scoped page and classifies with the system fallback', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        items: [
          { id: 'untyped', projectId: 'project-1', title: 'Legacy', tags: [] },
          {
            id: 'system',
            projectId: 'project-1',
            title: 'System',
            tags: ['type:system'],
          },
          {
            id: 'custom',
            projectId: 'project-1',
            title: 'Custom',
            tags: ['TYPE : CUSTOM'],
          },
          {
            id: 'global-custom',
            projectId: null,
            title: 'Global custom',
            tags: ['type:custom'],
          },
        ],
        total: 4,
      }),
    );

    const signal = new AbortController().signal;
    await expect(fetchCustomPrompts(target(fetchFn), signal)).resolves.toEqual([
      expect.objectContaining({ id: 'custom' }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/prompts?projectId=project-1&limit=10000&offset=0',
      expect.objectContaining({ signal }),
    );
  });

  it('uses the explicit worktree API base and tops up a reported truncation once', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: 'one', projectId: 'project-1', title: 'One', tags: ['type:custom'] },
            { id: 'two', projectId: 'project-1', title: 'Two', tags: ['type:custom'] },
          ],
          total: 3,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 'three', projectId: 'project-1', title: 'Three', tags: ['type:custom'] }],
          total: 3,
        }),
      );

    await expect(fetchCustomPrompts(target(fetchFn, '/wt/feature'))).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      '/wt/feature/api/prompts?projectId=project-1&limit=10000&offset=0',
      expect.any(Object),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      '/wt/feature/api/prompts?projectId=project-1&limit=10000&offset=2',
      expect.any(Object),
    );
  });

  it('surfaces an incomplete list after the single top-up', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 'one', projectId: 'project-1', title: 'One', tags: ['type:custom'] }],
          total: 3,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [], total: 3 }));

    await expect(fetchCustomPrompts(target(fetchFn))).rejects.toThrow(
      'Only 1 of 3 prompts could be loaded',
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('revalidates project ownership and custom type on detail fetch', async () => {
    const validFetch = jest.fn().mockResolvedValue(
      jsonResponse({
        id: 'prompt-1',
        projectId: 'project-1',
        title: 'Prompt',
        content: 'draft input',
        tags: ['type:custom'],
      }),
    );

    await expect(fetchValidatedCustomPrompt(target(validFetch), 'prompt-1')).resolves.toEqual(
      expect.objectContaining({ content: 'draft input' }),
    );
    expect(validFetch).toHaveBeenCalledWith('/api/prompts/prompt-1', { signal: undefined });

    const wrongProjectFetch = jest.fn().mockResolvedValue(
      jsonResponse({
        id: 'prompt-1',
        projectId: 'project-2',
        title: 'Prompt',
        content: 'draft input',
        tags: ['type:custom'],
      }),
    );
    await expect(fetchValidatedCustomPrompt(target(wrongProjectFetch), 'prompt-1')).rejects.toThrow(
      'no longer belongs to this project',
    );

    const changedTypeFetch = jest.fn().mockResolvedValue(
      jsonResponse({
        id: 'prompt-1',
        projectId: 'project-1',
        title: 'Prompt',
        content: 'draft input',
        tags: ['type:system'],
      }),
    );
    await expect(fetchValidatedCustomPrompt(target(changedTypeFetch), 'prompt-1')).rejects.toThrow(
      'no longer a custom prompt',
    );
  });
});
