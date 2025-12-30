import { z } from 'zod';

/**
 * Session DTOs and schemas
 */

export const LaunchSessionSchema = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
  epicId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .transform((value) => (value === null ? undefined : value)),
});

export type LaunchSessionDto = z.infer<typeof LaunchSessionSchema>;

export interface SessionDto {
  id: string;
  epicId: string | null;
  agentId: string | null;
  tmuxSessionId: string | null;
  status: 'running' | 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  lastActivityAt?: string | null;
  activityState?: 'idle' | 'busy' | null;
  busySince?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetailDto extends SessionDto {
  epic: {
    id: string;
    title: string;
    projectId: string;
  } | null;
  agent: {
    id: string;
    name: string;
    profileId: string;
  } | null;
  project: {
    id: string;
    name: string;
    rootPath: string;
  };
}

export interface TerminateSessionDto {
  sessionId: string;
}

export const TerminateSessionSchema = z.object({
  sessionId: z.string().uuid(),
});

export interface AgentPresenceDto {
  online: boolean;
  sessionId?: string;
  activityState?: 'idle' | 'busy' | null;
  lastActivityAt?: string | null;
  busySince?: string | null;
  currentActivityTitle?: string | null;
}

export interface AgentPresenceResponseDto {
  [agentId: string]: AgentPresenceDto;
}
