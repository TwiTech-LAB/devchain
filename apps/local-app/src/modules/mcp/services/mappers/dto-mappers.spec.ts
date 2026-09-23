import { createMockEpic } from '../../../../../test/factories';
import type { Prompt, Skill } from '../../../storage/models/domain.models';
import {
  buildDescriptionPreview,
  mapEpicListItem,
  mapEpicParent,
  mapEpicSummary,
  mapPromptDetail,
  mapSkillDetail,
} from './dto-mappers';

const TEST_SKILL: Skill = {
  id: 'skill-1',
  slug: 'source/testing',
  name: 'testing',
  displayName: 'Testing',
  description: 'Test skill',
  shortDescription: 'Tests',
  source: 'source',
  sourceUrl: null,
  sourceCommit: null,
  category: null,
  license: 'MIT',
  compatibility: null,
  frontmatter: null,
  instructionContent: 'Instructions',
  contentPath: null,
  resources: ['guides/one.md'],
  status: 'available',
  lastSyncedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const TEST_PROMPT: Prompt = {
  id: 'prompt-1',
  projectId: null,
  title: 'Welcome Prompt',
  content: 'Hello world',
  tags: ['intro'],
  version: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('mapSkillDetail', () => {
  it('drops frontmatter keys the detail already carries top-level', () => {
    const detail = mapSkillDetail({
      ...TEST_SKILL,
      frontmatter: {
        name: 'testing',
        description: 'Test skill',
        license: 'MIT',
        compatibility: null,
        resources: ['guides/one.md'],
        version: '1.2.0',
        metadata: { author: 'DevChain', triggers: ['test'] },
      },
    });

    expect(detail.frontmatter).toEqual({
      version: '1.2.0',
      metadata: { author: 'DevChain', triggers: ['test'] },
    });
    expect(detail.frontmatter).not.toHaveProperty('name');
    expect(detail.name).toBe('testing');
    expect(detail.license).toBe('MIT');
    expect(detail.resources).toEqual(['guides/one.md']);
  });

  it('returns null frontmatter when only duplicated keys remain', () => {
    const detail = mapSkillDetail({
      ...TEST_SKILL,
      frontmatter: { name: 'testing', description: 'Test skill' },
    });

    expect(detail.frontmatter).toBeNull();
  });

  it('returns null frontmatter for a null value and keeps the stored object untouched', () => {
    const frontmatter = { name: 'testing', version: '2.0.0' };
    const skill: Skill = { ...TEST_SKILL, frontmatter };
    const detail = mapSkillDetail(skill);

    expect(detail.frontmatter).toEqual({ version: '2.0.0' });
    expect(skill.frontmatter).toBe(frontmatter);
    expect(frontmatter).toEqual({ name: 'testing', version: '2.0.0' });
  });
});

describe('mapPromptDetail', () => {
  it('returns the full content without a redundant preview', () => {
    const detail = mapPromptDetail({ ...TEST_PROMPT, content: 'x'.repeat(500) });

    expect(detail).toEqual({
      id: 'prompt-1',
      projectId: null,
      title: 'Welcome Prompt',
      content: 'x'.repeat(500),
      tags: ['intro'],
      version: 2,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    expect(detail).not.toHaveProperty('contentPreview');
  });
});

describe('mapEpicParent', () => {
  const agentNames = new Map([['agent-1', 'Parent Agent']]);

  it('returns a summary with the status label and no description by default', () => {
    const parent = mapEpicParent(
      createMockEpic({
        id: 'parent-1',
        title: 'Parent Epic',
        description: 'Large phase context',
        agentId: 'agent-1',
        statusId: 'status-1',
      }),
      agentNames,
      'In Progress',
    );

    expect(parent).toEqual({
      id: 'parent-1',
      title: 'Parent Epic',
      status: 'In Progress',
      agentName: 'Parent Agent',
    });
    expect(parent).not.toHaveProperty('description');
  });

  it('omits the status when no label resolves and keeps a null agentName unassigned', () => {
    const parent = mapEpicParent(createMockEpic({ id: 'parent-2' }), new Map());

    expect(parent).toEqual({ id: 'parent-2', title: 'Test Epic', agentName: null });
    expect(parent).not.toHaveProperty('status');
  });

  it('includes the full description only when asked', () => {
    const parent = mapEpicParent(
      createMockEpic({ id: 'parent-3', description: 'Phase context' }),
      new Map(),
      undefined,
      true,
    );

    expect(parent.description).toBe('Phase context');
  });
});

describe('mapEpicSummary', () => {
  it.each([
    ['an agent snapshot', 'Creator Agent'],
    ['null attribution', null],
  ])('maps createdBy for %s', (_label, createdBy) => {
    const summary = mapEpicSummary(createMockEpic({ createdBy }));

    expect(summary.createdBy).toBe(createdBy);
  });
});

describe('buildDescriptionPreview', () => {
  it('returns null and zero for null and empty descriptions', () => {
    expect(buildDescriptionPreview(null)).toEqual({
      descriptionPreview: null,
      descriptionLength: 0,
    });
    expect(buildDescriptionPreview('')).toEqual({ descriptionPreview: null, descriptionLength: 0 });
  });

  it('returns short text uncut with no ellipsis', () => {
    const text = 'a'.repeat(300);
    expect(buildDescriptionPreview(text)).toEqual({
      descriptionPreview: text,
      descriptionLength: 300,
    });
    expect(buildDescriptionPreview('Short text')).toEqual({
      descriptionPreview: 'Short text',
      descriptionLength: 10,
    });
  });

  it('cuts long text at the last word boundary before 300 and marks the cut', () => {
    const text = `${'word '.repeat(59).trim()} boundaryrest ${'tail '.repeat(50)}`;
    const result = buildDescriptionPreview(text);

    const hardCut = text.slice(0, 300);
    const boundary = hardCut.lastIndexOf(' ');
    expect(boundary).toBeGreaterThan(0);
    expect(result).toEqual({
      descriptionPreview: `${hardCut.slice(0, boundary)}…`,
      descriptionLength: text.length,
    });
    expect(result.descriptionPreview!.endsWith('…')).toBe(true);
    expect(result.descriptionPreview).not.toContain('boundaryrest');
  });

  it('hard-cuts at 300 when the first word is longer than the limit', () => {
    const text = `${'a'.repeat(350)} trailing words`;
    const result = buildDescriptionPreview(text);

    expect(result).toEqual({
      descriptionPreview: `${'a'.repeat(300)}…`,
      descriptionLength: text.length,
    });
  });
});

describe('mapEpicListItem', () => {
  it('replaces the description with preview fields by default', () => {
    const item = mapEpicListItem(createMockEpic({ description: 'Full description text' }));

    expect(item.description).toBeUndefined();
    expect(item.descriptionPreview).toBe('Full description text');
    expect(item.descriptionLength).toBe(21);
    expect(item.id).toBe('epic-test-1');
    expect(item.title).toBe('Test Epic');
  });

  it('returns the full description when includeDescription is set', () => {
    const longText = `${'a'.repeat(400)} end`;
    const item = mapEpicListItem(createMockEpic({ description: longText }), undefined, true);

    expect(item.description).toBe(longText);
    expect(item.descriptionPreview).toBeUndefined();
    expect(item.descriptionLength).toBeUndefined();
  });

  it('maps a null description to a null preview with zero length', () => {
    const item = mapEpicListItem(createMockEpic({ description: null }));

    expect(item.description).toBeUndefined();
    expect(item.descriptionPreview).toBeNull();
    expect(item.descriptionLength).toBe(0);
  });
});
