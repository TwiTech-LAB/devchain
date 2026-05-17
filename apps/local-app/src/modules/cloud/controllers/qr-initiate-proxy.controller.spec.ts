import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, HttpException } from '@nestjs/common';
import { QrInitiateProxyController } from './qr-initiate-proxy.controller';
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

describe('QrInitiateProxyController', () => {
  let controller: QrInitiateProxyController;
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
      controllers: [QrInitiateProxyController],
      providers: [
        { provide: CloudSessionManagerService, useValue: cloudSession },
        { provide: RefreshGateService, useValue: refreshGate },
      ],
    }).compile();

    controller = module.get<QrInitiateProxyController>(QrInitiateProxyController);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should return 401 when cloud is not connected, without firing upstream', async () => {
    cloudSession.getStatus.mockReturnValue({ connected: false, identityServiceUrl: '' });

    await expect(controller.initiate({ machineLabel: 'host' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should forward upstream 200 JSON body unchanged', async () => {
    const upstreamResponse = {
      qrPayload: '{"v":1,"p":"abc","c":"ABCD"}',
      crossCheckCode: 'ABCD',
      channelId: 'ch-1',
      pollToken: 'pt-1',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      email: 'u@x.com',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok-123');
    fetchSpy.mockResolvedValue(mockFetchResponse(200, upstreamResponse));

    const result = await controller.initiate({ machineLabel: 'myhost' });

    expect(result).toEqual(upstreamResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/auth/qr/initiate'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-123',
          'Content-Type': 'application/json',
        },
      }),
    );
    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody).toEqual({ machineLabel: 'myhost' });
  });

  it('should not call refreshGate on initial 200', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(200, { channelId: 'ch-1' }));

    await controller.initiate({});

    expect(refreshGate.attemptRefresh).not.toHaveBeenCalled();
  });

  it('should retry once with new token on 401 then refresh success', async () => {
    const retryBody = { channelId: 'ch-2', qrPayload: 'qr-new' };
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

    const result = await controller.initiate({ machineLabel: 'host' });

    expect(result).toEqual(retryBody);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('/auth/qr/initiate'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer fresh-tok',
          'Content-Type': 'application/json',
        },
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

    await expect(controller.initiate({})).rejects.toThrow(UnauthorizedException);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
  });

  it('should passthrough 429 with preserved status code', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(429, 'Too Many Requests'));

    try {
      await controller.initiate({});
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
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
      await controller.initiate({});
      fail('Expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(500);
      expect((e as HttpException).getResponse()).toBe('Internal Server Error');
    }
  });

  it('should send empty object body when body is undefined', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: true,
      userId: 'u1',
      expiresAt: new Date().toISOString(),
      identityServiceUrl: '',
    });
    cloudSession.getAccessToken.mockReturnValue('tok');
    fetchSpy.mockResolvedValue(mockFetchResponse(200, { channelId: 'ch-1' }));

    await controller.initiate({});

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody).toEqual({});
  });
});
