import { SessionRowStore } from '../../storage/sessions/session-row.store';
import { Injectable } from '@nestjs/common';
import type { ActiveSessionInfo } from '../../session-terminal-runtime/dtos/active-session-info.dto';

@Injectable()
export class ActiveSessionLookup {
  constructor(private readonly sessionRows: SessionRowStore) {}

  async getActiveSession(agentId: string, projectId: string): Promise<ActiveSessionInfo | null> {
    return this.sessionRows.getActiveSessionInfo(agentId, projectId);
  }

  /**
   * Resolve a session's owning project via `session → agent → project`,
   * regardless of session status (running OR ended) — ownership applies to
   * historical transcripts too. Returns null when the session does not exist.
   *
   * Used to enforce project scoping on session-ID-centric reads (e.g. mobile
   * chat transcript RPCs) so a caller cannot read another project's session by
   * guessing its id.
   */
  async getSessionProjectScope(
    sessionId: string,
  ): Promise<{ sessionId: string; agentId: string | null; projectId: string } | null> {
    return this.sessionRows.getSessionProjectScope(sessionId);
  }

  async listActiveSessions(projectId: string): Promise<ActiveSessionInfo[]> {
    return this.sessionRows.listActiveSessionInfos(projectId);
  }

  async listRunningProviderSessions(): Promise<
    Pick<ActiveSessionInfo, 'sessionId' | 'providerNameAtLaunch'>[]
  > {
    return this.sessionRows.listRunningProviderSessions();
  }
}
