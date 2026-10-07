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
    it.each([
      {
        name: 'controller.listPreferences',
        token: 'tok-abc',
        response: { categories: [{ category: 'epic.assigned', channel: 'push', enabled: true }] },
        invoke: () => controller.listPreferences(),
        url: expect.stringContaining('/api/v1/preferences'),
        options: expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-abc' }),
        }),
      },
      {
        name: 'controller.getCatalog',
        token: 'tok-abc',
        response: {
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
        },
        invoke: () => controller.getCatalog(),
        url: expect.stringContaining('/api/v1/preferences/catalog'),
        options: expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer tok-abc' }),
        }),
      },
      {
        name: 'controller.upsertCategory',
        token: 'tok',
        response: { category: 'epic.assigned', channel: 'push', enabled: true },
        invoke: () =>
          controller.upsertCategory('epic.assigned', { channel: 'push', enabled: true }),
        url: expect.stringContaining('/api/v1/preferences/categories/epic.assigned'),
        options: expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ channel: 'push', enabled: true }),
        }),
      },
      {
        name: 'controller.getQuietHours',
        token: 'tok',
        response: { enabled: false, startMinutes: 0, endMinutes: 0, timezone: 'UTC' },
        invoke: () => controller.getQuietHours(),
        url: expect.stringContaining('/api/v1/preferences/quiet-hours'),
        options: expect.objectContaining({ method: 'GET' }),
      },
      {
        name: 'controller.getSmartSuppression',
        token: 'tok',
        response: { enabled: true, windowMinutes: 5 },
        invoke: () => controller.getSmartSuppression(),
        url: expect.stringContaining('/api/v1/preferences/smart-suppression'),
        options: expect.objectContaining({ method: 'GET' }),
      },
      {
        name: 'controller.upsertQuietHours',
        token: 'tok',
        response: {
          enabled: true,
          startMinutes: 1320,
          endMinutes: 480,
          timezone: 'America/New_York',
        },
        invoke: () =>
          controller.upsertQuietHours({
            enabled: true,
            startMinutes: 1320,
            endMinutes: 480,
            timezone: 'America/New_York',
          }),
        url: expect.stringContaining('/api/v1/preferences/quiet-hours'),
        options: expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            enabled: true,
            startMinutes: 1320,
            endMinutes: 480,
            timezone: 'America/New_York',
          }),
        }),
      },
      {
        name: 'controller.upsertSmartSuppression',
        token: 'tok',
        response: { enabled: true, windowMinutes: 10 },
        invoke: () => controller.upsertSmartSuppression({ enabled: true, windowMinutes: 10 }),
        url: expect.stringContaining('/api/v1/preferences/smart-suppression'),
        options: expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ enabled: true, windowMinutes: 10 }),
        }),
      },
      {
        name: 'controller.testPush',
        token: 'tok',
        response: { sent: 2, failed: 0 },
        invoke: () => controller.testPush({ deviceId: 'device-1' }),
        url: expect.stringContaining('/api/v1/preferences/test-push'),
        options: expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ deviceId: 'device-1' }),
        }),
      },
    ])('forwards preferences through $name', async ({ token, response, invoke, url, options }) => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue(token);
      fetchSpy.mockResolvedValue(mockFetchResponse(200, response));
      expect(await invoke()).toEqual(response);
      expect(fetchSpy).toHaveBeenCalledWith(url, options);
      expect(fetchSpy.mock.calls[0][1].headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer ' + token }),
      );
    });
  });

  describe('PUT /preferences/categories/:category', () => {
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
