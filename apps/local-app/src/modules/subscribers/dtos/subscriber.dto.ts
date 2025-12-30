import { z } from 'zod';

/**
 * Subscriber DTOs and Zod validation schemas
 */

// ============================================
// ACTION INPUT SCHEMA
// ============================================
// Maps action inputs to either event fields or custom values

export const ActionInputSchema = z
  .object({
    source: z.enum(['event_field', 'custom']),
    eventField: z.string().optional(),
    customValue: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.source === 'event_field' && !data.eventField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'eventField is required when source is "event_field"',
        path: ['eventField'],
      });
    }
    if (data.source === 'custom' && data.customValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customValue is required when source is "custom"',
        path: ['customValue'],
      });
    }
  });

export type ActionInput = z.infer<typeof ActionInputSchema>;

// ============================================
// EVENT FILTER SCHEMA
// ============================================
// Optional filter to match specific event payload fields

export const EventFilterSchema = z
  .object({
    field: z.string().min(1),
    operator: z.enum(['equals', 'contains', 'regex']),
    value: z.string(),
  })
  .nullable();

export type EventFilter = z.infer<typeof EventFilterSchema>;

// ============================================
// CREATE SUBSCRIBER SCHEMA
// ============================================

export const CreateSubscriberSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional().default(true),
  eventName: z.string().min(1).max(100),
  eventFilter: EventFilterSchema.optional(),
  actionType: z.string().min(1).max(50),
  actionInputs: z.record(z.string(), ActionInputSchema),
  delayMs: z.number().int().min(0).max(30000).optional().default(0),
  cooldownMs: z.number().int().min(0).max(60000).optional().default(5000),
  retryOnError: z.boolean().optional().default(false),
  // Grouping & ordering
  groupName: z.string().max(100).nullable().optional(),
  position: z.number().int().min(0).optional().default(0),
  priority: z.number().int().min(-100).max(100).optional().default(0),
});

export type CreateSubscriberData = z.infer<typeof CreateSubscriberSchema>;

// ============================================
// UPDATE SUBSCRIBER SCHEMA
// ============================================
// Explicit schema without defaults - partial updates allowed

export const UpdateSubscriberSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  enabled: z.boolean().optional(),
  eventName: z.string().min(1).max(100).optional(),
  eventFilter: EventFilterSchema.optional(),
  actionType: z.string().min(1).max(50).optional(),
  actionInputs: z.record(z.string(), ActionInputSchema).optional(),
  delayMs: z.number().int().min(0).max(30000).optional(),
  cooldownMs: z.number().int().min(0).max(60000).optional(),
  retryOnError: z.boolean().optional(),
  // Grouping & ordering
  groupName: z.string().max(100).nullable().optional(),
  position: z.number().int().min(0).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

export type UpdateSubscriberData = z.infer<typeof UpdateSubscriberSchema>;

// ============================================
// TOGGLE SUBSCRIBER SCHEMA
// ============================================

export const ToggleSubscriberSchema = z.object({
  enabled: z.boolean(),
});

export type ToggleSubscriberData = z.infer<typeof ToggleSubscriberSchema>;

// ============================================
// SUBSCRIBER DTO (for API responses)
// ============================================

export interface SubscriberDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  eventName: string;
  eventFilter: EventFilter | null;
  actionType: string;
  actionInputs: Record<string, ActionInput>;
  delayMs: number;
  cooldownMs: number;
  retryOnError: boolean;
  // Grouping & ordering
  groupName: string | null;
  position: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}
