import { ZodError } from 'zod';
import {
  SkillResolveSlugsBodySchema,
  SkillSourceParamsSchema,
  SkillSlugSchema,
  SkillsRequiredInputSchema,
} from './skill.dto';

describe('SkillSlugSchema', () => {
  it('accepts valid source/name slugs and normalizes to lowercase', () => {
    expect(SkillSlugSchema.parse(' OpenAI/Code-Review_1 ')).toBe('openai/code-review_1');
  });

  it('rejects missing slash format', () => {
    expect(() => SkillSlugSchema.parse('openai')).toThrow(ZodError);
  });

  it('rejects path traversal-like values', () => {
    expect(() => SkillSlugSchema.parse('../traversal')).toThrow(ZodError);
  });

  it('rejects special characters', () => {
    expect(() => SkillSlugSchema.parse('openai/review!')).toThrow(ZodError);
  });
});

describe('SkillsRequiredInputSchema', () => {
  it('deduplicates normalized slugs while preserving first-seen order', () => {
    expect(
      SkillsRequiredInputSchema.parse([' OpenAI/Review ', 'openai/review', 'anthropic/pdf']),
    ).toEqual(['openai/review', 'anthropic/pdf']);
  });
});

describe('SkillResolveSlugsBodySchema', () => {
  it('accepts, normalizes, and deduplicates slugs', () => {
    expect(
      SkillResolveSlugsBodySchema.parse({
        slugs: [' OpenAI/Review ', 'openai/review', 'anthropic/pdf'],
      }),
    ).toEqual({ slugs: ['openai/review', 'anthropic/pdf'] });
  });
});

describe('Skill action schemas', () => {
  it('accepts and normalizes valid source params', () => {
    expect(SkillSourceParamsSchema.parse({ name: ' OpenAI ' })).toEqual({ name: 'openai' });
  });

  it('rejects invalid source params', () => {
    expect(() => SkillSourceParamsSchema.parse({ name: '' })).toThrow(ZodError);
    expect(() => SkillSourceParamsSchema.parse({ name: 'openai!' })).toThrow(ZodError);
  });
});
