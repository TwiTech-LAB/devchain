import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLogger } from '../../common/logging/logger';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { ClaudeLaunchSettingsMaterializerService } from '../runtime-context-capture/claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from '../runtime-context-capture/codex-plugin-profile-materializer.service';
import { RuntimeContextCaptureService } from '../runtime-context-capture/runtime-context-capture.service';
import type { ProviderSessionArtifacts } from '../runtime-context-capture/provider-artifacts.types';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import type {
  SessionTerminalRuntimeDescriptor,
  SessionTerminalStartupEntry,
} from './session-terminal-runtime.types';

const logger = createLogger('SessionTerminalRuntimeService');

interface SessionArtifactOwner {
  artifacts: ProviderSessionArtifacts;
  errorCode: string;
  cleanupFailureMessage: string;
}

interface SessionTerminalRow {
  tmux_session_id: string | null;
  provider_name_at_launch: string | null;
  status: string;
}

@Injectable()
export class SessionTerminalRuntimeService {
  private readonly sqlite: ReturnType<typeof getRawSqliteClient>;
  private readonly artifactOwners: readonly SessionArtifactOwner[];

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly runtimeContextCapture: RuntimeContextCaptureService,
    claudeLaunchSettings: ClaudeLaunchSettingsMaterializerService,
    codexPluginProfiles: CodexPluginProfileMaterializerService,
  ) {
    this.sqlite = getRawSqliteClient(db);
    this.artifactOwners = [
      {
        artifacts: claudeLaunchSettings,
        errorCode: 'CLAUDE_SETTINGS_CLEANUP_FAILED',
        cleanupFailureMessage: 'Failed to clean Claude launch settings after session termination',
      },
      {
        artifacts: codexPluginProfiles,
        errorCode: 'CODEX_PROFILE_CLEANUP_FAILED',
        cleanupFailureMessage: 'Failed to clean Codex profile lifecycle after session termination',
      },
    ];
  }

  getDescriptor(sessionId: string): SessionTerminalRuntimeDescriptor {
    const row = this.readSessionTerminalRow(sessionId);

    const tmuxSessionName = row?.tmux_session_id ?? null;
    if (!row || row.status !== 'running' || !tmuxSessionName || !row.provider_name_at_launch) {
      return this.safeDescriptor(sessionId, tmuxSessionName);
    }

    try {
      const behavior = this.providerAdapterFactory.getAdapter(
        row.provider_name_at_launch,
      ).terminalOutputBehavior;
      return Object.freeze({
        sessionId,
        tmuxSessionName,
        normalizeLf: !behavior?.rawLineEndings,
        usesAlternateScreen: behavior?.usesAlternateScreen ?? false,
      });
    } catch {
      return this.safeDescriptor(sessionId, tmuxSessionName);
    }
  }

  getProviderNameAtLaunch(sessionId: string): string | null {
    const row = this.readSessionTerminalRow(sessionId);
    return row?.status === 'running' ? row.provider_name_at_launch : null;
  }

  listStartupSessions(): readonly SessionTerminalStartupEntry[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, tmux_session_id
         FROM sessions
         WHERE status = 'running'
           AND tmux_session_id IS NOT NULL
           AND tmux_session_id <> ''
           AND provider_name_at_launch IS NOT NULL
           AND provider_name_at_launch <> ''`,
      )
      .all() as Array<{ id: string; tmux_session_id: string }>;

    return rows.map((row) =>
      Object.freeze({
        sessionId: row.id,
        tmuxSessionName: row.tmux_session_id,
      }),
    );
  }

  retireConfirmedLoss(sessionId: string, reason: string): void {
    logger.warn({ sessionId, reason }, 'Marking session as failed due to confirmed tmux loss');
    void this.releaseProviderArtifacts(sessionId);

    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE sessions
         SET status = 'failed', ended_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(now, now, sessionId);
  }

  releaseProviderArtifacts(sessionId: string): Promise<void> {
    this.runtimeContextCapture.clear(sessionId);
    for (const owner of this.artifactOwners) {
      void this.attemptCleanup(sessionId, owner, () =>
        owner.artifacts.cleanupSessionSync?.(sessionId),
      );
    }

    return this.cleanupProviderArtifacts(sessionId);
  }

  async reconcileProviderStartup(nonLiveSessionIds: ReadonlySet<string>): Promise<void> {
    for (const owner of this.artifactOwners) {
      await owner.artifacts.reconcileStartup?.(nonLiveSessionIds);
    }
  }

  private async cleanupProviderArtifacts(sessionId: string): Promise<void> {
    for (const owner of this.artifactOwners) {
      if (!owner.artifacts.cleanupSession) continue;
      await this.attemptCleanup(sessionId, owner, () =>
        owner.artifacts.cleanupSession?.(sessionId),
      );
    }
  }

  private async attemptCleanup(
    sessionId: string,
    owner: SessionArtifactOwner,
    cleanup: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await cleanup();
    } catch {
      logger.warn({ sessionId, errorCode: owner.errorCode }, owner.cleanupFailureMessage);
    }
  }

  private safeDescriptor(
    sessionId: string,
    tmuxSessionName: string | null,
  ): SessionTerminalRuntimeDescriptor {
    return Object.freeze({
      sessionId,
      tmuxSessionName,
      normalizeLf: true,
      usesAlternateScreen: false,
    });
  }

  private readSessionTerminalRow(sessionId: string): SessionTerminalRow | undefined {
    try {
      return this.sqlite
        .prepare(
          `SELECT tmux_session_id, provider_name_at_launch, status
           FROM sessions
           WHERE id = ?`,
        )
        .get(sessionId) as SessionTerminalRow | undefined;
    } catch (error) {
      logger.warn({ error, sessionId }, 'Failed to resolve durable session terminal context');
      return undefined;
    }
  }
}
