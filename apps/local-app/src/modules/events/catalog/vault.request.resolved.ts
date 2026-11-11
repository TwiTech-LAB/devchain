import { z } from 'zod';

/** A Vault request reached its one terminal state. Never carries a value. */
export const vaultRequestResolvedEvent = {
  name: 'vault.request.resolved',
  schema: z.object({
    requestId: z.string().uuid(),
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['fulfilled', 'denied', 'expired']),
    /** The user's short note with a denial; null otherwise. */
    reason: z.string().max(200).nullable(),
  }),
} as const;

export type VaultRequestResolvedEventPayload = z.infer<typeof vaultRequestResolvedEvent.schema>;
