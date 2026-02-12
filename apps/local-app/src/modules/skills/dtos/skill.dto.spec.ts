import { ZodError } from 'zod';
import {
  SkillBulkActionSchema,
  SkillDisableBodySchema,
  SkillDisableParamsSchema,
  SkillDisabledQuerySchema,
  SkillEnableBodySchema,
  SkillEnableParamsSchema,
  SkillResolveSlugsBodySchema,
  SkillSourceParamsSchema,
  SkillSlugSchema,
  SkillsRequiredInputSchema,
} from './skill.dto';

describe('SkillSlugSchema', () => {
  it('accepts valid source/name slugs and normalizes to lowercase', () => {
    expect(SkillSlugSchema.parse(' OpenAI/Code-Review_1 ')).toBe('openai/code-review_1');
  });

  it('rejects empty string', () => {
    expect(() => SkillSlugSchema.parse('')).toThrow(ZodError);
  });

  it('rejects whitespace-only value', () => {
    expect(() => SkillSlugSchema.parse('   ')).toThrow(ZodError);
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

  it('rejects empty slug arrays', () => {
    expect(() => SkillResolveSlugsBodySchema.parse({ slugs: [] })).toThrow(ZodError);
  });

  it('rejects payloads over 50 slugs', () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `openai/skill-${index}`);
    expect(() => SkillResolveSlugsBodySchema.parse({ slugs: tooMany })).toThrow(ZodError);
  });
});

describe('Skill action schemas', () => {
  const validUuid = '00000000-0000-0000-0000-000000000001';

  it('accepts valid disable params/body', () => {
    expect(SkillDisableParamsSchema.parse({ id: validUuid })).toEqual({ id: validUuid });
    expect(SkillDisableBodySchema.parse({ projectId: validUuid })).toEqual({
      projectId: validUuid,
    });
  });

  it('accepts valid enable params/body', () => {
    expect(SkillEnableParamsSchema.parse({ id: validUuid })).toEqual({ id: validUuid });
    expect(SkillEnableBodySchema.parse({ projectId: validUuid })).toEqual({ projectId: validUuid });
  });

  it('accepts valid disabled query and bulk action payloads', () => {
    expect(SkillDisabledQuerySchema.parse({ projectId: validUuid })).toEqual({
      projectId: validUuid,
    });
    expect(SkillBulkActionSchema.parse({ projectId: validUuid })).toEqual({ projectId: validUuid });
  });

  it('rejects invalid UUIDs for action-based schemas', () => {
    expect(() => SkillDisableParamsSchema.parse({ id: 'not-a-uuid' })).toThrow(ZodError);
    expect(() => SkillDisableBodySchema.parse({ projectId: 'not-a-uuid' })).toThrow(ZodError);
    expect(() => SkillEnableParamsSchema.parse({ id: 'not-a-uuid' })).toThrow(ZodError);
    expect(() => SkillEnableBodySchema.parse({ projectId: 'not-a-uuid' })).toThrow(ZodError);
    expect(() => SkillDisabledQuerySchema.parse({ projectId: 'not-a-uuid' })).toThrow(ZodError);
    expect(() => SkillBulkActionSchema.parse({ projectId: 'not-a-uuid' })).toThrow(ZodError);
  });

  it('accepts and normalizes valid source params', () => {
    expect(SkillSourceParamsSchema.parse({ name: ' OpenAI ' })).toEqual({ name: 'openai' });
  });

  it('rejects invalid source params', () => {
    expect(() => SkillSourceParamsSchema.parse({ name: '' })).toThrow(ZodError);
    expect(() => SkillSourceParamsSchema.parse({ name: 'openai!' })).toThrow(ZodError);
  });
});
