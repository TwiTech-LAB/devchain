import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import * as jose from 'jose';
import { createLogger } from '../../../common/logging/logger';
import { EncryptedTokenStoreService } from './encrypted-token-store.service';
import { EventsService } from '../../events/services/events.service';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import type { CloudTokens, CloudConnectionStatus } from '../types';

const logger = createLogger('CloudSessionManager');

const DEFAULT_REFRESH_BUFFER_MS = 60_000;
const REFRESH_RETRY_DELAY_MS = 30_000;
const IDENTITY_SERVICE_URL = process.env.IDENTITY_SERVICE_URL || 'http://localhost:3002';

@Injectable()
export class CloudSessionManagerService implements OnModuleInit, OnModuleDestroy {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTokens: CloudTokens | null = null;
  private jwksCache: { keys: jose.JSONWebKeySet; expiresAt: number } | null = null;

  constructor(
    private readonly tokenStore: EncryptedTokenStoreService,
    @Inject(forwardRef(() => EventsService))
    private readonly eventsService: EventsService,
    @Inject(REALTIME_BROADCASTER)
    private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  async onModuleInit(): Promise<void> {
    const tokens = this.tokenStore.retrieve();
    if (tokens) {
      const expiresAtMs = new Date(tokens.expiresAt).getTime();
      if (expiresAtMs > Date.now()) {
        this.currentTokens = tokens;
        this.scheduleRefresh();
        logger.info({ userId: tokens.userId }, 'Restored cloud session from encrypted store');
      } else {
        // Access token expired — try refreshing
        this.currentTokens = tokens;
        try {
          await this.refreshAccessToken();
        } catch {
          logger.warn('Stored cloud tokens expired and refresh failed transiently — will retry');
        }
      }
    }
  }

  onModuleDestroy(): void {
    this.clearRefreshTimer();
  }

  async storeTokens(accessToken: string, refreshToken: string): Promise<CloudTokens> {
    const payload = await this.validateAccessToken(accessToken);

    const tokens: CloudTokens = {
      accessToken,
      refreshToken,
      userId: payload.sub,
      email: (payload as Record<string, unknown>).email as string | undefined,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };

    this.tokenStore.store(tokens);
    this.currentTokens = tokens;
    this.scheduleRefresh();

    await this.eventsService.publish('session.cloud_connected', {
      userId: tokens.userId,
    });

    this.broadcaster.broadcastEvent('cloud', 'connected', {
      userId: tokens.userId,
      email: tokens.email,
    });

    logger.info({ userId: tokens.userId }, 'Cloud session established');
    return tokens;
  }

  getStatus(): CloudConnectionStatus {
    if (!this.currentTokens) {
      return { connected: false, identityServiceUrl: IDENTITY_SERVICE_URL };
    }

    return {
      connected: true,
      userId: this.currentTokens.userId,
      email: this.currentTokens.email,
      expiresAt: this.currentTokens.expiresAt,
      identityServiceUrl: IDENTITY_SERVICE_URL,
    };
  }

  getAccessToken(): string | null {
    return this.currentTokens?.accessToken ?? null;
  }

  async disconnect(): Promise<void> {
    const userId = this.currentTokens?.userId ?? null;
    this.clearRefreshTimer();
    this.currentTokens = null;
    this.tokenStore.clear();

    await this.eventsService.publish('session.cloud_disconnected', {
      userId,
    });

    this.broadcaster.broadcastEvent('cloud', 'disconnected', { userId });

    logger.info({ userId }, 'Cloud session disconnected');
  }

  async refreshAccessToken(): Promise<void> {
    if (!this.currentTokens) {
      return;
    }

    const { refreshToken } = this.currentTokens;

    try {
      const response = await fetch(`${IDENTITY_SERVICE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const errorCode = body.error as string | undefined;

        if (response.status === 401 || errorCode === 'invalid_refresh_token') {
          logger.warn('Refresh token invalid/revoked — disconnecting');
          await this.handleRefreshFailure();
          return;
        }

        throw new Error(`Refresh failed: ${response.status} ${JSON.stringify(body)}`);
      }

      const body = (await response.json()) as {
        access_token: string;
        refresh_token: string;
      };

      const payload = await this.validateAccessToken(body.access_token);

      this.currentTokens = {
        ...this.currentTokens,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      };

      this.tokenStore.store(this.currentTokens);
      this.scheduleRefresh();

      logger.debug({ userId: this.currentTokens.userId }, 'Access token refreshed');
    } catch (error) {
      if (!this.currentTokens) return;

      logger.error({ error }, 'Token refresh transient error');
      this.scheduleRefreshRetry();
      throw error;
    }
  }

  private async validateAccessToken(
    token: string,
  ): Promise<jose.JWTPayload & { sub: string; exp: number }> {
    const jwks = await this.getJwks();
    const keyStore = jose.createLocalJWKSet(jwks);

    const { payload } = await jose.jwtVerify(token, keyStore, {
      clockTolerance: 60,
    });

    if (!payload.sub || !payload.exp) {
      throw new Error('Invalid JWT payload: missing sub or exp');
    }

    return payload as jose.JWTPayload & { sub: string; exp: number };
  }

  private async getJwks(): Promise<jose.JSONWebKeySet> {
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) {
      return this.jwksCache.keys;
    }

    const response = await fetch(`${IDENTITY_SERVICE_URL}/.well-known/jwks.json`);
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${response.status}`);
    }

    const keys = (await response.json()) as jose.JSONWebKeySet;
    this.jwksCache = { keys, expiresAt: Date.now() + 600_000 };
    return keys;
  }

  private scheduleRefresh(): void {
    this.clearRefreshTimer();

    if (!this.currentTokens) return;

    const expiresAtMs = new Date(this.currentTokens.expiresAt).getTime();
    const refreshAtMs = expiresAtMs - DEFAULT_REFRESH_BUFFER_MS;
    const delayMs = Math.max(refreshAtMs - Date.now(), 1000);

    this.refreshTimer = setTimeout(() => {
      this.refreshAccessToken().catch((error) => {
        logger.error({ error }, 'Scheduled refresh failed');
      });
    }, delayMs);

    logger.debug({ delayMs, expiresAt: this.currentTokens.expiresAt }, 'Scheduled token refresh');
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefreshRetry(): void {
    this.clearRefreshTimer();

    if (!this.currentTokens) return;

    this.refreshTimer = setTimeout(() => {
      this.refreshAccessToken().catch((error) => {
        logger.error({ error }, 'Scheduled refresh retry failed');
      });
    }, REFRESH_RETRY_DELAY_MS);

    logger.debug({ delayMs: REFRESH_RETRY_DELAY_MS }, 'Scheduled token refresh retry');
  }

  private async handleRefreshFailure(): Promise<void> {
    this.clearRefreshTimer();
    const userId = this.currentTokens?.userId ?? null;
    this.currentTokens = null;
    this.tokenStore.clear();

    await this.eventsService.publish('session.cloud_disconnected', {
      userId,
    });

    this.broadcaster.broadcastEvent('cloud', 'disconnected', {
      userId,
      reason: 'refresh_failed',
    });

    logger.info({ userId }, 'Cloud session disconnected due to refresh failure');
  }
}
