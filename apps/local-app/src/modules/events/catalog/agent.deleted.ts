import { z } from 'zod';

const actorSchema = z
  .object({
    type: z.enum(['agent', 'guest']),
    id: z.string().min(1),
  })
  .nullable();

export const agentDeletedEvent = {
  name: 'agent.deleted' as const,
  schema: z.object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    projectId: z.string().min(1),
    actor: actorSchema,
    teamId: z.string().min(1).nullable().optional(),
    teamName: z.string().min(1).nullable().optional(),
  }),
};

export type AgentDeletedEventPayload = z.infer<typeof agentDeletedEvent.schema>;
