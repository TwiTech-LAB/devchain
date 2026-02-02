import { Test, TestingModule } from '@nestjs/testing';
import { ProviderConfigsController } from './provider-configs.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import { ProfileProviderConfig } from '../../storage/models/domain.models';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ProviderConfigsController', () => {
  let controller: ProviderConfigsController;
  let storage: {
    getProfileProviderConfig: jest.Mock;
    updateProfileProviderConfig: jest.Mock;
    deleteProfileProviderConfig: jest.Mock;
  };

  const baseConfig: ProfileProviderConfig = {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    name: 'test-config',
    options: '--model test',
    env: { API_KEY: 'test-key' },
    position: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    storage = {
      getProfileProviderConfig: jest.fn(),
      updateProfileProviderConfig: jest.fn(),
      deleteProfileProviderConfig: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderConfigsController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
      ],
    }).compile();

    controller = module.get(ProviderConfigsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/provider-configs/:id', () => {
    it('returns config when found', async () => {
      storage.getProfileProviderConfig.mockResolvedValue(baseConfig);

      const result = await controller.getProviderConfig('config-1');

      expect(storage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(result.id).toBe('config-1');
      expect(result.env).toEqual({ API_KEY: 'test-key' });
    });

    it('throws when config not found', async () => {
      storage.getProfileProviderConfig.mockRejectedValue(
        new NotFoundError('ProfileProviderConfig', 'config-1'),
      );

      await expect(controller.getProviderConfig('config-1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('PUT /api/provider-configs/:id', () => {
    it('updates config with all fields', async () => {
      const updatedConfig = {
        ...baseConfig,
        providerId: 'provider-2',
        options: '--model new',
        env: { NEW_KEY: 'new-value' },
      };
      storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);

      const result = await controller.updateProviderConfig('config-1', {
        providerId: 'provider-2',
        options: '--model new',
        env: { NEW_KEY: 'new-value' },
      });

      expect(storage.updateProfileProviderConfig).toHaveBeenCalledWith('config-1', {
        providerId: 'provider-2',
        options: '--model new',
        env: { NEW_KEY: 'new-value' },
      });
      expect(result.providerId).toBe('provider-2');
    });

    it('updates only provided fields', async () => {
      const updatedConfig = { ...baseConfig, options: null };
      storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);

      await controller.updateProviderConfig('config-1', { options: null });

      expect(storage.updateProfileProviderConfig).toHaveBeenCalledWith('config-1', {
        options: null,
      });
    });

    it('clears env by sending null', async () => {
      const updatedConfig = { ...baseConfig, env: null };
      storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);

      const result = await controller.updateProviderConfig('config-1', { env: null });

      expect(storage.updateProfileProviderConfig).toHaveBeenCalledWith('config-1', { env: null });
      expect(result.env).toBeNull();
    });

    it('throws when config not found', async () => {
      storage.updateProfileProviderConfig.mockRejectedValue(
        new NotFoundError('ProfileProviderConfig', 'config-1'),
      );

      await expect(controller.updateProviderConfig('config-1', { options: 'new' })).rejects.toThrow(
        NotFoundError,
      );
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
    it('deletes config successfully', async () => {
      storage.deleteProfileProviderConfig.mockResolvedValue(undefined);

      await expect(controller.deleteProviderConfig('config-1')).resolves.toBeUndefined();

      expect(storage.deleteProfileProviderConfig).toHaveBeenCalledWith('config-1');
    });

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
