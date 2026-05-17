import { z } from 'zod';

export const CreateScheduledEpicSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional().default(true),
  cronExpression: z.string().min(9).max(100),
  timezone: z.string().max(50).optional().default('UTC'),
  templateTitle: z.string().min(1).max(500),
  templateDescription: z.string().max(5000).optional().nullable(),
  templateStatusId: z.string().uuid().optional().nullable(),
  templateAgentId: z.string().uuid().optional().nullable(),
  templateParentId: z.string().uuid().optional().nullable(),
  templateTags: z.array(z.string()).optional().nullable(),
  templateSkillsRequired: z.array(z.string()).optional().nullable(),
  templateData: z.record(z.string(), z.unknown()).optional().nullable(),
  maxOccurrences: z.number().int().min(1).optional().nullable(),
  cooldownMs: z.number().int().min(0).max(3600000).optional().default(0),
  position: z.number().int().min(0).optional().default(0),
});

export type CreateScheduledEpicData = z.infer<typeof CreateScheduledEpicSchema>;

export const UpdateScheduledEpicSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().min(9).max(100).optional(),
  timezone: z.string().max(50).optional(),
  templateTitle: z.string().min(1).max(500).optional(),
  templateDescription: z.string().max(5000).optional().nullable(),
  templateStatusId: z.string().uuid().optional().nullable(),
  templateAgentId: z.string().uuid().optional().nullable(),
  templateParentId: z.string().uuid().optional().nullable(),
  templateTags: z.array(z.string()).optional().nullable(),
  templateSkillsRequired: z.array(z.string()).optional().nullable(),
  templateData: z.record(z.string(), z.unknown()).optional().nullable(),
  maxOccurrences: z.number().int().min(1).optional().nullable(),
  cooldownMs: z.number().int().min(0).max(3600000).optional(),
  position: z.number().int().min(0).optional(),
});

export type UpdateScheduledEpicData = z.infer<typeof UpdateScheduledEpicSchema>;

export const ToggleScheduledEpicSchema = z.object({
  enabled: z.boolean(),
});

export interface ScheduledEpicDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  templateTitle: string;
  templateDescription: string | null;
  templateStatusId: string | null;
  templateAgentId: string | null;
  templateParentId: string | null;
  templateTags: string[] | null;
  templateSkillsRequired: string[] | null;
  templateData: Record<string, unknown> | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  cooldownMs: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledEpicRunDto {
  id: string;
  scheduledEpicId: string;
  epicId: string | null;
  status: 'success' | 'failed' | 'skipped';
  error: string | null;
  scheduledAt: string;
  executedAt: string;
}

export interface CronPreset {
  label: string;
  cronExpression: string;
  description: string;
}
