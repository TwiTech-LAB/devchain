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
  }),
} as const;

export type TeamMemberAddedEventPayload = z.infer<typeof teamMemberAddedEvent.schema>;
