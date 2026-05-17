import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { CloudSessionManagerService } from '../services/cloud-session-manager.service';
import { RefreshGateService } from '../services/refresh-gate.service';

@Controller('api/cloud/preferences')
export class PreferencesProxyController {
  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
  ) {}

  // Declared before @Get() to prevent NestJS treating 'quiet-hours' as a dynamic segment
  @Get('quiet-hours')
  async getQuietHours() {
    return this.forwardUpstream('GET', '/api/v1/preferences/quiet-hours');
  }

  @Get('smart-suppression')
  async getSmartSuppression() {
    return this.forwardUpstream('GET', '/api/v1/preferences/smart-suppression');
  }

  @Get('catalog')
  async getCatalog() {
    return this.forwardUpstream('GET', '/api/v1/preferences/catalog');
  }

  @Get()
  async listPreferences() {
    return this.forwardUpstream('GET', '/api/v1/preferences');
  }

  @Put('categories/:category')
  async upsertCategory(
    @Param('category') category: string,
    @Body() body: { channel: string; enabled: boolean },
  ) {
    return this.forwardUpstream(
      'PUT',
      `/api/v1/preferences/categories/${encodeURIComponent(category)}`,
      body,
    );
  }

  @Put('quiet-hours')
  async upsertQuietHours(
    @Body()
    body: {
      enabled: boolean;
      startMinutes: number;
      endMinutes: number;
      timezone: string;
    },
  ) {
    return this.forwardUpstream('PUT', '/api/v1/preferences/quiet-hours', body);
  }

  @Put('smart-suppression')
  async upsertSmartSuppression(
    @Body()
    body: {
      enabled: boolean;
      windowMinutes: number;
    },
  ) {
    return this.forwardUpstream('PUT', '/api/v1/preferences/smart-suppression', body);
  }

  @Post('test-push')
  @HttpCode(HttpStatus.OK)
  async testPush(@Body() body?: { deviceId?: string }) {
    return this.forwardUpstream('POST', '/api/v1/preferences/test-push', body ?? {});
  }

  private async forwardUpstream(method: string, path: string, body?: unknown): Promise<unknown> {
    const status = this.cloudSession.getStatus();
    if (!status.connected) throw new UnauthorizedException('Cloud is not connected');
    return this.callUpstream(method, path, body, this.cloudSession.getAccessToken());
  }

  private async callUpstream(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
  ): Promise<unknown> {
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
        return retry.status === 204 ? null : retry.json();
      }
      throw new UnauthorizedException('Cloud session expired');
    }

    if (!res.ok) throw new HttpException(await safeText(res), res.status);
    return res.status === 204 ? null : res.json();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
