import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ProjectActivityReporterService } from './project-activity-reporter.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { RefreshGateService } from './refresh-gate.service';

// Layer: module unit. This service orchestrates DB lookup, cloud auth, throttling, and fetch I/O with all externals mocked.

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
  let lookupStmt: { get: jest.Mock };
  let mockDb: { prepare: jest.Mock };
  let cloudSession: jest.Mocked<Pick<CloudSessionManagerService, 'getStatus' | 'getAccessToken'>>;
  let refreshGate: jest.Mocked<Pick<RefreshGateService, 'attemptRefresh'>>;
  let fetchSpy: jest.SpyInstance;
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    lookupStmt = { get: jest.fn() };
    mockDb = {
      prepare: jest.fn().mockReturnValue(lookupStmt),
    };
    cloudSession = {
      getStatus: jest.fn().mockReturnValue(connectedStatus),
      getAccessToken: jest.fn().mockReturnValue('tok-abc'),
    };
    refreshGate = {
      attemptRefresh: jest.fn(),
    };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(204, '', true));
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);

    service = new ProjectActivityReporterService(
      mockDb as unknown as ConstructorParameters<typeof ProjectActivityReporterService>[0],
      cloudSession as unknown as CloudSessionManagerService,
      refreshGate as unknown as RefreshGateService,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('resolves session activity through sessions.agent_id to agents.project_id before touching', async () => {
    lookupStmt.get.mockReturnValue({ projectId: 'project-1' });

    await service.onSessionActivityChanged({
      sessionId: 'session-1',
      state: 'busy',
      lastActivityAt: new Date().toISOString(),
      busySince: new Date().toISOString(),
    });

    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('JOIN agents'));
    expect(lookupStmt.get).toHaveBeenCalledWith('session-1');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/activity/projects/project-1/touch'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not touch for idle session activity', async () => {
    lookupStmt.get.mockReturnValue({ projectId: 'project-1' });

    await service.onSessionActivityChanged({
      sessionId: 'session-1',
      state: 'idle',
      lastActivityAt: null,
      busySince: null,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not touch when the session has no resolvable project id', async () => {
    lookupStmt.get.mockReturnValue({ projectId: null });

    await service.onSessionActivityChanged({
      sessionId: 'session-1',
      state: 'busy',
      lastActivityAt: new Date().toISOString(),
      busySince: new Date().toISOString(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throttles touches per project for one minute', async () => {
    await service.touchProject('project-1');
    nowSpy.mockReturnValue(30_000);
    await service.touchProject('project-1');
    nowSpy.mockReturnValue(60_001);
    await service.touchProject('project-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not share throttle buckets across projects', async () => {
    await service.touchProject('project-1');
    await service.touchProject('project-2');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/v1/activity/projects/project-2/touch'),
      expect.any(Object),
    );
  });

  it('swallows touch errors from session activity reporting', async () => {
    lookupStmt.get.mockReturnValue({ projectId: 'project-1' });
    fetchSpy.mockRejectedValue(new Error('network down'));

    await expect(
      service.onSessionActivityChanged({
        sessionId: 'session-1',
        state: 'busy',
        lastActivityAt: new Date().toISOString(),
        busySince: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it('throws UnauthorizedException for direct touch when cloud is disconnected', async () => {
    cloudSession.getStatus.mockReturnValue({ connected: false, identityServiceUrl: '' });

    await expect(service.touchProject('project-1')).rejects.toThrow(UnauthorizedException);
  });

  it('preserves upstream errors for direct touch callers', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(422, 'bad project'));

    try {
      await service.touchProject('project-1');
      fail('Expected HttpException');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(422);
    }
  });
});
