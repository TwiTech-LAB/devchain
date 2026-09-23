import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { Prompt } from '../../../storage/models/domain.models';
import { ResourceResolver } from './resource-resolver';

const PROMPT: Prompt = {
  id: 'prompt-1',
  projectId: null,
  title: 'Welcome Prompt',
  content: 'Hello world',
  tags: ['intro'],
  version: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function createStorage(): jest.Mocked<StorageService> {
  return {
    listPrompts: jest.fn().mockResolvedValue({
      items: [
        {
          ...PROMPT,
          contentPreview: PROMPT.content,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    }),
    getPrompt: jest.fn().mockResolvedValue(PROMPT),
  } as unknown as jest.Mocked<StorageService>;
}

describe('ResourceResolver', () => {
  it('returns a versioned prompt resource', async () => {
    const storage = createStorage();
    const resolver = new ResourceResolver(storage);

    const result = await resolver.resolve('prompt://Welcome%20Prompt@2');

    expect(result).toMatchObject({
      success: true,
      data: { content: 'Hello world', prompt: { id: 'prompt-1' } },
    });
    expect((result.data as { prompt: Record<string, unknown> }).prompt).not.toHaveProperty(
      'contentPreview',
    );
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-1');
  });

  it('prefers a global prompt over a project prompt with the same title and version', async () => {
    const storage = createStorage();
    storage.listPrompts.mockResolvedValue({
      items: [
        { ...PROMPT, id: 'project-prompt', projectId: 'project-1', contentPreview: 'project' },
        { ...PROMPT, id: 'global-prompt', contentPreview: 'global' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });
    const resolver = new ResourceResolver(storage);

    await resolver.resolve('prompt://Welcome%20Prompt@2');

    expect(storage.getPrompt).toHaveBeenCalledWith('global-prompt');
  });

  it('returns PROMPT_NOT_FOUND when no title/version candidate exists', async () => {
    const storage = createStorage();
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    const resolver = new ResourceResolver(storage);

    await expect(resolver.resolve('prompt://Missing@1')).resolves.toMatchObject({
      success: false,
      error: { code: 'PROMPT_NOT_FOUND' },
    });
  });

  it.each(['prompt://', 'prompt://Welcome@zero'])(
    'rejects malformed prompt URI %s',
    async (uri) => {
      const resolver = new ResourceResolver(createStorage());

      await expect(resolver.resolve(uri)).rejects.toThrow();
    },
  );

  it.each(['doc://global/readme', 'doc://readme'])(
    'returns UNKNOWN_RESOURCE for retired document URI %s',
    async (uri) => {
      const storage = createStorage();
      const resolver = new ResourceResolver(storage);

      await expect(resolver.resolve(uri)).resolves.toEqual({
        success: false,
        error: { code: 'UNKNOWN_RESOURCE', message: `Unknown resource: ${uri}` },
      });
      expect(storage.listPrompts).not.toHaveBeenCalled();
      expect(storage.getPrompt).not.toHaveBeenCalled();
    },
  );

  it('returns UNKNOWN_RESOURCE for unsupported schemes', async () => {
    const resolver = new ResourceResolver(createStorage());

    await expect(resolver.resolve('https://example.test')).resolves.toEqual({
      success: false,
      error: { code: 'UNKNOWN_RESOURCE', message: 'Unknown resource: https://example.test' },
    });
  });
});
