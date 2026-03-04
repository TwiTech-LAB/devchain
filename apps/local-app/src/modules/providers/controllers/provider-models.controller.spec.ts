import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProviderModelsController } from './provider-models.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { ConflictError } from '../../../common/errors/error-types';

jest.mock('child_process', () => {
  const execFileMock = jest.fn();
  execFileMock[Symbol.for('nodejs.util.promisify.custom')] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const callback = (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      };
      execFileMock(...args, callback);
    });
  return { execFile: execFileMock };
});

type ExecFileWithPromisify = typeof execFile & {
  [promisify.custom]: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;
};

const mockExecFile = execFile as jest.MockedFunction<ExecFileWithPromisify>;

function mockExecFileCallback(error: Error | null, stdout: string, stderr: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args.find(
      (arg): arg is (err: Error | null, out: string, errOut: string) => void =>
        typeof arg === 'function',
    );
    if (!cb) {
      throw new Error('execFile callback was not provided');
    }
    cb(error, stdout, stderr);
    return {} as never;
  });
}

describe('ProviderModelsController', () => {
  let controller: ProviderModelsController;
  let storage: {
    getProvider: jest.Mock;
    listProviderModelsByProvider: jest.Mock;
    createProviderModel: jest.Mock;
    bulkCreateProviderModels: jest.Mock;
    deleteProviderModel: jest.Mock;
  };
  let mcpRegistration: {
    resolveBinary: jest.Mock;
  };

  const opencodeProvider = {
    id: 'provider-1',
    name: 'opencode',
    binPath: '/usr/local/bin/opencode',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    storage = {
      getProvider: jest.fn().mockResolvedValue(opencodeProvider),
      listProviderModelsByProvider: jest.fn().mockResolvedValue([]),
      createProviderModel: jest.fn(),
      bulkCreateProviderModels: jest.fn(),
      deleteProviderModel: jest.fn().mockResolvedValue(undefined),
    };

    mcpRegistration = {
      resolveBinary: jest
        .fn()
        .mockResolvedValue({ success: true, binaryPath: '/usr/local/bin/opencode' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderModelsController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
        {
          provide: McpProviderRegistrationService,
          useValue: mcpRegistration,
        },
      ],
    }).compile();

    controller = module.get(ProviderModelsController);
  });

  describe('GET /api/providers/:id/models', () => {
    it('lists models after validating provider exists', async () => {
      storage.listProviderModelsByProvider.mockResolvedValue([
        { id: 'm1', providerId: 'provider-1', name: 'gpt-4.1', position: 0 },
      ]);

      const result = await controller.listProviderModels('provider-1');

      expect(storage.getProvider).toHaveBeenCalledWith('provider-1');
      expect(storage.listProviderModelsByProvider).toHaveBeenCalledWith('provider-1');
      expect(result).toHaveLength(1);
    });

    it('propagates NotFoundException when provider does not exist', async () => {
      storage.getProvider.mockRejectedValue(new NotFoundException('Provider not found'));

      await expect(controller.listProviderModels('missing-provider')).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.listProviderModelsByProvider).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/providers/:id/models', () => {
    it('creates a single model from {name}', async () => {
      storage.createProviderModel.mockResolvedValue({
        id: 'm1',
        providerId: 'provider-1',
        name: 'gpt-4.1',
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await controller.createProviderModel('provider-1', { name: 'gpt-4.1' });

      expect(storage.createProviderModel).toHaveBeenCalledWith({
        providerId: 'provider-1',
        name: 'gpt-4.1',
      });
      expect(result.name).toBe('gpt-4.1');
    });

    it('bulk imports models from {models} and returns stats', async () => {
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['a', 'b'],
        existing: ['c'],
      });

      const result = await controller.createProviderModel('provider-1', {
        models: [{ name: 'b', position: 2 }, { name: 'a', position: 1 }, { name: 'c' }],
      });

      expect(storage.bulkCreateProviderModels).toHaveBeenCalledWith('provider-1', ['a', 'b', 'c']);
      expect(result).toEqual({
        added: ['a', 'b'],
        existing: ['c'],
        total: 3,
      });
    });

    it('rejects invalid payload {}', async () => {
      await expect(controller.createProviderModel('provider-1', {})).rejects.toThrow();
      expect(storage.createProviderModel).not.toHaveBeenCalled();
      expect(storage.bulkCreateProviderModels).not.toHaveBeenCalled();
    });

    it('rejects invalid payload {name: \"\"}', async () => {
      await expect(controller.createProviderModel('provider-1', { name: '' })).rejects.toThrow();
      expect(storage.createProviderModel).not.toHaveBeenCalled();
      expect(storage.bulkCreateProviderModels).not.toHaveBeenCalled();
    });

    it('rejects invalid payload {models: \"invalid\"}', async () => {
      await expect(
        controller.createProviderModel('provider-1', { models: 'invalid' }),
      ).rejects.toThrow();
      expect(storage.createProviderModel).not.toHaveBeenCalled();
      expect(storage.bulkCreateProviderModels).not.toHaveBeenCalled();
    });

    it('propagates ConflictError for duplicate single-model create', async () => {
      storage.createProviderModel.mockRejectedValue(
        new ConflictError('Model "gpt-4.1" already exists for this provider.'),
      );

      await expect(
        controller.createProviderModel('provider-1', { name: 'gpt-4.1' }),
      ).rejects.toThrow(ConflictError);
      expect(storage.createProviderModel).toHaveBeenCalledWith({
        providerId: 'provider-1',
        name: 'gpt-4.1',
      });
    });
  });

  describe('DELETE /api/providers/:id/models/:modelId', () => {
    it('deletes a model scoped to the provider', async () => {
      storage.listProviderModelsByProvider.mockResolvedValue([
        { id: 'm1', providerId: 'provider-1', name: 'gpt-4.1', position: 0 },
      ]);

      const result = await controller.deleteProviderModel('provider-1', 'm1');

      expect(storage.deleteProviderModel).toHaveBeenCalledWith('m1');
      expect(result).toEqual({ success: true });
    });

    it('throws NotFoundException when model is not found under provider', async () => {
      storage.listProviderModelsByProvider.mockResolvedValue([
        { id: 'm2', providerId: 'provider-1', name: 'gpt-4.1', position: 0 },
      ]);

      await expect(controller.deleteProviderModel('provider-1', 'm1')).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.deleteProviderModel).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/providers/:id/models/discover', () => {
    it('discovers models, parses output, and merges via bulkCreate', async () => {
      mockExecFileCallback(null, 'gpt-4.1\n\nclaude-sonnet-4\n', '');
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['gpt-4.1'],
        existing: ['claude-sonnet-4'],
      });

      const result = await controller.discoverProviderModels('provider-1');

      expect(mcpRegistration.resolveBinary).toHaveBeenCalledWith(opencodeProvider);
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/local/bin/opencode',
        ['models'],
        expect.objectContaining({ timeout: 30000, maxBuffer: 1024 * 1024 }),
        expect.any(Function),
      );
      expect(storage.bulkCreateProviderModels).toHaveBeenCalledWith('provider-1', [
        'gpt-4.1',
        'claude-sonnet-4',
      ]);
      expect(result).toEqual({
        added: ['gpt-4.1'],
        existing: ['claude-sonnet-4'],
        total: 2,
      });
    });

    it('rejects discover for non-opencode providers', async () => {
      storage.getProvider.mockResolvedValue({
        ...opencodeProvider,
        name: 'claude',
      });

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mcpRegistration.resolveBinary).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('returns bad request when binary cannot be resolved', async () => {
      mcpRegistration.resolveBinary.mockResolvedValue({
        success: false,
        message: 'Unable to locate binary',
      });

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('maps timeout failures to bad request', async () => {
      const timeoutError = Object.assign(new Error('Command timed out'), {
        killed: true,
        signal: 'SIGTERM',
        code: null,
      });
      mockExecFileCallback(timeoutError, '', '');

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('maps ENOENT failures to bad request', async () => {
      const enoentError = Object.assign(new Error('not found'), {
        code: 'ENOENT',
      });
      mockExecFileCallback(enoentError, '', '');

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('maps non-zero exit failures to bad request', async () => {
      const exitError = Object.assign(new Error('Exit 1'), {
        code: 1,
        stderr: 'boom',
      });
      mockExecFileCallback(exitError, '', 'boom');

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('maps unexpected discover failures to InternalServerErrorException', async () => {
      const unexpectedError = Object.assign(new Error('unexpected failure'), {
        code: 'EACCES',
      });
      mockExecFileCallback(unexpectedError, '', '');

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
