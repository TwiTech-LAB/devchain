import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, HttpException } from '@nestjs/common';
import { DevicesProxyController } from './devices-proxy.controller';
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

describe('DevicesProxyController', () => {
  let controller: DevicesProxyController;
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
      controllers: [DevicesProxyController],
      providers: [
        { provide: CloudSessionManagerService, useValue: cloudSession },
        { provide: RefreshGateService, useValue: refreshGate },
      ],
    }).compile();

    controller = module.get<DevicesProxyController>(DevicesProxyController);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should return 401 when cloud is not connected, without firing upstream', async () => {
    cloudSession.getStatus.mockReturnValue({ connected: false, identityServiceUrl: '' });

    await expect(controller.list()).rejects.toThrow(UnauthorizedException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should forward upstream 200 JSON body unchanged', async () => {
    const devices = { devices: [{ id: 'd1', platform: 'android' }] };
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      email: 'u@x.com',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok-123');
    fetchSpy.mockResolvedValue(mockFetchResponse(200, devices));

    const result = await controller.list();

    expect(result).toEqual(devices);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/devices'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok-123' },
      }),
    );
  });

  it('should not call refreshGate on initial 200', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(200, { devices: [] }));

    await controller.list();

    expect(refreshGate.attemptRefresh).not.toHaveBeenCalled();
  });

  it('should retry once with new token on 401 then refresh success', async () => {
    const retryBody = { devices: [{ id: 'd2' }] };
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValueOnce('expired-tok').mockReturnValueOnce('fresh-tok');
    refreshGate.attemptRefresh.mockResolvedValue('success');
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(mockFetchResponse(200, retryBody));

    const result = await controller.list();

    expect(result).toEqual(retryBody);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/v1/devices'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer fresh-tok' },
      }),
    );
  });

  it('should surface 401 on refresh permanent_failure', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('expired-tok');
    refreshGate.attemptRefresh.mockResolvedValue('permanent_failure');
    fetchSpy.mockResolvedValue(mockFetchResponse(401, 'Unauthorized'));

    await expect(controller.list()).rejects.toThrow(UnauthorizedException);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
  });

  it('should passthrough 404 with preserved status code', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(404, 'Not Found'));

    try {
      await controller.list();
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(404);
    }
  });

  it('should passthrough 501 with preserved status code', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(501, 'Not Implemented'));

    try {
      await controller.list();
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(501);
    }
  });

  it('should passthrough 500 with status code and body text', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(500, 'Internal Server Error'));

    try {
      await controller.list();
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(500);
      expect((e as HttpException).getResponse()).toBe('Internal Server Error');
    }
  });
});
