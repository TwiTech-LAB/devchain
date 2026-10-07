import { ZodError } from 'zod';
import { CreateCommunitySourceSchema, parseGitHubRepoUrl } from './community-sources.dto';

describe('CommunitySources DTO', () => {
  it.each([
    [
      'https://github.com/JeffAllan/claude-skills',
      { repoOwner: 'JeffAllan', repoName: 'claude-skills' },
    ],
    ['https://github.com/openai/skills.git', { repoOwner: 'openai', repoName: 'skills' }],
  ])('parses GitHub URL %s', (url, expected) => {
    expect(parseGitHubRepoUrl(url)).toEqual(expected);
  });

  it('rejects non-github hosts', () => {
    expect(() => parseGitHubRepoUrl('https://gitlab.com/openai/skills')).toThrow(
      'Only github.com URLs are supported.',
    );
  });

  it('normalizes create payload using github url', () => {
    const parsed = CreateCommunitySourceSchema.parse({
      name: 'jeffallan',
      url: 'https://github.com/JeffAllan/claude-skills',
      branch: 'main',
    });

    expect(parsed).toEqual({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'claude-skills',
      branch: 'main',
      existingProjects: { mode: 'none' },
    });
  });

  it.each([
    [
      {
        name: 'jeffallan',
        url: 'https://github.com/JeffAllan/claude-skills',
        existingProjects: { mode: 'all' },
      },
    ],
    [
      {
        name: 'jeffallan',
        repoOwner: 'JeffAllan',
        repoName: 'claude-skills',
        existingProjects: {
          mode: 'selected',
          projectIds: ['00000000-0000-0000-0000-000000000002'],
        },
      },
    ],
  ])('preserves existingProjects for %j', (input) => {
    expect(CreateCommunitySourceSchema.parse(input)).toMatchObject({
      repoOwner: 'JeffAllan',
      repoName: 'claude-skills',
      branch: 'main',
      existingProjects: input.existingProjects,
    });
  });

  it('returns ZodError for invalid URL format', () => {
    expect(() =>
      CreateCommunitySourceSchema.parse({
        name: 'jeffallan',
        url: 'not-a-url',
      }),
    ).toThrow(ZodError);
  });

  it.each([['https://github.com/'], ['https://github.com/openai']])(
    'rejects missing GitHub segments in %s',
    (url) => {
      const input = { name: 'jeffallan', url };
      expect(() => CreateCommunitySourceSchema.parse(input)).toThrow(ZodError);
      const result = CreateCommunitySourceSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(JSON.stringify(result.error.issues)).toContain(
          'GitHub URL must include owner and repository.',
        );
    },
  );

  it('returns ZodError for invalid owner/repository characters', () => {
    expect(() =>
      CreateCommunitySourceSchema.parse({
        name: 'jeffallan',
        url: 'https://github.com/openai^/skills',
      }),
    ).toThrow(ZodError);

    const result = CreateCommunitySourceSchema.safeParse({
      name: 'jeffallan',
      url: 'https://github.com/openai^/skills',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain(
        'GitHub owner or repository contains invalid characters.',
      );
    }
  });
});
