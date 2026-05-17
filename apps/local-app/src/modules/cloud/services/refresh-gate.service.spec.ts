import { RefreshGateService } from './refresh-gate.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';

describe('RefreshGateService', () => {
  let gate: RefreshGateService;
  let cloudSession: jest.Mocked<CloudSessionManagerService>;

  beforeEach(() => {
    cloudSession = {
      refreshAccessToken: jest.fn(),
      getAccessToken: jest.fn(),
    } as unknown as jest.Mocked<CloudSessionManagerService>;

    gate = new RefreshGateService(cloudSession);
  });

  it('should return success when refresh succeeds and token is available', async () => {
    cloudSession.refreshAccessToken.mockResolvedValue();
    cloudSession.getAccessToken.mockReturnValue('new-token');

    const result = await gate.attemptRefresh();
    expect(result).toBe('success');
    expect(cloudSession.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('should return permanent_failure when refresh succeeds but no token', async () => {
    cloudSession.refreshAccessToken.mockResolvedValue();
    cloudSession.getAccessToken.mockReturnValue(null);

    const result = await gate.attemptRefresh();
    expect(result).toBe('permanent_failure');
  });

  it('should return permanent_failure for revoked token errors', async () => {
    cloudSession.refreshAccessToken.mockRejectedValue(new Error('Token revoked'));

    const result = await gate.attemptRefresh();
    expect(result).toBe('permanent_failure');
  });

  it('should return transient_failure for network errors', async () => {
    cloudSession.refreshAccessToken.mockRejectedValue(new Error('Network timeout'));

    const result = await gate.attemptRefresh();
    expect(result).toBe('transient_failure');
  });

  it('should coalesce concurrent refresh attempts (single-flight)', async () => {
    let resolveRefresh: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    cloudSession.refreshAccessToken.mockImplementation(() => refreshPromise);
    cloudSession.getAccessToken.mockReturnValue('token');

    const promise1 = gate.attemptRefresh();
    const promise2 = gate.attemptRefresh();
    const promise3 = gate.attemptRefresh();

    resolveRefresh!();

    const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

    expect(r1).toBe('success');
    expect(r2).toBe('success');
    expect(r3).toBe('success');
    expect(cloudSession.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('should allow a new refresh after previous one completes', async () => {
    cloudSession.refreshAccessToken.mockResolvedValue();
    cloudSession.getAccessToken.mockReturnValue('token');

    await gate.attemptRefresh();
    await gate.attemptRefresh();

    expect(cloudSession.refreshAccessToken).toHaveBeenCalledTimes(2);
  });
});
