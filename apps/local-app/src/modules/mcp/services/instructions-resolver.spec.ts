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
    expect(result?.contentMd).not.toContain('\uFFFD');
  });

  describe('reference-path UTF-8 truncation', () => {
    it('referenced prompt with 2-byte boundary cut (accented Latin)', async () => {
      const prompt: Prompt = {
        id: 'prompt-utf8',
        projectId: 'project-1',
        title: 'Accented',
        content: 'A'.repeat(13) + 'é',
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
              id: prompt.id,
              title: prompt.title,
              projectId: prompt.projectId,
              tags: [],
              version: 1,
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
      const result = await resolver.resolve('project-1', '[[prompt:Accented]]', { maxBytes: 14 });

      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(14);
      expect(result!.contentMd).not.toContain('\uFFFD');
      expect(result!.bytes).toBeLessThanOrEqual(14);
    });

    it('referenced document with 4-byte boundary cut (emoji)', async () => {
      const document: Document = {
        id: 'doc-emoji',
        projectId: 'project-1',
        title: 'Emoji',
        slug: 'emoji-doc',
        contentMd: 'A'.repeat(14) + '🎉',
        archived: false,
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const storage = {
        getDocument: jest.fn().mockResolvedValue(document),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const result = await resolver.resolve('project-1', '[[emoji-doc]]', { maxBytes: 17 });

      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(17);
      expect(result!.contentMd).not.toContain('\uFFFD');
    });

    it('referenced document with 3-byte boundary cut (CJK)', async () => {
      const document: Document = {
        id: 'doc-cjk',
        projectId: 'project-1',
        title: 'CJK',
        slug: 'cjk-doc',
        contentMd: 'AB' + '中'.repeat(20),
        archived: false,
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const storage = {
        getDocument: jest.fn().mockResolvedValue(document),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const result = await resolver.resolve('project-1', '[[cjk-doc]]', { maxBytes: 10 });

      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(10);
      expect(result!.contentMd).not.toContain('\uFFFD');
    });

    it('exact fit on multi-byte boundary: no truncation', async () => {
      const document: Document = {
        id: 'doc-exact',
        projectId: 'project-1',
        title: 'X',
        slug: 'exact',
        contentMd: 'éé',
        archived: false,
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const storage = {
        getDocument: jest.fn().mockResolvedValue(document),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const inlineExact = jest.fn(async (doc: Document) => ({
        contentMd: doc.contentMd,
        bytes: Buffer.byteLength(doc.contentMd, 'utf8'),
        truncated: false,
        depthUsed: 0,
      }));

      const resolver = new InstructionsResolver(storage, inlineExact);
      // snippet wrapping adds ~20 chars overhead; set maxBytes high enough for content but verify no FFFD
      const result = await resolver.resolve('project-1', '[[exact]]', { maxBytes: 200 });

      expect(result).not.toBeNull();
      expect(result!.contentMd).not.toContain('\uFFFD');
      expect(result!.truncated).toBe(false);
    });
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

  it('handles missing prompt gracefully — returns raw instructions', async () => {
    const storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 }),
      getPrompt: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    const resolver = new InstructionsResolver(storage, inlineStub);
    const result = await resolver.resolve('project-1', '[[prompt:Missing Prompt]]');

    expect(result).not.toBeNull();
    expect(result?.contentMd).toBe('[[prompt:Missing Prompt]]');
    expect(result?.docs).toHaveLength(0);
    expect(result?.prompts).toHaveLength(0);
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

  describe('render option', () => {
    it('instructions with ONLY variables (no refs) returns rendered content', async () => {
      const storage = {
        getDocument: jest.fn(),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const result = await resolver.resolve('project-1', 'Hello {{name}}, team: {{team_name}}', {
        render: {
          vars: { name: 'Alice', team_name: 'Backend' },
        },
      });

      expect(result).not.toBeNull();
      expect(result?.contentMd).toBe('Hello Alice, team: Backend');
      expect(result?.docs).toHaveLength(0);
      expect(result?.prompts).toHaveLength(0);
    });

    it('instructions with refs + variables: refs resolved first, then Handlebars', async () => {
      const prompt: Prompt = {
        id: 'prompt-1',
        projectId: 'project-1',
        title: 'SOP',
        content: 'Do the work for {{team_name}}.',
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
      const result = await resolver.resolve('project-1', '[[prompt:SOP]]', {
        render: {
          vars: { team_name: 'Backend' },
        },
      });

      expect(result).not.toBeNull();
      expect(result?.contentMd).toContain('Do the work for Backend.');
      expect(result?.prompts).toHaveLength(1);
    });

    it('render option omitted returns raw content without substitution', async () => {
      const storage = {
        getDocument: jest.fn(),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const result = await resolver.resolve('project-1', 'Hello {{name}}');

      expect(result).not.toBeNull();
      expect(result?.contentMd).toBe('Hello {{name}}');
    });

    it('maxBytes truncates contentMd after render and sets truncated=true', async () => {
      const storage = {
        getDocument: jest.fn(),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const longName = 'x'.repeat(10000);
      const result = await resolver.resolve('project-1', 'Hello {{name}}', {
        maxBytes: 100,
        render: { vars: { name: longName } },
      });

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(true);
      expect(result?.bytes).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(result?.contentMd ?? '', 'utf8')).toBeLessThanOrEqual(100);
    });

    it('content within cap returns truncated=false with actual byte length', async () => {
      const storage = {
        getDocument: jest.fn(),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const result = await resolver.resolve('project-1', 'Hello {{name}}', {
        maxBytes: 1000,
        render: { vars: { name: 'Alice' } },
      });

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(false);
      expect(result?.contentMd).toBe('Hello Alice');
      expect(result?.bytes).toBe(Buffer.byteLength('Hello Alice', 'utf8'));
    });

    it('refs + render combined exceeding cap truncates after render', async () => {
      const prompt: Prompt = {
        id: 'prompt-1',
        projectId: 'project-1',
        title: 'SOP',
        content: 'A'.repeat(200),
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
      const result = await resolver.resolve('project-1', '[[prompt:SOP]]', {
        maxBytes: 100,
        render: { vars: { team_name: 'Backend' } },
      });

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(true);
      expect(Buffer.byteLength(result?.contentMd ?? '', 'utf8')).toBeLessThanOrEqual(100);
    });

    it('no maxBytes configured does not truncate', async () => {
      const storage = {
        getDocument: jest.fn(),
        listDocuments: jest.fn(),
        getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      } as unknown as jest.Mocked<StorageService>;

      const resolver = new InstructionsResolver(storage, inlineStub);
      const longName = 'x'.repeat(1000);
      const result = await resolver.resolve('project-1', 'Hello {{name}}', {
        render: { vars: { name: longName } },
      });

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(false);
      expect(result?.contentMd).toBe('Hello ' + longName);
    });

    describe('UTF-8 safe truncation', () => {
      const makeStorage = () =>
        ({
          getDocument: jest.fn(),
          listDocuments: jest.fn(),
          getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
        }) as unknown as jest.Mocked<StorageService>;

      it('2-byte boundary (accented Latin): no replacement chars', async () => {
        const resolver = new InstructionsResolver(makeStorage(), inlineStub);
        const result = await resolver.resolve('project-1', '{{name}}', {
          maxBytes: 7,
          render: { vars: { name: 'é'.repeat(50) } },
        });

        expect(result).not.toBeNull();
        expect(result!.bytes).toBeLessThanOrEqual(7);
        expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(7);
        expect(result!.contentMd).not.toContain('�');
        expect(result!.truncated).toBe(true);
      });

      it('3-byte boundary (CJK)', async () => {
        const resolver = new InstructionsResolver(makeStorage(), inlineStub);
        const result = await resolver.resolve('project-1', '{{name}}', {
          maxBytes: 5,
          render: { vars: { name: '中'.repeat(50) } },
        });

        expect(result).not.toBeNull();
        expect(result!.bytes).toBeLessThanOrEqual(5);
        expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(5);
        expect(result!.contentMd).not.toContain('�');
      });

      it('4-byte boundary (emoji / astral plane)', async () => {
        const resolver = new InstructionsResolver(makeStorage(), inlineStub);
        const result = await resolver.resolve('project-1', '{{name}}', {
          maxBytes: 7,
          render: { vars: { name: '🎉'.repeat(50) } },
        });

        expect(result).not.toBeNull();
        expect(result!.bytes).toBeLessThanOrEqual(7);
        expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(7);
        expect(result!.contentMd).not.toContain('�');
      });

      it('mixed content: ASCII + accented + emoji', async () => {
        const resolver = new InstructionsResolver(makeStorage(), inlineStub);
        const result = await resolver.resolve('project-1', '{{name}}', {
          maxBytes: 10,
          render: { vars: { name: 'Aé中🎉Bñ' } },
        });

        expect(result).not.toBeNull();
        expect(result!.bytes).toBeLessThanOrEqual(10);
        expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(10);
        expect(result!.contentMd).not.toContain('�');
      });

      it('maxBytes = 0 returns empty content', async () => {
        const resolver = new InstructionsResolver(makeStorage(), inlineStub);
        const result = await resolver.resolve('project-1', 'Hello', { maxBytes: 0 });

        expect(result).not.toBeNull();
        expect(result!.contentMd).toBe('');
        expect(result!.bytes).toBe(0);
        expect(result!.truncated).toBe(true);
      });

      it('single character exceeds maxBytes', async () => {
        const resolver = new InstructionsResolver(makeStorage(), inlineStub);
        const result = await resolver.resolve('project-1', '{{name}}', {
          maxBytes: 1,
          render: { vars: { name: '🎉' } },
        });

        expect(result).not.toBeNull();
        expect(result!.contentMd).toBe('');
        expect(result!.bytes).toBe(0);
        expect(result!.truncated).toBe(true);
      });
    });
  });
});
