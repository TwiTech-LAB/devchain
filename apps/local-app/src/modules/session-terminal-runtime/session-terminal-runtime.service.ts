import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLogger } from '../../common/logging/logger';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { ClaudeLaunchSettingsMaterializerService } from '../runtime-context-capture/claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from '../runtime-context-capture/codex-plugin-profile-materializer.service';
import { RuntimeContextCaptureService } from '../runtime-context-capture/runtime-context-capture.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import type {
  SessionTerminalRuntimeDescriptor,
  SessionTerminalStartupEntry,
} from './session-terminal-runtime.types';

const logger = createLogger('SessionTerminalRuntimeService');

interface SessionTerminalRow {
  tmux_session_id: string | null;
  provider_name_at_launch: string | null;
  status: string;
}

@Injectable()
export class SessionTerminalRuntimeService {
  private readonly sqlite: ReturnType<typeof getRawSqliteClient>;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly runtimeContextCapture: RuntimeContextCaptureService,
    private readonly claudeLaunchSettings: ClaudeLaunchSettingsMaterializerService,
    private readonly codexPluginProfiles: CodexPluginProfileMaterializerService,
  ) {
    this.sqlite = getRawSqliteClient(db);
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
    this.runtimeContextCapture.clear(sessionId);
    this.claudeLaunchSettings.cleanupSessionSync(sessionId);
    void this.codexPluginProfiles.cleanupSession(sessionId).catch((error) => {
      logger.warn({ error, sessionId }, 'Failed to clean Codex profile lifecycle after tmux loss');
    });

    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE sessions
         SET status = 'failed', ended_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(now, now, sessionId);
  }

  async reconcileCodexStartup(nonLiveSessionIds: ReadonlySet<string>): Promise<void> {
    await this.codexPluginProfiles.reconcileStartup(nonLiveSessionIds);
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
