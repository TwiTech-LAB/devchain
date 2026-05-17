import { z } from 'zod';

export const teamMemberAddedEvent = {
  name: 'team.member.added',
  schema: z.object({
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    teamLeadAgentId: z.string().min(1).nullable(),
    teamName: z.string().min(1),
    addedAgentId: z.string().min(1),
    addedAgentName: z.string().nullable(),
    addedAgentDescription: z.string().nullable().optional(),
    projectName: z.string().min(1).optional(),
    recipientIds: z.array(z.string().min(1)).optional(),
    agentName: z.string().min(1).optional(),
    teamLeadAgentName: z.string().min(1).optional(),
  }),
} as const;

export type TeamMemberAddedEventPayload = z.infer<typeof teamMemberAddedEvent.schema>;
