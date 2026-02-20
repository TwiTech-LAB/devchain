import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from '../services/health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let mockHealthService: jest.Mocked<HealthService>;

  beforeEach(() => {
    mockHealthService = {
      getReadiness: jest.fn(),
      onModuleInit: jest.fn(),
    } as unknown as jest.Mocked<HealthService>;
    controller = new HealthController(mockHealthService);
    jest.clearAllMocks();
  });

  it('keeps /health response shape unchanged', () => {
    const result = controller.check();

    expect(result).toEqual(
      expect.objectContaining({
        status: 'ok',
        environment: expect.any(String),
        version: expect.any(String),
        timestamp: expect.any(String),
      }),
    );
  });

  it('delegates /health/ready to service and returns ready=true', async () => {
    mockHealthService.getReadiness.mockResolvedValue({
      ready: true,
      checks: {
        db: 'ok',
        tmux: 'ok',
      },
    });

    const result = await controller.ready();

    expect(mockHealthService.getReadiness).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ready: true,
      checks: {
        db: 'ok',
        tmux: 'ok',
      },
    });
  });

  it('returns 503 when readiness check fails', async () => {
    mockHealthService.getReadiness.mockResolvedValue({
      ready: false,
      checks: {
        db: 'fail',
        tmux: 'ok',
      },
    });

    try {
      await controller.ready();
      fail('Expected ServiceUnavailableException');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const response = (error as ServiceUnavailableException).getResponse();
      expect(response).toEqual({
        ready: false,
        checks: {
          db: 'fail',
          tmux: 'ok',
        },
      });
    }
  });
});
