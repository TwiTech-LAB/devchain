import { InstructionsResolver } from './instructions-resolver';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Document, Prompt } from '../../storage/models/domain.models';

describe('InstructionsResolver', () => {
  const inlineStub = jest.fn(async (document: Document) => ({
    contentMd: document.contentMd,
    bytes: Buffer.byteLength(document.contentMd, 'utf8'),
    truncated: false,
    depthUsed: 0,
  }));

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('expands slug references into inline content', async () => {
    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const document: Document = {
      id: 'doc-1',
      projectId: 'project-1',
      title: 'Design Guide',
      slug: 'design-guide',
      contentMd: '# Design',
      archived: false,
      version: 1,
      tags: ['guide'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    storage.getDocument.mockResolvedValue(document);

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', 'See [[design-guide]].');

    expect(result).not.toBeNull();
    expect(result?.docs).toHaveLength(1);
    expect(result?.docs?.[0]).toMatchObject({ id: 'doc-1', slug: 'design-guide' });
    expect(result?.contentMd).toContain('Design Guide');
    expect(result?.contentMd).toContain('# Design');
    expect(storage.getDocument).toHaveBeenCalledWith({
      projectId: 'project-1',
      slug: 'design-guide',
    });
  });

  it('expands tag key references using tagKey filtering', async () => {
    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const taggedDocument: Document = {
      id: 'doc-2',
      projectId: 'project-1',
      title: 'Role Playbook',
      slug: 'role-playbook',
      contentMd: 'Playbook content',
      archived: false,
      version: 1,
      tags: ['role:worker'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-03T00:00:00Z',
    };

    storage.listDocuments.mockResolvedValue({
      items: [taggedDocument],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', 'See [[#role]].');

    expect(result).not.toBeNull();
    expect(storage.listDocuments).toHaveBeenCalledWith({
      projectId: 'project-1',
      tagKeys: ['role'],
      limit: 10,
      offset: 0,
    });
    expect(result?.docs).toHaveLength(1);
    expect(result?.docs?.[0]).toMatchObject({ id: 'doc-2', slug: 'role-playbook' });
    expect(result?.contentMd).toContain('Role Playbook');
    expect(result?.contentMd).toContain('Playbook content');
  });

  it('enforces byte limits for expanded instructions content', async () => {
    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const document: Document = {
      id: 'doc-3',
      projectId: 'project-1',
      title: 'Very Long Content',
      slug: 'long',
      contentMd: 'A'.repeat(500),
      archived: false,
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    storage.getDocument.mockResolvedValue(document);

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', '[[long]]', { maxBytes: 64 });

    expect(result).not.toBeNull();
    expect(result?.truncated).toBe(true);
    expect(result?.bytes).toBe(64);
    expect(Buffer.byteLength(result?.contentMd ?? '', 'utf8')).toBeLessThanOrEqual(64);
  });

  it('expands prompt references into inline content', async () => {
    const prompt: Prompt = {
      id: 'prompt-1',
      projectId: 'project-1',
      title: 'Initialize Agent',
      content: 'You are an agent that initializes systems.',
      version: 1,
      tags: ['setup'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({
        items: [
          {
            id: prompt.id,
            title: prompt.title,
            projectId: prompt.projectId,
            tags: prompt.tags,
            version: prompt.version,
            createdAt: prompt.createdAt,
            updatedAt: prompt.updatedAt,
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
      }),
      getPrompt: jest.fn().mockResolvedValue(prompt),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', 'See [[prompt:Initialize Agent]].');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-1', title: 'Initialize Agent' });
    expect(result?.contentMd).toContain('## Prompt: Initialize Agent');
    expect(result?.contentMd).toContain('You are an agent that initializes systems.');
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: 'Initialize Agent',
      limit: 10,
    });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-1');
  });

  it('falls back to global scope for prompt references', async () => {
    const globalPrompt: Prompt = {
      id: 'prompt-global',
      projectId: null,
      title: 'Global Helper',
      content: 'Global helper content.',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest
        .fn()
        .mockResolvedValueOnce({ items: [], total: 0, limit: 10, offset: 0 })
        .mockResolvedValueOnce({
          items: [
            {
              id: globalPrompt.id,
              title: globalPrompt.title,
              projectId: globalPrompt.projectId,
              tags: globalPrompt.tags,
              version: globalPrompt.version,
              createdAt: globalPrompt.createdAt,
              updatedAt: globalPrompt.updatedAt,
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        }),
      getPrompt: jest.fn().mockResolvedValue(globalPrompt),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', '[[prompt:Global Helper]]');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-global', title: 'Global Helper' });
    expect(storage.listPrompts).toHaveBeenCalledTimes(2);
    expect(storage.listPrompts).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      q: 'Global Helper',
      limit: 10,
    });
    expect(storage.listPrompts).toHaveBeenNthCalledWith(2, {
      projectId: null,
      q: 'Global Helper',
      limit: 10,
    });
  });

  it('handles missing prompt gracefully', async () => {
    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 }),
      getPrompt: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', '[[prompt:Missing Prompt]]');

    expect(result).toBeNull();
    expect(storage.listPrompts).toHaveBeenCalledTimes(2);
    expect(storage.getPrompt).not.toHaveBeenCalled();
  });

  it('uses exact case-insensitive title match for prompts', async () => {
    const prompt: Prompt = {
      id: 'prompt-2',
      projectId: 'project-1',
      title: 'Setup Guide',
      content: 'Setup instructions here.',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'other',
            title: 'Setup',
            projectId: 'project-1',
            tags: [],
            version: 1,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: prompt.id,
            title: prompt.title,
            projectId: prompt.projectId,
            tags: prompt.tags,
            version: prompt.version,
            createdAt: prompt.createdAt,
            updatedAt: prompt.updatedAt,
          },
        ],
        total: 2,
        limit: 10,
        offset: 0,
      }),
      getPrompt: jest.fn().mockResolvedValue(prompt),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', '[[prompt:setup guide]]');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-2', title: 'Setup Guide' });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-2');
  });

  it('uses first match and logs warning when multiple prompts have same title', async () => {
    const firstPrompt: Prompt = {
      id: 'prompt-first',
      projectId: 'project-1',
      title: 'Duplicate Title',
      content: 'First prompt content.',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'prompt-first',
            title: 'Duplicate Title',
            projectId: 'project-1',
            tags: [],
            version: 1,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'prompt-second',
            title: 'Duplicate Title',
            projectId: 'project-1',
            tags: [],
            version: 1,
            createdAt: '2024-01-02T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
        ],
        total: 2,
        limit: 10,
        offset: 0,
      }),
      getPrompt: jest.fn().mockResolvedValue(firstPrompt),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', '[[prompt:Duplicate Title]]');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-first', title: 'Duplicate Title' });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-first');
    expect(result?.contentMd).toContain('First prompt content.');
  });
});
