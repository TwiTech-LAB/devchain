export type ActiveSessionStatus = 'running';

export interface ActiveSessionInfo {
  readonly sessionId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly status: ActiveSessionStatus;
  readonly tmuxSessionId: string | null;
  readonly startedAt: string;
  readonly lastActivityAt: string | null;
  readonly activityState?: 'idle' | 'busy' | null;
  readonly name?: string | null;
}

export interface SessionLaunchErrorDetails {
  readonly agentId: string;
  readonly projectId: string;
  readonly cause?: unknown;
}

export class SessionLaunchError extends Error {
  readonly details: SessionLaunchErrorDetails;

  constructor(details: SessionLaunchErrorDetails) {
    super(`Unable to ensure active session for agent ${details.agentId}`);
    this.name = 'SessionLaunchError';
    this.details = details;
  }
}
