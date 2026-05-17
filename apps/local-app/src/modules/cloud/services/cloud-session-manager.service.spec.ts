import { Test, TestingModule } from '@nestjs/testing';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { EncryptedTokenStoreService } from './encrypted-token-store.service';
import { EventsService } from '../../events/services/events.service';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import * as jose from 'jose';
import type { CloudTokens } from '../types';

describe('CloudSessionManagerService', () => {
  let service: CloudSessionManagerService;
  let tokenStore: jest.Mocked<EncryptedTokenStoreService>;
  let eventsService: jest.Mocked<EventsService>;
  let broadcaster: jest.Mocked<RealtimeBroadcaster>;

  // RSA key pair for signing test JWTs
  let privateKey: jose.KeyLike;
  let publicJwk: jose.JWK;

  beforeAll(async () => {
    const { privateKey: pk, publicKey } = await jose.generateKeyPair('RS256');
    privateKey = pk;
    publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
  });

  beforeEach(async () => {
    tokenStore = {
      store: jest.fn(),
      retrieve: jest.fn().mockReturnValue(null),
      clear: jest.fn(),
    } as unknown as jest.Mocked<EncryptedTokenStoreService>;

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-id'),
    } as unknown as jest.Mocked<EventsService>;

    broadcaster = {
      broadcastEvent: jest.fn(),
    } as unknown as jest.Mocked<RealtimeBroadcaster>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudSessionManagerService,
        { provide: EncryptedTokenStoreService, useValue: tokenStore },
        { provide: EventsService, useValue: eventsService },
        { provide: REALTIME_BROADCASTER, useValue: broadcaster },
      ],
    }).compile();

    service = module.get<CloudSessionManagerService>(CloudSessionManagerService);

    // Mock JWKS fetch
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    service.onModuleDestroy();
  });

  async function signTestJwt(
    claims: Record<string, unknown> = {},
    expiresIn = '1h',
  ): Promise<string> {
    return new jose.SignJWT({
      sub: 'user-123',
      scopes: ['notifications:read'],
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  describe('storeTokens', () => {
    it('should validate, store, and emit events', async () => {
      const accessToken = await signTestJwt();
      const refreshToken = 'mock-refresh-token';

      const result = await service.storeTokens(accessToken, refreshToken);

      expect(result.userId).toBe('user-123');
      expect(tokenStore.store).toHaveBeenCalledTimes(1);
      expect(eventsService.publish).toHaveBeenCalledWith('session.cloud_connected', {
        userId: 'user-123',
      });
      expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
        'cloud',
        'connected',
        expect.objectContaining({ userId: 'user-123' }),
      );
    });

    it('should reject invalid JWT', async () => {
      await expect(service.storeTokens('invalid-token', 'refresh')).rejects.toThrow();
      expect(tokenStore.store).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('should expose configured identityServiceUrl or default to port 3002', () => {
      const status = service.getStatus();
      expect(status.identityServiceUrl).toBe(
        process.env.IDENTITY_SERVICE_URL || 'http://localhost:3002',
      );
    });

    it('should return disconnected when no tokens', () => {
      const status = service.getStatus();
      expect(status.connected).toBe(false);
      expect(status.userId).toBeUndefined();
    });

    it('should return connected after storing tokens', async () => {
      const accessToken = await signTestJwt();
      await service.storeTokens(accessToken, 'refresh');

      const status = service.getStatus();
      expect(status.connected).toBe(true);
      expect(status.userId).toBe('user-123');
    });
  });

  describe('disconnect', () => {
    it('should clear tokens and emit events', async () => {
      const accessToken = await signTestJwt();
      await service.storeTokens(accessToken, 'refresh');

      await service.disconnect();

      expect(tokenStore.clear).toHaveBeenCalled();
      expect(service.getStatus().connected).toBe(false);
      expect(eventsService.publish).toHaveBeenCalledWith('session.cloud_disconnected', {
        userId: 'user-123',
      });
    });
  });

  describe('refreshAccessToken', () => {
    it('should refresh and update stored tokens', async () => {
      const accessToken = await signTestJwt();
      await service.storeTokens(accessToken, 'old-refresh');

      const newAccessToken = await signTestJwt({ sub: 'user-123' }, '2h');
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('.well-known/jwks.json')) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/auth/refresh')) {
          return new Response(
            JSON.stringify({
              access_token: newAccessToken,
              refresh_token: 'new-refresh',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      });

      await service.refreshAccessToken();

      expect(tokenStore.store).toHaveBeenCalledTimes(2);
      expect(service.getAccessToken()).toBe(newAccessToken);
    });

    it('should disconnect on 401 refresh failure', async () => {
      const accessToken = await signTestJwt();
      await service.storeTokens(accessToken, 'old-refresh');

      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('.well-known/jwks.json')) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ error: 'invalid_refresh_token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      await service.refreshAccessToken();

      expect(tokenStore.clear).toHaveBeenCalled();
      expect(service.getStatus().connected).toBe(false);
      expect(eventsService.publish).toHaveBeenCalledWith('session.cloud_disconnected', {
        userId: 'user-123',
      });
    });

    it('should keep tokens on transient refresh failure', async () => {
      const accessToken = await signTestJwt();
      await service.storeTokens(accessToken, 'old-refresh');

      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('.well-known/jwks.json')) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      await expect(service.refreshAccessToken()).rejects.toThrow('Refresh failed: 503');

      expect(tokenStore.clear).not.toHaveBeenCalled();
      expect(service.getStatus().connected).toBe(true);
      expect(service.getAccessToken()).toBe(accessToken);
    });
  });

  describe('onModuleInit', () => {
    it('should restore valid tokens from store', async () => {
      const accessToken = await signTestJwt();
      const storedTokens: CloudTokens = {
        accessToken,
        refreshToken: 'stored-refresh',
        userId: 'user-123',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      tokenStore.retrieve.mockReturnValue(storedTokens);

      await service.onModuleInit();

      expect(service.getStatus().connected).toBe(true);
      expect(service.getAccessToken()).toBe(accessToken);
    });

    it('should clear expired tokens that cannot be refreshed', async () => {
      const storedTokens: CloudTokens = {
        accessToken: 'expired',
        refreshToken: 'stored-refresh',
        userId: 'user-123',
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      tokenStore.retrieve.mockReturnValue(storedTokens);

      jest.spyOn(global, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'invalid_refresh_token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      await service.onModuleInit();

      expect(service.getStatus().connected).toBe(false);
    });

    it('should keep expired stored tokens when refresh fails transiently on startup', async () => {
      const storedTokens: CloudTokens = {
        accessToken: 'expired',
        refreshToken: 'stored-refresh',
        userId: 'user-123',
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      tokenStore.retrieve.mockReturnValue(storedTokens);

      jest.spyOn(global, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      await service.onModuleInit();

      expect(tokenStore.clear).not.toHaveBeenCalled();
      expect(service.getStatus().connected).toBe(true);
      expect(service.getAccessToken()).toBe('expired');
    });
  });
});
