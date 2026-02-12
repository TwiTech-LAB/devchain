import { ZodError } from 'zod';
import { CreateCommunitySourceSchema, parseGitHubRepoUrl } from './community-sources.dto';

describe('CommunitySources DTO', () => {
  it('parses standard github repository URL', () => {
    const result = parseGitHubRepoUrl('https://github.com/JeffAllan/claude-skills');

    expect(result).toEqual({
      repoOwner: 'JeffAllan',
      repoName: 'claude-skills',
    });
  });

  it('parses github repository URL with trailing .git', () => {
    const result = parseGitHubRepoUrl('https://github.com/openai/skills.git');

    expect(result).toEqual({
      repoOwner: 'openai',
      repoName: 'skills',
    });
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
    });
  });

  it('returns ZodError for non-github hosts in schema parsing', () => {
    expect(() =>
      CreateCommunitySourceSchema.parse({
        name: 'jeffallan',
        url: 'https://gitlab.com/openai/skills',
      }),
    ).toThrow(ZodError);

    const result = CreateCommunitySourceSchema.safeParse({
      name: 'jeffallan',
      url: 'https://gitlab.com/openai/skills',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('Only github.com URLs are supported.');
    }
  });

  it('returns ZodError for invalid URL format', () => {
    expect(() =>
      CreateCommunitySourceSchema.parse({
        name: 'jeffallan',
        url: 'not-a-url',
      }),
    ).toThrow(ZodError);
  });

  it('returns ZodError for missing owner segment', () => {
    expect(() =>
      CreateCommunitySourceSchema.parse({
        name: 'jeffallan',
        url: 'https://github.com/',
      }),
    ).toThrow(ZodError);

    const result = CreateCommunitySourceSchema.safeParse({
      name: 'jeffallan',
      url: 'https://github.com/',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain(
        'GitHub URL must include owner and repository.',
      );
    }
  });

  it('returns ZodError for missing owner/repository segments', () => {
    expect(() =>
      CreateCommunitySourceSchema.parse({
        name: 'jeffallan',
        url: 'https://github.com/openai',
      }),
    ).toThrow(ZodError);

    const result = CreateCommunitySourceSchema.safeParse({
      name: 'jeffallan',
      url: 'https://github.com/openai',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain(
        'GitHub URL must include owner and repository.',
      );
    }
  });

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
