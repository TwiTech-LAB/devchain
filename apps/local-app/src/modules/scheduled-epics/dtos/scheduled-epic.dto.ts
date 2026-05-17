import { z } from 'zod';
import { validateCronExpression } from '../helpers/cron-helpers';
import { validateTimezone } from '../helpers/timezone-helpers';
import { checkTemplateReady } from '../helpers/template-helpers';

const CronExpressionSchema = z
  .string()
  .min(1)
  .superRefine((expr, ctx) => {
    const result = validateCronExpression(expr);
    if (!result.valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
    }
  });

const TimezoneSchema = z
  .string()
  .min(1)
  .superRefine((tz, ctx) => {
    const result = validateTimezone(tz);
    if (!result.valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
    }
  });

const HandlebarsTemplateSchema = z
  .string()
  .min(1)
  .superRefine((tpl, ctx) => {
    const result = checkTemplateReady(tpl);
    if (!result.ready) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
    }
  });

export const CreateScheduledEpicDtoSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(200),
    cronExpression: CronExpressionSchema,
    timezone: TimezoneSchema,
    enabled: z.boolean().optional().default(true),
    titleTemplate: HandlebarsTemplateSchema,
    descriptionTemplate: z
      .string()
      .superRefine((tpl, ctx) => {
        if (tpl.length === 0) return;
        const result = checkTemplateReady(tpl);
        if (!result.ready) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
        }
      })
      .optional()
      .nullable(),
    templateStatusId: z.string().uuid().optional().nullable(),
    templateParentEpicId: z.string().uuid().optional().nullable(),
    templateAgentId: z.string().uuid().optional().nullable(),
    templateTags: z.array(z.string().min(1)).optional().default([]),
    allowOverlap: z.boolean().optional().default(false),
    missedRunPolicy: z.enum(['skip', 'run_once', 'run_all']).optional().default('skip'),
    nextRunAt: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

export type CreateScheduledEpicDto = z.infer<typeof CreateScheduledEpicDtoSchema>;

export const UpdateScheduledEpicDtoSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    cronExpression: CronExpressionSchema.optional(),
    timezone: TimezoneSchema.optional(),
    enabled: z.boolean().optional(),
    titleTemplate: HandlebarsTemplateSchema.optional(),
    descriptionTemplate: z
      .string()
      .superRefine((tpl, ctx) => {
        if (tpl.length === 0) return;
        const result = checkTemplateReady(tpl);
        if (!result.ready) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
        }
      })
      .optional()
      .nullable(),
    templateStatusId: z.string().uuid().optional().nullable(),
    templateParentEpicId: z.string().uuid().optional().nullable(),
    templateAgentId: z.string().uuid().optional().nullable(),
    templateTags: z.array(z.string().min(1)).optional(),
    allowOverlap: z.boolean().optional(),
    missedRunPolicy: z.enum(['skip', 'run_once', 'run_all']).optional(),
  })
  .strict();

export type UpdateScheduledEpicDto = z.infer<typeof UpdateScheduledEpicDtoSchema>;
