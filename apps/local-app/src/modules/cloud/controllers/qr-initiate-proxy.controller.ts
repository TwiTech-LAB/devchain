import { Body, Controller, HttpException, Post, UnauthorizedException } from '@nestjs/common';
import { CloudSessionManagerService } from '../services/cloud-session-manager.service';
import { RefreshGateService } from '../services/refresh-gate.service';

@Controller('api/cloud/qr')
export class QrInitiateProxyController {
  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
  ) {}

  @Post('initiate')
  async initiate(@Body() body: { machineLabel?: string }) {
    const status = this.cloudSession.getStatus();
    if (!status.connected) {
      throw new UnauthorizedException('Cloud is not connected');
    }
    return this.callUpstream(this.cloudSession.getAccessToken(), body);
  }

  private async callUpstream(token: string | null, body: unknown): Promise<unknown> {
    if (!token) throw new UnauthorizedException('No access token');
    const baseUrl = process.env.IDENTITY_SERVICE_URL ?? 'http://localhost:3002';
    const res = await fetch(`${baseUrl}/auth/qr/initiate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });

    if (res.status === 401) {
      const outcome = await this.refreshGate.attemptRefresh();
      if (outcome === 'success') {
        const refreshedToken = this.cloudSession.getAccessToken();
        if (!refreshedToken) throw new UnauthorizedException('Refresh succeeded but no token');
        const retry = await fetch(`${baseUrl}/auth/qr/initiate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${refreshedToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body ?? {}),
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
