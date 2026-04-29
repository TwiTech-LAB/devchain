import { Test, TestingModule } from '@nestjs/testing';
import { PreflightController } from './preflight.controller';
import { PreflightService } from '../services/preflight.service';
import type { PreflightResult } from '../services/preflight.service';

describe('PreflightController', () => {
  let controller: PreflightController;
  let mockPreflightService: { runChecks: jest.Mock; clearCache: jest.Mock };

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
      clearCache: jest.fn(),
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
    it('?all=1 → calls runChecks with includeAllProviders: true', async () => {
      await controller.runPreflightChecks(undefined, '1');
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders: true,
      });
    });

    it('?all=true → calls runChecks with includeAllProviders: true', async () => {
      await controller.runPreflightChecks(undefined, 'true');
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders: true,
      });
    });

    it('?all=0 → calls runChecks with includeAllProviders: false', async () => {
      await controller.runPreflightChecks(undefined, '0');
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders: false,
      });
    });

    it('?all=false → calls runChecks with includeAllProviders: false', async () => {
      await controller.runPreflightChecks(undefined, 'false');
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders: false,
      });
    });

    it('?all=random → calls runChecks with includeAllProviders: false', async () => {
      await controller.runPreflightChecks(undefined, 'random');
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders: false,
      });
    });

    it('?all omitted → calls runChecks with includeAllProviders: false', async () => {
      await controller.runPreflightChecks(undefined, undefined);
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith(undefined, {
        includeAllProviders: false,
      });
    });

    it('?projectPath=<x>&all=1 → forwards both params correctly', async () => {
      await controller.runPreflightChecks('/my/project', '1');
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith('/my/project', {
        includeAllProviders: true,
      });
    });

    it('?projectPath=<x> only → forwards projectPath with includeAllProviders: false', async () => {
      await controller.runPreflightChecks('/my/project', undefined);
      expect(mockPreflightService.runChecks).toHaveBeenCalledWith('/my/project', {
        includeAllProviders: false,
      });
    });
  });

  describe('POST /api/preflight/clear-cache', () => {
    it('calls clearCache with projectPath when provided', async () => {
      const result = await controller.clearCache('/my/project');
      expect(mockPreflightService.clearCache).toHaveBeenCalledWith('/my/project');
      expect(result.success).toBe(true);
    });

    it('calls clearCache without projectPath when omitted', async () => {
      const result = await controller.clearCache(undefined);
      expect(mockPreflightService.clearCache).toHaveBeenCalledWith(undefined);
      expect(result.success).toBe(true);
    });
  });
});
