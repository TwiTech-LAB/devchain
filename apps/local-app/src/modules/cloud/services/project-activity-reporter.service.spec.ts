import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ProjectActivityReporterService } from './project-activity-reporter.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { RefreshGateService } from './refresh-gate.service';

// Layer: module unit. This service orchestrates cloud auth, refresh, and fetch I/O with externals mocked.

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';

function mockFetchResponse(status: number, body: unknown = '', ok?: boolean) {
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

describe('ProjectActivityReporterService', () => {
  let service: ProjectActivityReporterService;
  let cloudSession: jest.Mocked<Pick<CloudSessionManagerService, 'getStatus' | 'getAccessToken'>>;
  let refreshGate: jest.Mocked<Pick<RefreshGateService, 'attemptRefresh'>>;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    cloudSession = {
      getStatus: jest.fn().mockReturnValue(connectedStatus),
      getAccessToken: jest.fn().mockReturnValue('tok-abc'),
    };
    refreshGate = {
      attemptRefresh: jest.fn(),
    };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(204, '', true));

    service = new ProjectActivityReporterService(
      cloudSession as unknown as CloudSessionManagerService,
      refreshGate as unknown as RefreshGateService,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('trims the project id before forwarding', async () => {
    await service.touchProject(`  ${PROJECT_ID}  `);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/activity/projects/${PROJECT_ID}/touch`),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects an empty project id', async () => {
    await expect(service.touchProject('   ')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException for direct touch when cloud is disconnected', async () => {
    cloudSession.getStatus.mockReturnValue({ connected: false, identityServiceUrl: '' });

    await expect(service.touchProject(PROJECT_ID)).rejects.toThrow(UnauthorizedException);
  });

  it('preserves upstream errors for direct touch callers', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(422, 'bad project'));

    try {
      await service.touchProject(PROJECT_ID);
      fail('Expected HttpException');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(422);
    }
  });
  it('forwards to notifications-service activity touch endpoint with access token', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValue('tok-abc');
    fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

    const result = await service.touchProject(PROJECT_ID);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/activity/projects/${PROJECT_ID}/touch`),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok-abc' }),
      }),
    );
  });
  it('URL-encodes projectId path segment', async () => {
    cloudSession.getStatus.mockReturnValue(connectedStatus);
    cloudSession.getAccessToken.mockReturnValue('tok-abc');
    fetchSpy.mockResolvedValue(mockFetchResponse(204, '', true));

    await service.touchProject('project/alpha:1');

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

    const result = await service.touchProject(PROJECT_ID);

    expect(result).toBeNull();
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      expect.stringContaining(`/api/v1/activity/projects/${PROJECT_ID}/touch`),
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

    await expect(service.touchProject(PROJECT_ID)).rejects.toThrow(UnauthorizedException);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
  });
});
