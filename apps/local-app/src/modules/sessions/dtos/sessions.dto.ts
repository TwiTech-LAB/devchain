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
  options: z
    .object({
      silent: z.boolean().optional(),
    })
    .optional(),
});

export type LaunchSessionDto = z.infer<typeof LaunchSessionSchema>;

export interface SessionDto {
  id: string;
  epicId: string | null;
  agentId: string | null;
  tmuxSessionId: string | null;
  /** Provider-native session id (e.g. OpenCode `ses_…`); locates DB-backed sources. */
  providerSessionId?: string | null;
  /** Historical provider identity used to parse transcripts independently of live config. */
  providerNameAtLaunch?: string | null;
  status: 'running' | 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  lastActivityAt?: string | null;
  activityState?: 'idle' | 'busy' | null;
  busySince?: string | null;
  transcriptPath?: string | null;
  name?: string | null;
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

export const TerminateSessionQuerySchema = z.object({
  expectedAgentId: z.string().uuid('expectedAgentId must be a valid UUID').optional(),
});

export interface AgentPresenceDto {
  online: boolean;
  sessionId?: string;
  activityState?: 'idle' | 'busy' | null;
  lastActivityAt?: string | null;
  busySince?: string | null;
  currentActivityTitle?: string | null;
  /** The session has an unanswered AskUserQuestion, however long it has waited. */
  pendingQuestion?: boolean;
  /**
   * Provider turn state stored on the session, with its start time. `activityState` prefers
   * the terminal output timer, which reads a quiet tool run as idle and output after a
   * finished turn as busy. The mobile agent list reports the stored state too.
   */
  turnActivityState?: 'idle' | 'busy' | null;
  turnBusySince?: string | null;
}

export interface AgentPresenceResponseDto {
  [agentId: string]: AgentPresenceDto;
}

export interface SessionHistoryItemDto {
  id: string;
  /** The agent that owns the session; a family list mixes owners. */
  agentId: string | null;
  agentName: string | null;
  providerSessionId: string | null;
  providerNameAtLaunch: string | null;
  status: 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string | null;
  sizeBytes: number | null;
  transcriptAvailable: boolean;
  name: string | null;
}

export interface SessionHistoryResponseDto {
  items: SessionHistoryItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

export const CreateSessionSavePointSchema = z.object({ projectId: z.string().uuid() }).strict();

export const AgentSessionPageQuerySchema = z.object({
  projectId: z.string().uuid('projectId must be a valid UUID'),
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      const limit = Number.parseInt(value ?? '', 10);
      return Number.isNaN(limit) || limit < 1 ? 20 : Math.min(limit, 100);
    }),
  /** `family` lists the sessions of every agent in the agent's family; the default is the agent's own. */
  scope: z.enum(['agent', 'family']).default('agent'),
});

export interface SessionTreeNodeDto extends Omit<SessionHistoryItemDto, 'status'> {
  status: SessionDto['status'];
  kind: 'session' | 'save_point';
  parentSessionId: string | null;
  /** True for the save point that holds the conversation the parent left at its last rollback. */
  beforeRollback: boolean;
}

export type SavePointAvailabilityDto =
  | { available: true }
  | { available: false; reason: 'PROVIDER_UNSUPPORTED' | 'TEAM_MEMBER' };

export interface SessionTreeResponseDto extends Omit<SessionHistoryResponseDto, 'items'> {
  items: SessionTreeNodeDto[];
  savePoints: SavePointAvailabilityDto;
}

export const RestoreSessionSchema = z.object({
  projectId: z.string().uuid(),
  replaceRunningSessionId: z.string().uuid().optional(),
  /** The agent that runs the restored session; omitted, the session's owner. */
  targetAgentId: z.string().uuid().optional(),
  /**
   * Restores on this config of the target agent's profile; its provider must be the session's
   * launch provider. The agent keeps the config, with no model or effort override.
   */
  switchToProviderConfigId: z.string().uuid().optional(),
});

export const StartFromSavePointSchema = z
  .object({
    projectId: z.string().uuid(),
    replaceRunningSessionId: z.string().uuid().optional(),
    /** Refuses the fork when the source belongs to another agent. */
    expectedAgentId: z.string().uuid().optional(),
  })
  .strict();

export type RestoreSessionDto = z.infer<typeof RestoreSessionSchema>;

export type StartFromSavePointDto = z.infer<typeof StartFromSavePointSchema>;

export const RollbackSessionSchema = z
  .object({
    projectId: z.string().uuid(),
    savePointId: z.string().uuid(),
    keepCurrent: z.boolean(),
    replaceRunningSessionId: z.string().uuid().optional(),
    /** Refuses the rollback when the session belongs to another agent. */
    expectedAgentId: z.string().uuid().optional(),
  })
  .strict();

export type RollbackSessionDto = z.infer<typeof RollbackSessionSchema>;
