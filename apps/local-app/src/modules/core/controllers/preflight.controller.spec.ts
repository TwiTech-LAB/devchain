import { Test, TestingModule } from '@nestjs/testing';
import { PreflightController } from './preflight.controller';
import { PreflightService } from '../services/preflight.service';
import type { PreflightResult } from '../services/preflight.service';

describe('PreflightController', () => {
  let controller: PreflightController;
  let mockPreflightService: { runChecks: jest.Mock };

  const mockResult: PreflightResult = {
    overall: 'pass',
    checks: [],
    providers: [],
    supportedMcpProviders: [],
    timestamp: new Date().toISOString(),
  };

  beforeEach(async () => {
    mockPreflightService = {
      runChecks: jest.fn().mockResolvedValue(mockResult),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PreflightController],
      providers: [{ provide: PreflightService, useValue: mockPreflightService }],
    }).compile();

    controller = module.get<PreflightController>(PreflightController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/preflight — ?all= query param parsing', () => {
    it.each([
      ['1', true],
      ['true', true],
      ['random', false],
    ])('parses all=%s as %s', async (all, includeAllProviders) => {
      await controller.runPreflightChecks(undefined, all);
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders,
      });
    });
  });
});
