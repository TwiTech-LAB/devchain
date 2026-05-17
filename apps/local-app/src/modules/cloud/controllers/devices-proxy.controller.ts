import { Controller, Get, HttpException, UnauthorizedException } from '@nestjs/common';
import { CloudSessionManagerService } from '../services/cloud-session-manager.service';
import { RefreshGateService } from '../services/refresh-gate.service';

@Controller('api/cloud/devices')
export class DevicesProxyController {
  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
  ) {}

  @Get()
  async list() {
    const status = this.cloudSession.getStatus();
    if (!status.connected) {
      throw new UnauthorizedException('Cloud is not connected');
    }
    return this.callUpstream(this.cloudSession.getAccessToken());
  }

  private async callUpstream(token: string | null): Promise<unknown> {
    if (!token) throw new UnauthorizedException('No access token');
    const baseUrl = process.env.NOTIFICATIONS_SERVICE_URL ?? 'http://localhost:3003';
    const res = await fetch(`${baseUrl}/api/v1/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      const outcome = await this.refreshGate.attemptRefresh();
      if (outcome === 'success') {
        const refreshedToken = this.cloudSession.getAccessToken();
        if (!refreshedToken) throw new UnauthorizedException('Refresh succeeded but no token');
        const retry = await fetch(`${baseUrl}/api/v1/devices`, {
          headers: { Authorization: `Bearer ${refreshedToken}` },
        });
        if (!retry.ok) throw new HttpException(await safeText(retry), retry.status);
        return retry.json();
      }
      throw new UnauthorizedException('Cloud session expired');
    }

    if (!res.ok) throw new HttpException(await safeText(res), res.status);
    return res.json();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
