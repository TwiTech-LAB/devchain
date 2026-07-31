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
});
