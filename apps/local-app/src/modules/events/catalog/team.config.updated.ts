import { z } from 'zod';

const configSchema = z.object({
  maxMembers: z.number().int(),
  maxConcurrentTasks: z.number().int(),
  allowTeamLeadCreateAgents: z.boolean(),
});

export const teamConfigUpdatedEvent = {
  name: 'team.config.updated',
  schema: z.object({
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    teamLeadAgentId: z.string().min(1).nullable(),
    teamName: z.string().min(1),
    projectName: z.string().min(1).optional(),
    recipientIds: z.array(z.string().min(1)).optional(),
    agentName: z.string().min(1).optional(),
    previous: configSchema,
    current: configSchema,
  }),
} as const;

export type TeamConfigUpdatedEventPayload = z.infer<typeof teamConfigUpdatedEvent.schema>;
