import { z } from 'zod';

export const teamMemberRemovedEvent = {
  name: 'team.member.removed',
  schema: z.object({
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    teamLeadAgentId: z.string().min(1).nullable(),
    teamName: z.string().min(1),
    removedAgentId: z.string().min(1),
    removedAgentName: z.string().nullable(),
    projectName: z.string().min(1).optional(),
    recipientIds: z.array(z.string().min(1)).optional(),
    agentName: z.string().min(1).optional(),
    teamLeadAgentName: z.string().min(1).optional(),
  }),
} as const;

export type TeamMemberRemovedEventPayload = z.infer<typeof teamMemberRemovedEvent.schema>;
