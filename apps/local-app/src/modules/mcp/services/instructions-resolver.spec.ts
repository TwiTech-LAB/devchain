import { InstructionsResolver } from './instructions-resolver';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Prompt } from '../../storage/models/domain.models';

// Retired document lookups stay observable as explicit spies even though the
// production StorageService no longer exposes a document API.
type DocumentLookupSpies = {
  getDocument: jest.Mock;
  listDocuments: jest.Mock;
};

function promptSummary(prompt: Prompt) {
  return {
    id: prompt.id,
    title: prompt.title,
    projectId: prompt.projectId,
    tags: prompt.tags,
    version: prompt.version,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
  };
}

describe('InstructionsResolver', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function createStorage(
    items: Array<{ prompt: Prompt }> = [],
  ): jest.Mocked<StorageService> & DocumentLookupSpies {
    return {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({
        items: items.map(({ prompt }) => promptSummary(prompt)),
        total: items.length,
        limit: 10,
        offset: 0,
      }),
      getPrompt: jest
        .fn()
        .mockImplementation(
          async (id: string) => items.find(({ prompt }) => prompt.id === id)?.prompt ?? null,
        ),
    } as unknown as jest.Mocked<StorageService> & DocumentLookupSpies;
  }

  const PROMPT: Prompt = {
    id: 'prompt-1',
    projectId: 'project-1',
    title: 'Initialize Agent',
    content: 'You are an agent that initializes systems.',
    version: 1,
    tags: ['setup'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  };

  it('expands prompt references into inline content', async () => {
    const storage = createStorage([{ prompt: PROMPT }]);

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', 'See [[prompt:Initialize Agent]].');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-1', title: 'Initialize Agent' });
    expect(result?.contentMd).toContain('## Prompt: Initialize Agent');
    expect(result?.contentMd).toContain('You are an agent that initializes systems.');
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: 'Initialize Agent',
      limit: 10000,
      offset: 0,
    });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-1');
  });

  it('performs no document lookup for legacy slug and tag references and keeps original text', async () => {
    const storage = createStorage();
    const resolver = new InstructionsResolver(storage);
    const instructions = 'See [[some-slug]] and [[#role:worker]].';

    const result = await resolver.resolve('project-1', instructions);

    expect(result).not.toBeNull();
    expect(result?.contentMd).toBe(instructions);
    expect(result?.prompts).toHaveLength(0);
    expect(result?.truncated).toBe(false);
    expect(storage.getDocument).not.toHaveBeenCalled();
    expect(storage.listDocuments).not.toHaveBeenCalled();
    expect(storage.listPrompts).not.toHaveBeenCalled();
  });

  it('caps expanded prompts at maxPrompts and marks the result truncated', async () => {
    const prompts = [1, 2, 3].map(
      (n): Prompt => ({
        id: `prompt-${n}`,
        projectId: 'project-1',
        title: `SOP ${n}`,
        content: `Content ${n}`,
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }),
    );
    const storage = createStorage(prompts.map((prompt) => ({ prompt })));

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve(
      'project-1',
      '[[prompt:SOP 1]] [[prompt:SOP 2]] [[prompt:SOP 3]]',
      { maxPrompts: 2 },
    );

    expect(result?.prompts).toHaveLength(2);
    expect(result?.contentMd).toContain('## Prompt: SOP 1');
    expect(result?.contentMd).toContain('## Prompt: SOP 2');
    expect(result?.contentMd).not.toContain('## Prompt: SOP 3');
    expect(result?.truncated).toBe(true);
  });

  it('enforces byte limits for expanded instructions content', async () => {
    const longPrompt: Prompt = {
      ...PROMPT,
      id: 'prompt-long',
      title: 'Very Long Content',
      content: 'A'.repeat(500),
    };
    const storage = createStorage([{ prompt: longPrompt }]);

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:Very Long Content]]', {
      maxBytes: 64,
    });

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
      const storage = createStorage([{ prompt }]);

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', '[[prompt:Accented]]', { maxBytes: 14 });

      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(14);
      expect(result!.contentMd).not.toContain('\uFFFD');
      expect(result!.bytes).toBeLessThanOrEqual(14);
    });

    it('referenced prompt with 4-byte boundary cut (emoji)', async () => {
      const prompt: Prompt = {
        id: 'prompt-emoji',
        projectId: 'project-1',
        title: 'Emoji',
        content: 'A'.repeat(14) + '🎉',
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      const storage = createStorage([{ prompt }]);

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', '[[prompt:Emoji]]', { maxBytes: 17 });

      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(17);
      expect(result!.contentMd).not.toContain('\uFFFD');
    });

    it('referenced prompt with 3-byte boundary cut (CJK)', async () => {
      const prompt: Prompt = {
        id: 'prompt-cjk',
        projectId: 'project-1',
        title: 'CJK',
        content: 'AB' + '中'.repeat(20),
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      const storage = createStorage([{ prompt }]);

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', '[[prompt:CJK]]', { maxBytes: 10 });

      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result!.contentMd, 'utf8')).toBeLessThanOrEqual(10);
      expect(result!.contentMd).not.toContain('\uFFFD');
    });

    it('exact fit on multi-byte boundary: no truncation', async () => {
      const prompt: Prompt = {
        id: 'prompt-exact',
        projectId: 'project-1',
        title: 'X',
        content: 'éé',
        version: 1,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      const storage = createStorage([{ prompt }]);

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', '[[prompt:X]]', { maxBytes: 200 });

      expect(result).not.toBeNull();
      expect(result!.contentMd).not.toContain('\uFFFD');
      expect(result!.truncated).toBe(false);
    });
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
    const storage = createStorage();
    storage.listPrompts = jest
      .fn()
      .mockResolvedValueOnce({ items: [], total: 0, limit: 10, offset: 0 })
      .mockResolvedValueOnce({
        items: [promptSummary(globalPrompt)],
        total: 1,
        limit: 10,
        offset: 0,
      });
    storage.getPrompt = jest.fn().mockResolvedValue(globalPrompt);

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:Global Helper]]');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-global', title: 'Global Helper' });
    expect(storage.listPrompts).toHaveBeenCalledTimes(2);
    expect(storage.listPrompts).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      q: 'Global Helper',
      limit: 10000,
      offset: 0,
    });
    expect(storage.listPrompts).toHaveBeenNthCalledWith(2, {
      projectId: null,
      q: 'Global Helper',
      limit: 10000,
      offset: 0,
    });
  });

  it('handles missing prompt gracefully — returns raw instructions', async () => {
    const storage = createStorage();

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:Missing Prompt]]');

    expect(result).not.toBeNull();
    expect(result?.contentMd).toBe('[[prompt:Missing Prompt]]');
    expect(result?.prompts).toHaveLength(0);
    expect(storage.listPrompts).toHaveBeenCalledTimes(2);
    expect(storage.getPrompt).not.toHaveBeenCalled();
  });

  it('uses exact case-insensitive title match for prompts', async () => {
    const distractor: Prompt = {
      ...PROMPT,
      id: 'other',
      title: 'Setup',
    };
    const target: Prompt = {
      ...PROMPT,
      id: 'prompt-2',
      title: 'Setup Guide',
      content: 'Setup instructions here.',
    };
    const storage = createStorage([{ prompt: distractor }, { prompt: target }]);

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:setup guide]]');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-2', title: 'Setup Guide' });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-2');
  });

  it('uses first match and logs warning when multiple prompts have same title', async () => {
    const firstPrompt: Prompt = {
      ...PROMPT,
      id: 'prompt-first',
      title: 'Duplicate Title',
      content: 'First prompt content.',
    };
    const secondPrompt: Prompt = {
      ...PROMPT,
      id: 'prompt-second',
      title: 'Duplicate Title',
      content: 'Second prompt content.',
      createdAt: '2024-01-02T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };
    const storage = createStorage([{ prompt: firstPrompt }, { prompt: secondPrompt }]);

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:Duplicate Title]]');

    expect(result).not.toBeNull();
    expect(result?.prompts).toHaveLength(1);
    expect(result?.prompts?.[0]).toMatchObject({ id: 'prompt-first', title: 'Duplicate Title' });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-first');
    expect(result?.contentMd).toContain('First prompt content.');
  });

  it('exact-filters distractors and prefers a project System prompt over a Custom duplicate', async () => {
    const summaries = [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `distractor-${index}`,
        projectId: 'project-1',
        title: `Shared SOP ${index}`,
        tags: ['type:system'],
        version: 1,
        createdAt: '',
        updatedAt: '',
      })),
      {
        id: 'prompt-custom',
        projectId: 'project-1',
        title: 'Shared SOP',
        tags: ['type:custom'],
        version: 1,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'prompt-system',
        projectId: 'project-1',
        title: 'SHARED SOP',
        tags: ['type:system'],
        version: 1,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const systemPrompt: Prompt = {
      id: 'prompt-system',
      projectId: 'project-1',
      title: 'SHARED SOP',
      content: 'shared instructions',
      version: 1,
      tags: ['type:system'],
      createdAt: '',
      updatedAt: '',
    };
    const storage = {
      listPrompts: jest.fn().mockResolvedValue({
        items: summaries,
        total: summaries.length,
        limit: 10000,
        offset: 0,
      }),
      getPrompt: jest.fn().mockResolvedValue(systemPrompt),
    } as unknown as jest.Mocked<StorageService> & DocumentLookupSpies;

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:shared sop]]');

    expect(result?.prompts).toEqual([{ id: 'prompt-system', title: 'SHARED SOP' }]);
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: 'shared sop',
      limit: 10000,
      offset: 0,
    });
    expect(storage.getPrompt).toHaveBeenCalledWith('prompt-system');
  });

  it('keeps project scope ahead of a global System candidate', async () => {
    const projectPrompt: Prompt = {
      id: 'project-custom',
      projectId: 'project-1',
      title: 'Scoped',
      content: 'project content',
      version: 1,
      tags: ['type:custom'],
      createdAt: '',
      updatedAt: '',
    };
    const storage = {
      listPrompts: jest.fn().mockResolvedValue({
        items: [promptSummary(projectPrompt)],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      getPrompt: jest.fn().mockResolvedValue(projectPrompt),
    } as unknown as jest.Mocked<StorageService> & DocumentLookupSpies;

    const resolver = new InstructionsResolver(storage);
    const result = await resolver.resolve('project-1', '[[prompt:SCOPED]]');

    expect(result?.prompts).toEqual([{ id: 'project-custom', title: 'Scoped' }]);
    expect(storage.listPrompts).toHaveBeenCalledTimes(1);
  });

  describe('render option', () => {
    it('instructions with ONLY variables (no refs) returns rendered content', async () => {
      const storage = createStorage();

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', 'Hello {{name}}, team: {{team_name}}', {
        render: {
          vars: { name: 'Alice', team_name: 'Backend' },
        },
      });

      expect(result).not.toBeNull();
      expect(result?.contentMd).toBe('Hello Alice, team: Backend');
      expect(result?.prompts).toHaveLength(0);
    });

    it('instructions with refs + variables: refs resolved first, then Handlebars', async () => {
      const prompt: Prompt = {
        ...PROMPT,
        title: 'SOP',
        content: 'Do the work for {{team_name}}.',
      };
      const storage = createStorage([{ prompt }]);

      const resolver = new InstructionsResolver(storage);
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
      const storage = createStorage();

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', 'Hello {{name}}');

      expect(result).not.toBeNull();
      expect(result?.contentMd).toBe('Hello {{name}}');
    });

    it('maxBytes truncates contentMd after render and sets truncated=true', async () => {
      const storage = createStorage();

      const resolver = new InstructionsResolver(storage);
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
      const storage = createStorage();

      const resolver = new InstructionsResolver(storage);
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
        ...PROMPT,
        title: 'SOP',
        content: 'A'.repeat(200),
      };
      const storage = createStorage([{ prompt }]);

      const resolver = new InstructionsResolver(storage);
      const result = await resolver.resolve('project-1', '[[prompt:SOP]]', {
        maxBytes: 100,
        render: { vars: { team_name: 'Backend' } },
      });

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(true);
      expect(Buffer.byteLength(result?.contentMd ?? '', 'utf8')).toBeLessThanOrEqual(100);
    });

    it('no maxBytes configured does not truncate', async () => {
      const storage = createStorage();

      const resolver = new InstructionsResolver(storage);
      const longName = 'x'.repeat(1000);
      const result = await resolver.resolve('project-1', 'Hello {{name}}', {
        render: { vars: { name: longName } },
      });

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(false);
      expect(result?.contentMd).toBe('Hello ' + longName);
    });

    describe('UTF-8 safe truncation', () => {
      const makeStorage = () => createStorage();

      it('2-byte boundary (accented Latin): no replacement chars', async () => {
        const resolver = new InstructionsResolver(makeStorage());
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
        const resolver = new InstructionsResolver(makeStorage());
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
        const resolver = new InstructionsResolver(makeStorage());
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
        const resolver = new InstructionsResolver(makeStorage());
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
        const resolver = new InstructionsResolver(makeStorage());
        const result = await resolver.resolve('project-1', 'Hello', { maxBytes: 0 });

        expect(result).not.toBeNull();
        expect(result!.contentMd).toBe('');
        expect(result!.bytes).toBe(0);
        expect(result!.truncated).toBe(true);
      });

      it('single character exceeds maxBytes', async () => {
        const resolver = new InstructionsResolver(makeStorage());
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
