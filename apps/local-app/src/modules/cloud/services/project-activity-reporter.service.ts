import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLogger } from '../../../common/logging/logger';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import type { SessionActivityChangedEventPayload } from '../../events/catalog/session.activity.changed';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { RefreshGateService } from './refresh-gate.service';

const PROJECT_ACTIVITY_THROTTLE_MS = 60_000;
const logger = createLogger('ProjectActivityReporter');

interface TouchProjectOptions {
  respectThrottle?: boolean;
}

@Injectable()
export class ProjectActivityReporterService {
  private readonly sqlite: ReturnType<typeof getRawSqliteClient>;
  private readonly lastTouchedByProjectId = new Map<string, number>();

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  @OnEvent('session.activity.changed', { async: true })
  async onSessionActivityChanged(payload: SessionActivityChangedEventPayload): Promise<void> {
    if (payload.state !== 'busy') return;

    const projectId = this.resolveSessionProjectId(payload.sessionId);
    if (!projectId) return;

    try {
      await this.touchProject(projectId);
    } catch (error) {
      logger.debug({ error, projectId, sessionId: payload.sessionId }, 'Activity touch failed');
    }
  }

  async touchProject(projectId: string, options: TouchProjectOptions = {}): Promise<null> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      throw new HttpException('Project id is required', HttpStatus.BAD_REQUEST);
    }

    const respectThrottle = options.respectThrottle ?? true;
    if (respectThrottle && this.isThrottled(normalizedProjectId)) {
      return null;
    }

    if (respectThrottle) {
      this.lastTouchedByProjectId.set(normalizedProjectId, Date.now());
    }

    return this.forwardUpstream(
      'POST',
      `/api/v1/activity/projects/${encodeURIComponent(normalizedProjectId)}/touch`,
    );
  }

  private resolveSessionProjectId(sessionId: string): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT agents.project_id AS projectId
         FROM sessions
         JOIN agents ON agents.id = sessions.agent_id
         WHERE sessions.id = ?`,
      )
      .get(sessionId) as { projectId: string | null } | undefined;

    return row?.projectId ?? null;
  }

  private isThrottled(projectId: string): boolean {
    const lastTouchedAt = this.lastTouchedByProjectId.get(projectId);
    return lastTouchedAt !== undefined && Date.now() - lastTouchedAt < PROJECT_ACTIVITY_THROTTLE_MS;
  }

  private async forwardUpstream(method: string, path: string, body?: unknown): Promise<null> {
    const status = this.cloudSession.getStatus();
    if (!status.connected) throw new UnauthorizedException('Cloud is not connected');
    return this.callUpstream(method, path, body, this.cloudSession.getAccessToken());
  }

  private async callUpstream(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
  ): Promise<null> {
    if (!token) throw new UnauthorizedException('No access token');
    const baseUrl = process.env.NOTIFICATIONS_SERVICE_URL ?? 'http://localhost:3003';
    const hasBody = body !== undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
    const init: RequestInit = {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetch(`${baseUrl}${path}`, init);

    if (res.status === 401) {
      const outcome = await this.refreshGate.attemptRefresh();
      if (outcome === 'success') {
        const refreshed = this.cloudSession.getAccessToken();
        if (!refreshed) throw new UnauthorizedException('Refresh succeeded but no token');
        const retryHeaders: Record<string, string> = {
          Authorization: `Bearer ${refreshed}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        };
        const retry = await fetch(`${baseUrl}${path}`, { ...init, headers: retryHeaders });
        if (!retry.ok) throw new HttpException(await safeText(retry), retry.status);
        return null;
      }
      throw new UnauthorizedException('Cloud session expired');
    }

    if (!res.ok) throw new HttpException(await safeText(res), res.status);
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
