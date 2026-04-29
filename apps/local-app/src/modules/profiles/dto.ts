import { z } from 'zod';
import { EnvVarsSchema } from '@devchain/shared';

export { EnvVarsSchema };

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

export const ProfileProviderConfigSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  providerId: z.string(),
  providerName: z.string().optional(),
  name: z.string(),
  description: z.string().nullable(),
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
  description: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? null : v)),
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
  description: z.string().nullable().optional(),
  options: z.string().nullable().optional(),
  env: EnvVarsSchema,
  position: z.number().int().nonnegative().optional(),
});

export type UpdateProviderConfigDto = z.infer<typeof UpdateProviderConfigSchema>;

export const ReorderProviderConfigsSchema = z.object({
  configIds: z.array(z.string().uuid()).min(1, 'configIds must be a non-empty array'),
});

export type ReorderProviderConfigsDto = z.infer<typeof ReorderProviderConfigsSchema>;
