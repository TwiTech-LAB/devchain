import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, HttpException } from '@nestjs/common';
import { PreferencesProxyController } from './preferences-proxy.controller';
import { CloudSessionManagerService } from '../services/cloud-session-manager.service';
import { RefreshGateService } from '../services/refresh-gate.service';

function mockFetchResponse(status: number, body: unknown = {}, ok?: boolean) {
  return {
    status,
    ok: ok ?? (status >= 200 && status < 300),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const connectedStatus = {
  connected: true as const,
  userId: 'u1',
  email: 'u@x.com',
  expiresAt: new Date().toISOString(),
  identityServiceUrl: '',
};

describe('PreferencesProxyController', () => {
  let controller: PreferencesProxyController;
  let cloudSession: jest.Mocked<Pick<CloudSessionManagerService, 'getStatus' | 'getAccessToken'>>;
  let refreshGate: jest.Mocked<Pick<RefreshGateService, 'attemptRefresh'>>;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    cloudSession = {
      getStatus: jest.fn(),
      getAccessToken: jest.fn(),
    };
    refreshGate = {
      attemptRefresh: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PreferencesProxyController],
      providers: [
        { provide: CloudSessionManagerService, useValue: cloudSession },
        { provide: RefreshGateService, useValue: refreshGate },
      ],
    }).compile();

    controller = module.get<PreferencesProxyController>(PreferencesProxyController);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('not connected', () => {
    it('throws 401 without firing upstream', async () => {
      cloudSession.getStatus.mockReturnValue({ connected: false, identityServiceUrl: '' });

      await expect(controller.listPreferences()).rejects.toThrow(UnauthorizedException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('GET /preferences', () => {
    it('forwards 200 JSON body unchanged', async () => {
      const prefs = { categories: [{ category: 'epic.assigned', channel: 'push', enabled: true }] };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok-abc');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, prefs));

      const result = await controller.listPreferences();

      expect(result).toEqual(prefs);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-abc' }),
        }),
      );
    });
  });

  describe('GET /preferences/catalog', () => {
    it('forwards 200 catalog body unchanged', async () => {
      const catalog = {
        version: 'v1',
        categories: [
          {
            id: 'epic.assigned',
            label: 'Epic assigned',
            group: 'epic',
            critical: false,
            locked: false,
            defaultChannels: { inbox: true, push: true },
            color: '#38BDF8',
            sortOrder: 10,
          },
        ],
      };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok-abc');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, catalog));

      const result = await controller.getCatalog();

      expect(result).toEqual(catalog);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/catalog'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-abc' }),
        }),
      );
    });
  });

  describe('PUT /preferences/categories/:category', () => {
    it('forwards body and uses correct URL for dot-separated category', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(
        mockFetchResponse(200, { category: 'epic.assigned', channel: 'push', enabled: true }),
      );

      await controller.upsertCategory('epic.assigned', { channel: 'push', enabled: true });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/categories/epic.assigned'),
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ channel: 'push', enabled: true }),
        }),
      );
    });

    it('percent-encodes category names with special characters (e.g. account:login)', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, {}));

      await controller.upsertCategory('account:login', { channel: 'push', enabled: false });

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain(encodeURIComponent('account:login'));
    });

    it('returns null for 204 without JSON parse error', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

      const result = await controller.upsertCategory('epic.assigned', {
        channel: 'push',
        enabled: true,
      });

      expect(result).toBeNull();
    });
  });

  describe('GET /preferences/quiet-hours', () => {
    it('forwards 200 JSON body unchanged', async () => {
      const quietHours = { enabled: false, startMinutes: 0, endMinutes: 0, timezone: 'UTC' };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, quietHours));

      const result = await controller.getQuietHours();

      expect(result).toEqual(quietHours);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/quiet-hours'),
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('GET /preferences/smart-suppression', () => {
    it('forwards 200 JSON body unchanged', async () => {
      const smartSuppression = { enabled: true, windowMinutes: 5 };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, smartSuppression));

      const result = await controller.getSmartSuppression();

      expect(result).toEqual(smartSuppression);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/smart-suppression'),
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('PUT /preferences/quiet-hours', () => {
    it('forwards body to upstream', async () => {
      const body = {
        enabled: true,
        startMinutes: 1320,
        endMinutes: 480,
        timezone: 'America/New_York',
      };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, body));

      await controller.upsertQuietHours(body);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/quiet-hours'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    });

    it('returns null for 204 without JSON parse error', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

      const result = await controller.upsertQuietHours({
        enabled: false,
        startMinutes: 0,
        endMinutes: 0,
        timezone: 'UTC',
      });

      expect(result).toBeNull();
    });
  });

  describe('PUT /preferences/smart-suppression', () => {
    it('forwards body to upstream', async () => {
      const body = { enabled: true, windowMinutes: 10 };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, body));

      await controller.upsertSmartSuppression(body);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/smart-suppression'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    });

    it('returns null for 204 without JSON parse error', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

      const result = await controller.upsertSmartSuppression({
        enabled: false,
        windowMinutes: 5,
      });

      expect(result).toBeNull();
    });
  });

  describe('POST /preferences/test-push', () => {
    it('forwards request body and returns upstream payload', async () => {
      const payload = { sent: 2, failed: 0 };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(200, payload));

      const result = await controller.testPush({ deviceId: 'device-1' });

      expect(result).toEqual(payload);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/preferences/test-push'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ deviceId: 'device-1' }),
        }),
      );
    });
  });

  describe('refresh-gate retry', () => {
    it('retries with new token on upstream 401 + refresh success', async () => {
      const retryBody = { categories: [] };
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken
        .mockReturnValueOnce('expired-tok')
        .mockReturnValueOnce('fresh-tok');
      refreshGate.attemptRefresh.mockResolvedValue('success');
      fetchSpy
        .mockResolvedValueOnce(mockFetchResponse(401, 'Unauthorized'))
        .mockResolvedValueOnce(mockFetchResponse(200, retryBody));

      const result = await controller.listPreferences();

      expect(result).toEqual(retryBody);
      expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        expect.stringContaining('/api/v1/preferences'),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer fresh-tok' }),
        }),
      );
    });

    it('throws 401 to caller on upstream 401 + permanent_failure', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('expired-tok');
      refreshGate.attemptRefresh.mockResolvedValue('permanent_failure');
      fetchSpy.mockResolvedValue(mockFetchResponse(401, 'Unauthorized'));

      await expect(controller.listPreferences()).rejects.toThrow(UnauthorizedException);
      expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-2xx pass-through', () => {
    it.each([400, 404, 422, 500])('preserves HTTP status %i from upstream', async (statusCode) => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(statusCode, 'error body'));

      try {
        await controller.listPreferences();
        fail('Expected HttpException');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(statusCode);
      }
    });

    it('preserves 500 response body text', async () => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok');
      fetchSpy.mockResolvedValue(mockFetchResponse(500, 'Internal Server Error'));

      try {
        await controller.listPreferences();
        fail('Expected HttpException');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(500);
        expect((e as HttpException).getResponse()).toBe('Internal Server Error');
      }
    });
  });
});
