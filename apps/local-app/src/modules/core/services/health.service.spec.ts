import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ready=true when all injected checks pass', async () => {
    const checker = {
      getChecks: jest.fn().mockResolvedValue({
        db: 'ok',
        tmux: 'ok',
      }),
    };
    service = new HealthService(checker);

    const result = await service.getReadiness();

    expect(result).toEqual({
      ready: true,
      checks: {
        db: 'ok',
        tmux: 'ok',
      },
    });
  });

  it('returns ready=false when any injected check fails', async () => {
    const checker = {
      getChecks: jest.fn().mockResolvedValue({
        orchestratorDb: 'ok',
        docker: 'fail',
      }),
    };
    service = new HealthService(checker);

    const result = await service.getReadiness();

    expect(result).toEqual({
      ready: false,
      checks: {
        orchestratorDb: 'ok',
        docker: 'fail',
      },
    });
  });

  it('returns ready=false when no checker is registered', async () => {
    service = new HealthService(undefined);

    const result = await service.getReadiness();

    expect(result).toEqual({
      ready: false,
      checks: {},
    });
  });
});
