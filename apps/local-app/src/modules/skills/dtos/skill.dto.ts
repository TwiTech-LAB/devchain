import { z } from 'zod';

const SKILL_SLUG_SEGMENT_REGEX = /^[a-z0-9_-]+$/i;
const SKILL_SLUG_SEGMENT_MAX_LENGTH = 64;
const SKILL_SLUG_MAX_LENGTH = SKILL_SLUG_SEGMENT_MAX_LENGTH * 2 + 1;
const SOURCE_NAME_REGEX = /^[a-z0-9_-]+$/i;

export const SkillSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(SKILL_SLUG_MAX_LENGTH)
  .transform((value) => value.toLowerCase())
  .superRefine((value, context) => {
    const segments = value.split('/');
    if (segments.length !== 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Skill slug must use source/name format.',
      });
      return;
    }

    for (const segment of segments) {
      if (segment.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Skill slug segments cannot be empty.',
        });
        return;
      }
      if (segment.length > SKILL_SLUG_SEGMENT_MAX_LENGTH) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Skill slug segments must be at most ${SKILL_SLUG_SEGMENT_MAX_LENGTH} characters.`,
        });
        return;
      }
      if (!SKILL_SLUG_SEGMENT_REGEX.test(segment)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Skill slug segments may only contain alphanumeric characters, hyphens, and underscores.',
        });
        return;
      }
    }
  });

export const SkillsRequiredInputSchema = z
  .array(SkillSlugSchema)
  .transform((slugs) => Array.from(new Set(slugs)));

export const SkillSyncRequestSchema = z
  .object({
    sourceName: z.string().trim().min(1).optional(),
  })
  .default({});

export const SkillDisableParamsSchema = z.object({
  id: z.string().uuid(),
});

export const SkillDisableBodySchema = z.object({
  projectId: z.string().uuid(),
});

export const SkillEnableParamsSchema = z.object({
  id: z.string().uuid(),
});

export const SkillEnableBodySchema = z.object({
  projectId: z.string().uuid(),
});

export const SkillDisabledQuerySchema = z.object({
  projectId: z.string().uuid(),
});

export const SkillBulkActionSchema = z.object({
  projectId: z.string().uuid(),
});

export const SkillSourceParamsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(SKILL_SLUG_SEGMENT_MAX_LENGTH)
    .transform((value) => value.toLowerCase())
    .refine((value) => SOURCE_NAME_REGEX.test(value), {
      message: 'Source name may only contain alphanumeric characters, hyphens, and underscores.',
    }),
});

export const SkillsListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  projectId: z.string().uuid().optional(),
});

export const SkillUsageStatsQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const SkillUsageLogQuerySchema = SkillUsageStatsQuerySchema.extend({
  skillId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});

export const SkillBySlugParamsSchema = z.object({
  source: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

export const SkillResolveSlugsBodySchema = z.object({
  slugs: z
    .array(SkillSlugSchema)
    .min(1)
    .max(50)
    .transform((slugs) => Array.from(new Set(slugs))),
});

export const SkillByIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface ResolvedSkillSummary {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  source: string;
  category: string | null;
  shortDescription: string | null;
  description: string | null;
}

export type SkillSyncRequestDto = z.infer<typeof SkillSyncRequestSchema>;
export type SkillDisableParamsDto = z.infer<typeof SkillDisableParamsSchema>;
export type SkillDisableBodyDto = z.infer<typeof SkillDisableBodySchema>;
export type SkillEnableParamsDto = z.infer<typeof SkillEnableParamsSchema>;
export type SkillEnableBodyDto = z.infer<typeof SkillEnableBodySchema>;
export type SkillDisabledQueryDto = z.infer<typeof SkillDisabledQuerySchema>;
export type SkillBulkActionDto = z.infer<typeof SkillBulkActionSchema>;
export type SkillSourceParamsDto = z.infer<typeof SkillSourceParamsSchema>;
export type SkillsListQueryDto = z.infer<typeof SkillsListQuerySchema>;
export type SkillUsageStatsQueryDto = z.infer<typeof SkillUsageStatsQuerySchema>;
export type SkillUsageLogQueryDto = z.infer<typeof SkillUsageLogQuerySchema>;
export type SkillBySlugParamsDto = z.infer<typeof SkillBySlugParamsSchema>;
export type SkillResolveSlugsBodyDto = z.infer<typeof SkillResolveSlugsBodySchema>;
export type SkillByIdParamsDto = z.infer<typeof SkillByIdParamsSchema>;
export type SkillSlugDto = z.infer<typeof SkillSlugSchema>;
