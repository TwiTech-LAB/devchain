// Mock the logger BEFORE importing the service so logger.warn is inspectable
// (the real createLogger returns a pino child that is silent under Jest).
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => mockLogger,
}));

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
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();

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

  // Service unit tests retain real JOSE signatures and a stubbed JWKS transport, so
  // issuer/audience/algorithm mistakes cannot be hidden by a mocked verifier.
  describe('verifyE2eeEnrollment', () => {
    const DEVICE_KID = 'a'.repeat(32);

    async function enrollmentToken(claims: jose.JWTPayload = {}, signingKid = 'test-key-1') {
      return new jose.SignJWT({
        iss: 'devchain-identity',
        aud: 'devchain-e2ee-enrollment',
        type: 'e2ee_enrollment',
        sub: 'user-123',
        e2ee_kid: DEVICE_KID,
        exp: Math.floor(Date.now() / 1000) + 600,
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: signingKid })
        .sign(privateKey);
    }

    beforeEach(async () => {
      jest.useFakeTimers();
      await service.storeTokens(await signTestJwt(), 'refresh');
      jest.advanceTimersByTime(30_000);
      mockLogger.warn.mockClear();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('accepts a valid identity attestation for the signed-in user and device kid', async () => {
      expect(await service.verifyE2eeEnrollment(await enrollmentToken(), DEVICE_KID)).toEqual({
        enrollment: 'signed',
      });
    });

    it.each([
      ['audience', { aud: 'devchain-api' }],
      ['issuer', { iss: 'another-issuer' }],
      ['type', { type: 'access' }],
      ['subject', { sub: 'another-user' }],
      ['device kid', { e2ee_kid: 'b'.repeat(32) }],
      ['expiration', { exp: Math.floor(Date.now() / 1000) - 120 }],
      ['missing expiration', { exp: undefined }],
    ] as const)('rejects an attestation with an invalid %s', async (_name, claims) => {
      const token = await enrollmentToken(claims);

      expect(await service.verifyE2eeEnrollment(token, DEVICE_KID)).toEqual({
        enrollment: 'unsigned',
        reason: 'invalid',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith({ reason: 'invalid' }, expect.any(String));
    });

    it('allows expiration within the 60-second clock tolerance', async () => {
      const token = await enrollmentToken({ exp: Math.floor(Date.now() / 1000) - 30 });
      expect(await service.verifyE2eeEnrollment(token, DEVICE_KID)).toEqual({
        enrollment: 'signed',
      });
    });

    it('rejects a valid signature using an algorithm other than RS256', async () => {
      const token = await new jose.SignJWT(jose.decodeJwt(await enrollmentToken()))
        .setProtectedHeader({ alg: 'HS256', kid: 'test-key-1' })
        .sign(new Uint8Array(32).fill(1));

      expect(await service.verifyE2eeEnrollment(token, DEVICE_KID)).toEqual({
        enrollment: 'unsigned',
        reason: 'invalid',
      });
    });

    it('rejects an attestation whose payload was changed after signing', async () => {
      const token = await enrollmentToken();
      const [header, , signature] = token.split('.');
      const payload = Buffer.from(
        JSON.stringify({ ...jose.decodeJwt(token), jti: 'tampered' }),
      ).toString('base64url');

      expect(
        await service.verifyE2eeEnrollment(`${header}.${payload}.${signature}`, DEVICE_KID),
      ).toEqual({
        enrollment: 'unsigned',
        reason: 'invalid',
      });
    });

    it('reports a missing attestation without fetching JWKS', async () => {
      jest.mocked(global.fetch).mockClear();
      expect(await service.verifyE2eeEnrollment(undefined, DEVICE_KID)).toEqual({
        enrollment: 'unsigned',
        reason: 'missing',
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith({ reason: 'missing' }, expect.any(String));
    });

    it('reports an unavailable cloud user without fetching JWKS', async () => {
      await service.disconnect();
      jest.mocked(global.fetch).mockClear();
      expect(await service.verifyE2eeEnrollment(await enrollmentToken(), DEVICE_KID)).toEqual({
        enrollment: 'unsigned',
        reason: 'unverifiable',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each(['network', 'http'] as const)(
      'reports a %s JWKS failure as unverifiable',
      async (failure) => {
        jest.useFakeTimers({ now: Date.now() + 600_001 });
        try {
          if (failure === 'network')
            jest.mocked(global.fetch).mockRejectedValue(new Error('unavailable'));
          else jest.mocked(global.fetch).mockResolvedValue(new Response('', { status: 503 }));
          expect(await service.verifyE2eeEnrollment(await enrollmentToken(), DEVICE_KID)).toEqual({
            enrollment: 'unsigned',
            reason: 'unverifiable',
          });
          expect(mockLogger.warn).toHaveBeenCalledWith(
            { reason: 'unverifiable' },
            expect.any(String),
          );
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it('refetches once for an unknown signing kid and reuses the refreshed cache', async () => {
      const rotatedJwk = { ...publicJwk, kid: 'rotated-key' };
      jest
        .mocked(global.fetch)
        .mockClear()
        .mockResolvedValue(new Response(JSON.stringify({ keys: [rotatedJwk] }), { status: 200 }));
      const token = await enrollmentToken({}, 'rotated-key');

      expect(await service.verifyE2eeEnrollment(token, DEVICE_KID)).toEqual({
        enrollment: 'signed',
      });
      expect(await service.verifyE2eeEnrollment(token, DEVICE_KID)).toEqual({
        enrollment: 'signed',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('rejects a signing kid still absent after one refetch', async () => {
      jest.mocked(global.fetch).mockClear();
      expect(
        await service.verifyE2eeEnrollment(await enrollmentToken({}, 'unknown-key'), DEVICE_KID),
      ).toEqual({
        enrollment: 'unsigned',
        reason: 'invalid',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('limits concurrent and failed JWKS attempts to one fetch per 30 seconds with a timeout signal', async () => {
      for (const cacheState of ['fresh', 'expired', 'missing'] as const) {
        if (cacheState === 'expired') {
          jest.advanceTimersByTime(600_000);
        } else if (cacheState === 'missing') {
          service.onModuleDestroy();
          service = new CloudSessionManagerService(tokenStore, eventsService, broadcaster);
          tokenStore.retrieve.mockReturnValue({
            accessToken: 'restored-access-token',
            refreshToken: 'refresh',
            userId: 'user-123',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
          await service.onModuleInit();
        }

        const attestation = await enrollmentToken({}, 'unknown-key');
        let resolveFetch!: (response: Response) => void;
        const response = new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
        jest
          .mocked(global.fetch)
          .mockClear()
          .mockImplementationOnce(() => response)
          .mockImplementation(async () => new Response('', { status: 429 }));

        const pending = Array.from({ length: 101 }, () =>
          service.verifyE2eeEnrollment(attestation, DEVICE_KID),
        );
        await jest.advanceTimersByTimeAsync(0);
        const concurrentFetchCount = jest.mocked(global.fetch).mock.calls.length;
        jest.advanceTimersByTime(1_000);
        resolveFetch(new Response('', { status: 429 }));
        expect(await Promise.all(pending)).toEqual(
          Array.from({ length: 101 }, () => ({
            enrollment: 'unsigned',
            reason: 'unverifiable',
          })),
        );
        expect(concurrentFetchCount).toBe(1);

        const cooldownReason = cacheState === 'missing' ? 'unverifiable' : 'invalid';
        for (const elapsedMs of [0, 10_000, 18_999]) {
          jest.advanceTimersByTime(elapsedMs);
          expect(await service.verifyE2eeEnrollment(attestation, DEVICE_KID)).toEqual({
            enrollment: 'unsigned',
            reason: cooldownReason,
          });
        }
        expect(global.fetch).toHaveBeenCalledTimes(1);

        jest
          .mocked(global.fetch)
          .mockImplementation(
            async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }),
          );
        jest.advanceTimersByTime(1);
        expect(await service.verifyE2eeEnrollment(attestation, DEVICE_KID)).toEqual({
          enrollment: 'unsigned',
          reason: 'invalid',
        });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        for (const fetchCall of jest.mocked(global.fetch).mock.calls) {
          expect(fetchCall).toEqual([
            `${service.getStatus().identityServiceUrl}/.well-known/jwks.json`,
            { signal: expect.any(AbortSignal) },
          ]);
        }

        jest.advanceTimersByTime(1);
        expect(await service.verifyE2eeEnrollment(attestation, DEVICE_KID)).toEqual({
          enrollment: 'unsigned',
          reason: 'invalid',
        });
        expect(global.fetch).toHaveBeenCalledTimes(2);
      }
    });

    it('reports an unknown-kid JWKS refetch failure as unverifiable', async () => {
      jest.mocked(global.fetch).mockClear().mockRejectedValue(new Error('unavailable'));
      expect(
        await service.verifyE2eeEnrollment(await enrollmentToken({}, 'unknown-key'), DEVICE_KID),
      ).toEqual({
        enrollment: 'unsigned',
        reason: 'unverifiable',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not accept an attestation after the cloud user disconnects during verification', async () => {
      const token = await enrollmentToken({}, 'rotated-key');
      jest.mocked(global.fetch).mockImplementationOnce(async () => {
        await service.disconnect();
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'rotated-key' }] }), {
          status: 200,
        });
      });
      expect(await service.verifyE2eeEnrollment(token, DEVICE_KID)).toEqual({
        enrollment: 'unsigned',
        reason: 'unverifiable',
      });
    });
  });

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

    it.each(['publish', 'broadcast'])('stores tokens despite %s failure', async (failing) => {
      const accessToken = await signTestJwt();
      if (failing === 'publish') {
        eventsService.publish.mockRejectedValueOnce(new Error('events bus down'));
      } else {
        broadcaster.broadcastEvent.mockImplementationOnce(() => {
          throw new Error('broadcast failed');
        });
      }
      const result = await service.storeTokens(accessToken, 'refresh');
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
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('propagates when tokenStore.store throws (controller maps it to 500)', async () => {
      const accessToken = await signTestJwt();
      tokenStore.store.mockImplementationOnce(() => {
        throw new Error('encryption key unavailable');
      });

      await expect(service.storeTokens(accessToken, 'refresh')).rejects.toThrow(
        'encryption key unavailable',
      );
      // Persistence failed → side effects must not run.
      expect(eventsService.publish).not.toHaveBeenCalled();
      expect(broadcaster.broadcastEvent).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('should expose configured identityServiceUrl or default to auth.devchain.cc', () => {
      const status = service.getStatus();
      expect(status.identityServiceUrl).toBe(
        process.env.IDENTITY_SERVICE_URL || 'https://auth.devchain.cc',
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

    it.each([401, 503])('handles refresh HTTP %s', async (status) => {
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
          return new Response(
            JSON.stringify({
              error: status === 401 ? 'invalid_refresh_token' : 'temporary_failure',
            }),
            {
              status,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return new Response('Not found', { status: 404 });
      });
      if (status === 401) {
        await service.refreshAccessToken();
        expect(tokenStore.clear).toHaveBeenCalled();
        expect(service.getStatus().connected).toBe(false);
        expect(eventsService.publish).toHaveBeenCalledWith('session.cloud_disconnected', {
          userId: 'user-123',
        });
      } else {
        await expect(service.refreshAccessToken()).rejects.toThrow('Refresh failed: 503');
        expect(tokenStore.clear).not.toHaveBeenCalled();
        expect(service.getStatus().connected).toBe(true);
        expect(service.getAccessToken()).toBe(accessToken);
      }
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

    it.each([401, 503])('handles startup refresh HTTP %s', async (status) => {
      const storedTokens: CloudTokens = {
        accessToken: 'expired',
        refreshToken: 'stored-refresh',
        userId: 'user-123',
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      tokenStore.retrieve.mockReturnValue(storedTokens);
      jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              error: status === 401 ? 'invalid_refresh_token' : 'temporary_failure',
            }),
            {
              status,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      );
      await service.onModuleInit();
      expect(service.getStatus().connected).toBe(status !== 401);
      if (status === 401) {
        expect(tokenStore.clear).toHaveBeenCalled();
      } else {
        expect(tokenStore.clear).not.toHaveBeenCalled();
        expect(service.getAccessToken()).toBe('expired');
      }
    });
  });
});
