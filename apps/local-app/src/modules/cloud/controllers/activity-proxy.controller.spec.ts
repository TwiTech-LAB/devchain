import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, HttpException } from '@nestjs/common';
import { ActivityProxyController } from './activity-proxy.controller';
import { CloudSessionManagerService } from '../services/cloud-session-manager.service';
import { RefreshGateService } from '../services/refresh-gate.service';
import { ProjectActivityReporterService } from '../services/project-activity-reporter.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';

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

describe('ActivityProxyController', () => {
  let controller: ActivityProxyController;
  let cloudSession: jest.Mocked<Pick<CloudSessionManagerService, 'getStatus' | 'getAccessToken'>>;
  let refreshGate: jest.Mocked<Pick<RefreshGateService, 'attemptRefresh'>>;
  let mockDb: { prepare: jest.Mock };
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    cloudSession = {
      getStatus: jest.fn(),
      getAccessToken: jest.fn(),
    };
    refreshGate = {
      attemptRefresh: jest.fn(),
    };
    mockDb = {
      prepare: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActivityProxyController],
      providers: [
        ProjectActivityReporterService,
        { provide: DB_CONNECTION, useValue: mockDb },
        { provide: CloudSessionManagerService, useValue: cloudSession },
        { provide: RefreshGateService, useValue: refreshGate },
      ],
    }).compile();

    controller = module.get<ActivityProxyController>(ActivityProxyController);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws 401 when cloud is not connected and does not call upstream', async () => {
    cloudSession.getStatus.mockReturnValue({ connected: false, identityServiceUrl: '' });

    await expect(controller.touchProject('project-1')).rejects.toThrow(UnauthorizedException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards to notifications-service activity touch endpoint with access token', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValue('tok-abc');
    fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

    const result = await controller.touchProject('project-1');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/activity/projects/project-1/touch'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok-abc' }),
      }),
    );
  });

  it('returns null for upstream 204 without JSON parsing', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValue('tok-abc');
    const response = mockFetchResponse(204, '', true);
    const jsonSpy = jest.spyOn(response, 'json');
    fetchSpy.mockResolvedValue(response);

    const result = await controller.touchProject('project-1');

    expect(result).toBeNull();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('URL-encodes projectId path segment', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValue('tok-abc');
    fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

    await controller.touchProject('project/alpha:1');

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent('project/alpha:1'));
  });

  it('retries once with refreshed token on upstream 401 and refresh success', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValueOnce('expired').mockReturnValueOnce('fresh');
    refreshGate.attemptRefresh.mockResolvedValue('success');
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse(401, 'Unauthorized'))
      .mockResolvedValueOnce(mockFetchResponse(204, '', true));

    const result = await controller.touchProject('project-1');

    expect(result).toBeNull();
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/v1/activity/projects/project-1/touch'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer fresh' }),
      }),
    );
  });

  it('throws UnauthorizedException on upstream 401 when refresh permanently fails', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValue('expired');
    refreshGate.attemptRefresh.mockResolvedValue('permanent_failure');
    fetchSpy.mockResolvedValue(mockFetchResponse(401, 'Unauthorized'));

    await expect(controller.touchProject('project-1')).rejects.toThrow(UnauthorizedException);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 422, 500])(
    'preserves upstream non-2xx status %i as HttpException',
    async (statusCode) => {
      cloudSession.getStatus.mockReturnValue(connectedStatus);
      cloudSession.getAccessToken.mockReturnValue('tok-abc');
      fetchSpy.mockResolvedValue(mockFetchResponse(statusCode, 'error body'));

      try {
        await controller.touchProject('project-1');
        fail('Expected HttpException');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(statusCode);
      }
    },
  );
});
