import {
  parseSearchQuery,
  escapeLikeWildcards,
  scoreSkillRelevance,
  sortByRelevance,
  type SkillSearchFields,
  type ParsedSearchQuery,
} from './skill-search.utils';

describe('parseSearchQuery', () => {
  it('returns null for empty string', () => {
    expect(parseSearchQuery('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(parseSearchQuery('   ')).toBeNull();
  });

  it('returns null for commas-only', () => {
    expect(parseSearchQuery(', , ,')).toBeNull();
  });

  it('trims and lowercases a single token', () => {
    expect(parseSearchQuery('  React  ')).toEqual({
      phrase: 'react',
      tokens: ['react'],
    });
  });

  it('splits on whitespace', () => {
    expect(parseSearchQuery('react typescript')).toEqual({
      phrase: 'react typescript',
      tokens: ['react', 'typescript'],
    });
  });

  it('splits on commas', () => {
    expect(parseSearchQuery('react,typescript')).toEqual({
      phrase: 'react,typescript',
      tokens: ['react', 'typescript'],
    });
  });

  it('splits on mixed whitespace and commas', () => {
    expect(parseSearchQuery('react, typescript  test')).toEqual({
      phrase: 'react, typescript  test',
      tokens: ['react', 'typescript', 'test'],
    });
  });

  it('deduplicates tokens', () => {
    expect(parseSearchQuery('react React REACT')).toEqual({
      phrase: 'react react react',
      tokens: ['react'],
    });
  });

  it('caps at 10 tokens', () => {
    const input = 'a b c d e f g h i j k l m';
    const result = parseSearchQuery(input);
    expect(result?.tokens).toHaveLength(10);
    expect(result?.tokens).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });
});

describe('escapeLikeWildcards', () => {
  it('passes through plain text', () => {
    expect(escapeLikeWildcards('react')).toBe('react');
  });

  it('escapes percent sign', () => {
    expect(escapeLikeWildcards('100%')).toBe('100\\%');
  });

  it('escapes underscore', () => {
    expect(escapeLikeWildcards('snake_case')).toBe('snake\\_case');
  });

  it('escapes backslash', () => {
    expect(escapeLikeWildcards('path\\to')).toBe('path\\\\to');
  });

  it('escapes multiple special characters', () => {
    expect(escapeLikeWildcards('%_\\')).toBe('\\%\\_\\\\');
  });
});

describe('scoreSkillRelevance', () => {
  const makeSkill = (overrides: Partial<SkillSearchFields> = {}): SkillSearchFields => ({
    slug: 'source/test-skill',
    name: 'test-skill',
    displayName: 'Test Skill',
    description: 'A skill for testing',
    shortDescription: 'test helper',
    compatibility: null,
    ...overrides,
  });

  it('scores higher for slug/name match than description-only', () => {
    const parsed: ParsedSearchQuery = { phrase: 'react', tokens: ['react'] };
    const nameMatch = makeSkill({ name: 'react-expert' });
    const descOnly = makeSkill({ name: 'generic', description: 'Helps with react development' });

    expect(scoreSkillRelevance(nameMatch, parsed)).toBeGreaterThan(
      scoreSkillRelevance(descOnly, parsed),
    );
  });

  it('scores higher when more tokens match', () => {
    const parsed: ParsedSearchQuery = {
      phrase: 'react typescript',
      tokens: ['react', 'typescript'],
    };
    const bothMatch = makeSkill({ name: 'react', description: 'typescript support' });
    const oneMatch = makeSkill({ name: 'react', description: 'generic helper' });

    expect(scoreSkillRelevance(bothMatch, parsed)).toBeGreaterThan(
      scoreSkillRelevance(oneMatch, parsed),
    );
  });

  it('gives full-phrase bonus for multi-token queries', () => {
    const parsed: ParsedSearchQuery = {
      phrase: 'code review',
      tokens: ['code', 'review'],
    };
    const phraseMatch = makeSkill({ name: 'code review' });
    const separateMatch = makeSkill({
      name: 'code helper',
      description: 'aids in review',
    });

    expect(scoreSkillRelevance(phraseMatch, parsed)).toBeGreaterThan(
      scoreSkillRelevance(separateMatch, parsed),
    );
  });

  it('returns 0 when no tokens match', () => {
    const parsed: ParsedSearchQuery = { phrase: 'xyz', tokens: ['xyz'] };
    const skill = makeSkill({ name: 'abc', description: 'def' });

    expect(scoreSkillRelevance(skill, parsed)).toBe(0);
  });

  it('checks displayName for matches', () => {
    const parsed: ParsedSearchQuery = { phrase: 'expert', tokens: ['expert'] };
    const skill = makeSkill({
      slug: 'source/generic',
      name: 'generic',
      displayName: 'React Expert',
      description: null,
    });

    expect(scoreSkillRelevance(skill, parsed)).toBe(10);
  });

  it('checks slug for matches', () => {
    const parsed: ParsedSearchQuery = { phrase: 'react', tokens: ['react'] };
    const skill = makeSkill({
      slug: 'anthropic/react-helper',
      name: 'helper',
      displayName: 'Helper',
      description: null,
    });

    expect(scoreSkillRelevance(skill, parsed)).toBe(10);
  });
});

describe('sortByRelevance', () => {
  const makeSkill = (
    slug: string,
    name: string,
    overrides: Partial<SkillSearchFields> = {},
  ): SkillSearchFields => ({
    slug,
    name,
    displayName: name,
    description: null,
    shortDescription: null,
    compatibility: null,
    ...overrides,
  });

  it('sorts by score descending', () => {
    const parsed: ParsedSearchQuery = { phrase: 'react', tokens: ['react'] };
    const items = [
      makeSkill('source/generic', 'generic', { description: 'react stuff' }),
      makeSkill('source/react', 'react'),
    ];

    const sorted = sortByRelevance(items, parsed);
    expect(sorted[0].slug).toBe('source/react');
    expect(sorted[1].slug).toBe('source/generic');
  });

  it('falls back to name then slug for equal scores', () => {
    const parsed: ParsedSearchQuery = { phrase: 'test', tokens: ['test'] };
    const items = [makeSkill('source/z-test', 'z-test'), makeSkill('source/a-test', 'a-test')];

    const sorted = sortByRelevance(items, parsed);
    expect(sorted[0].slug).toBe('source/a-test');
    expect(sorted[1].slug).toBe('source/z-test');
  });

  it('does not mutate the original array', () => {
    const parsed: ParsedSearchQuery = { phrase: 'test', tokens: ['test'] };
    const items = [makeSkill('source/z-test', 'z-test'), makeSkill('source/a-test', 'a-test')];
    const originalFirst = items[0];

    sortByRelevance(items, parsed);
    expect(items[0]).toBe(originalFirst);
  });

  it('puts multi-token matches ahead of single-token', () => {
    const parsed: ParsedSearchQuery = {
      phrase: 'react typescript',
      tokens: ['react', 'typescript'],
    };
    const items = [
      makeSkill('source/react', 'react'),
      makeSkill('source/react-ts', 'react-ts', { description: 'typescript expert' }),
    ];

    const sorted = sortByRelevance(items, parsed);
    expect(sorted[0].slug).toBe('source/react-ts');
  });
});
