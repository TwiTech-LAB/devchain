import { z } from 'zod';

export const PromptSummarySchema = z.object({
  promptId: z.string(),
  title: z.string(),
  order: z.number().int().min(1),
});

export const AgentProfileWithPromptsSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  familySlug: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  instructions: z.string().nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  prompts: z.array(PromptSummarySchema),
});

export type AgentProfileWithPrompts = z.infer<typeof AgentProfileWithPromptsSchema>;

// ============================================
// PROFILE PROVIDER CONFIGS
// ============================================

/**
 * Environment variables schema.
 * Keys must be valid env var names (alphanumeric + underscore, starting with letter/underscore).
 * Values must not contain control characters.
 */
const EnvKeyRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ControlCharRegex = /[\x00-\x1f]/;

export const EnvVarsSchema = z
  .record(z.string())
  .refine((env) => Object.keys(env).every((key) => EnvKeyRegex.test(key)), {
    message:
      'Environment variable keys must contain only alphanumeric characters and underscores, starting with a letter or underscore',
  })
  .refine((env) => Object.values(env).every((value) => !ControlCharRegex.test(value)), {
    message: 'Environment variable values must not contain control characters or newlines',
  })
  .nullable()
  .optional();

export const ProfileProviderConfigSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  providerId: z.string(),
  name: z.string(),
  options: z.string().nullable(),
  env: z.record(z.string()).nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProfileProviderConfigDto = z.infer<typeof ProfileProviderConfigSchema>;

export const CreateProviderConfigSchema = z.object({
  providerId: z.string().min(1, 'providerId is required'),
  name: z.string().min(1, 'name is required'),
  options: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? null : v)),
  env: EnvVarsSchema.transform((v) => (v === undefined ? null : v)),
  position: z.number().int().nonnegative().optional(),
});

export type CreateProviderConfigDto = z.infer<typeof CreateProviderConfigSchema>;

export const UpdateProviderConfigSchema = z.object({
  providerId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  options: z.string().nullable().optional(),
  env: EnvVarsSchema,
  position: z.number().int().nonnegative().optional(),
});

export type UpdateProviderConfigDto = z.infer<typeof UpdateProviderConfigSchema>;

export const ReorderProviderConfigsSchema = z.object({
  configIds: z.array(z.string().uuid()).min(1, 'configIds must be a non-empty array'),
});

export type ReorderProviderConfigsDto = z.infer<typeof ReorderProviderConfigsSchema>;
