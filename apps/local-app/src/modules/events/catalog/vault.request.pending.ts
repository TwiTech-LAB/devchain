import { z } from 'zod';

/**
 * An agent asked the user for a Vault entry. `create` asks for a new entry and its
 * value; `grant` asks for access to the existing entry `entryId`; `use` asks to use the
 * granted entry `entryId`, which needs approval, in this session. Never carries a value.
 */
export const vaultRequestPendingEvent = {
  name: 'vault.request.pending',
  schema: z.object({
    requestId: z.string().uuid(),
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    agentName: z.string(),
    familySlug: z.string().nullable(),
    type: z.enum(['create', 'grant', 'use']),
    name: z.string().min(1),
    description: z.string(),
    kind: z.enum(['secret', 'file']),
    entryId: z.string().nullable(),
    createdAt: z.number(),
    expiresAt: z.number(),
  }),
} as const;

export type VaultRequestPendingEventPayload = z.infer<typeof vaultRequestPendingEvent.schema>;
