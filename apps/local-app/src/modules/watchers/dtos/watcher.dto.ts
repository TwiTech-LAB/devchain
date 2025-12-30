import { z } from 'zod';

/**
 * Watcher DTOs and Zod validation schemas
 */

// ============================================
// TRIGGER CONDITION SCHEMA
// ============================================

export const TriggerConditionSchema = z.object({
  type: z.enum(['contains', 'regex', 'not_contains']),
  pattern: z.string().min(1).max(1000),
  flags: z.string().max(10).optional(), // For regex: 'i', 'g', 'm', etc.
});

export type TriggerCondition = z.infer<typeof TriggerConditionSchema>;

// ============================================
// CREATE WATCHER SCHEMA
// ============================================

export const CreateWatcherSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional().default(true),
    scope: z.enum(['all', 'agent', 'profile', 'provider']).optional().default('all'),
    // IDs in this app are stored as TEXT and may be UUIDs (randomUUID) or stable seeded IDs
    // like "provider-claude". Accept any non-empty string.
    scopeFilterId: z.string().min(1).max(200).optional().nullable(),
    pollIntervalMs: z.number().int().min(1000).max(60000).optional().default(5000),
    viewportLines: z.number().int().min(10).max(200).optional().default(50),
    condition: TriggerConditionSchema,
    cooldownMs: z.number().int().min(0).max(3600000).optional().default(60000),
    cooldownMode: z.enum(['time', 'until_clear']).optional().default('time'),
    eventName: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z][a-z0-9._-]*$/i,
        'Event name must start with letter, contain only letters, numbers, dots, underscores, hyphens',
      ),
  })
  .refine((data) => data.scope === 'all' || !!data.scopeFilterId, {
    message: 'scopeFilterId is required when scope is not "all"',
    path: ['scopeFilterId'],
  });

export type CreateWatcherData = z.infer<typeof CreateWatcherSchema>;

// ============================================
// UPDATE WATCHER SCHEMA
// ============================================
// Explicit schema without defaults - partial updates allowed

export const UpdateWatcherSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  enabled: z.boolean().optional(),
  scope: z.enum(['all', 'agent', 'profile', 'provider']).optional(),
  scopeFilterId: z.string().min(1).max(200).optional().nullable(),
  pollIntervalMs: z.number().int().min(1000).max(60000).optional(),
  viewportLines: z.number().int().min(10).max(200).optional(),
  condition: TriggerConditionSchema.optional(),
  cooldownMs: z.number().int().min(0).max(3600000).optional(),
  cooldownMode: z.enum(['time', 'until_clear']).optional(),
  eventName: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z][a-z0-9._-]*$/i,
      'Event name must start with letter, contain only letters, numbers, dots, underscores, hyphens',
    )
    .optional(),
});

export type UpdateWatcherData = z.infer<typeof UpdateWatcherSchema>;

// ============================================
// TOGGLE WATCHER SCHEMA
// ============================================

export const ToggleWatcherSchema = z.object({
  enabled: z.boolean(),
});

export type ToggleWatcherData = z.infer<typeof ToggleWatcherSchema>;

// ============================================
// WATCHER DTO (for API responses)
// ============================================

export interface WatcherDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  scope: 'all' | 'agent' | 'profile' | 'provider';
  scopeFilterId: string | null;
  pollIntervalMs: number;
  viewportLines: number;
  condition: TriggerCondition;
  cooldownMs: number;
  cooldownMode: 'time' | 'until_clear';
  eventName: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// WATCHER TEST RESULT DTO
// ============================================

export interface WatcherTestSessionResult {
  sessionId: string;
  agentId: string | null;
  tmuxSessionId: string | null;
  viewport: string | null;
  viewportHash: string | null;
  conditionMatched: boolean;
}

export interface WatcherTestResultDto {
  watcher: WatcherDto;
  sessionsChecked: number;
  results: WatcherTestSessionResult[];
}
