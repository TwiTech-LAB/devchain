import { Test, type TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';
import { ProviderClisController } from './provider-clis.controller';
import { ProviderCliVersionsService } from '../services/provider-cli-versions.service';

describe('ProviderClisController', () => {
  let controller: ProviderClisController;
  let cliVersions: {
    getOverview: jest.Mock;
    setVersion: jest.Mock;
    checkNow: jest.Mock;
  };

  beforeEach(async () => {
    cliVersions = {
      getOverview: jest.fn(),
      setVersion: jest.fn(),
      checkNow: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderClisController],
      providers: [
        {
          provide: ProviderCliVersionsService,
          useValue: cliVersions,
        },
      ],
    }).compile();
    controller = module.get(ProviderClisController);
  });

  describe('GET /api/provider-clis', () => {
    it('returns the service overview unchanged', () => {
      const overview = {
        providers: {
          claude: { provider: 'claude', setting: { version: 'latest', homeManaged: false } },
        },
      };
      cliVersions.getOverview.mockReturnValue(overview);

      expect(controller.getOverview()).toBe(overview);
    });
  });

  describe('PUT /api/provider-clis/:provider', () => {
    it('passes a validated provider and body through to the service', async () => {
      cliVersions.setVersion.mockReturnValue({ version: '2.1.281', homeManaged: true });

      await expect(
        controller.setVersion('claude', { version: '2.1.281', homeManaged: true }),
      ).resolves.toEqual({
        provider: 'claude',
        setting: { version: '2.1.281', homeManaged: true },
      });
      expect(cliVersions.setVersion).toHaveBeenCalledWith('claude', {
        version: '2.1.281',
        homeManaged: true,
      });
    });

    it('rejects an unknown provider', async () => {
      await expect(
        controller.setVersion('agy', { version: 'latest', homeManaged: false }),
      ).rejects.toThrow(ZodError);
      expect(cliVersions.setVersion).not.toHaveBeenCalled();
    });

    it.each([
      { version: '2.1.281-beta.1', homeManaged: false },
      { version: 'v2.1.281', homeManaged: false },
      { version: 'latest', homeManaged: 'true' },
      { version: 'latest' },
      { version: 'latest', homeManaged: false, extra: true },
    ])('rejects an invalid body %j', async (body) => {
      await expect(controller.setVersion('claude', body)).rejects.toThrow(ZodError);
      expect(cliVersions.setVersion).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/provider-clis/check', () => {
    it('runs the immediate check and wraps the results', async () => {
      const lookups = {
        claude: { latestVersion: '2.1.281', versions: [], checkedAt: 'now', error: null },
      };
      cliVersions.checkNow.mockResolvedValue(lookups);

      await expect(controller.check()).resolves.toEqual({ lookups });
    });
  });
});
