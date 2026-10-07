import { Test, TestingModule } from '@nestjs/testing';
import { ProviderConfigsController } from './provider-configs.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import { ProfileProviderConfig } from '../../storage/models/domain.models';
import { ProviderConfigsService } from '../services/provider-configs.service';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ProviderConfigsController', () => {
  let controller: ProviderConfigsController;
  let storage: {
    getProfileProviderConfig: jest.Mock;
    deleteProfileProviderConfig: jest.Mock;
  };
  let providerConfigsService: { updateProviderConfig: jest.Mock; deleteProviderConfig: jest.Mock };

  const baseConfig: ProfileProviderConfig = {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    name: 'test-config',
    description: null,
    options: '--model test',
    env: { API_KEY: 'test-key' },
    model: null,
    effort: null,
    position: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    storage = {
      getProfileProviderConfig: jest.fn(),
      deleteProfileProviderConfig: jest.fn(),
    };
    providerConfigsService = {
      updateProviderConfig: jest.fn(),
      deleteProviderConfig: jest.fn((id: string) => storage.deleteProfileProviderConfig(id)),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderConfigsController],
      providers: [
        { provide: ProjectWriteAdmissionService, useValue: createProjectWriteAdmissionStub() },
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
        {
          provide: ProviderConfigsService,
          useValue: providerConfigsService,
        },
      ],
    }).compile();

    controller = module.get(ProviderConfigsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('PUT /api/provider-configs/:id', () => {
    it.each([
      { name: 'only options', patch: { options: null } },
      { name: 'clear env', patch: { env: null } },
      { name: 'structured defaults', patch: { model: 'claude-sonnet-4-5', effort: 'high' } },
      { name: 'clear structured defaults', patch: { model: null, effort: null } },
      { name: 'omit structured defaults', patch: { options: '--model new' } },
    ])('updates provider config with $name', async ({ patch }) => {
      providerConfigsService.updateProviderConfig.mockResolvedValue({ ...baseConfig, ...patch });
      const result = await controller.updateProviderConfig('config-1', patch);
      expect(providerConfigsService.updateProviderConfig).toHaveBeenCalledWith('config-1', patch);
      expect(result).toMatchObject(patch);
    });

    it('validates env keys', async () => {
      await expect(
        controller.updateProviderConfig('config-1', { env: { 'INVALID-KEY': 'value' } }),
      ).rejects.toThrow();
    });

    it('validates env values', async () => {
      await expect(
        controller.updateProviderConfig('config-1', { env: { KEY: 'has\nnewline' } }),
      ).rejects.toThrow();
    });
  });

  describe('DELETE /api/provider-configs/:id', () => {
    it('throws BadRequest when config is referenced by agents', async () => {
      storage.deleteProfileProviderConfig.mockRejectedValue(
        new ValidationError('Cannot delete: config in use'),
      );

      await expect(controller.deleteProviderConfig('config-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws when config not found', async () => {
      storage.deleteProfileProviderConfig.mockRejectedValue(
        new NotFoundError('ProfileProviderConfig', 'config-1'),
      );

      await expect(controller.deleteProviderConfig('config-1')).rejects.toThrow(NotFoundError);
    });
  });
});
