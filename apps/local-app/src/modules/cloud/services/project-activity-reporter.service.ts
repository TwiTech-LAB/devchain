import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { RefreshGateService } from './refresh-gate.service';

@Injectable()
export class ProjectActivityReporterService {
  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
  ) {}

  async touchProject(projectId: string): Promise<null> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      throw new HttpException('Project id is required', HttpStatus.BAD_REQUEST);
    }

    return this.forwardUpstream(
      'POST',
      `/api/v1/activity/projects/${encodeURIComponent(normalizedProjectId)}/touch`,
    );
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
    const baseUrl = process.env.NOTIFICATIONS_SERVICE_URL ?? 'https://notify.devchain.cc';
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
