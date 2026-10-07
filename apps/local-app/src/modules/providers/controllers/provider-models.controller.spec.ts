import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProviderModelsController } from './provider-models.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../services/mcp-provider-registration.service';

import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';

describe('ProviderModelsController', () => {
  let controller: ProviderModelsController;
  let fakeExecutor: FakeProcessExecutor;
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

  const agyProvider = {
    ...opencodeProvider,
    name: 'agy',
    binPath: '/usr/local/bin/agy',
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

    fakeExecutor = new FakeProcessExecutor();
    fakeExecutor.setDefaultResponse({ type: 'success', stdout: '' });

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
        {
          provide: ProcessExecutor,
          useValue: fakeExecutor,
        },
      ],
    }).compile();

    controller = module.get(ProviderModelsController);
  });

  describe('POST /api/providers/:id/models', () => {
    it.each([
      {
        name: 'single',
        input: { name: 'gpt-4.1' },
        response: {
          id: 'm1',
          providerId: 'provider-1',
          name: 'gpt-4.1',
          position: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        expectedArgs: [
          {
            providerId: 'provider-1',
            name: 'gpt-4.1',
          },
        ],
      },
      {
        name: 'bulk',
        input: {
          models: [{ name: 'b', position: 2 }, { name: 'a', position: 1 }, { name: 'c' }],
        },
        response: {
          added: ['a', 'b'],
          existing: ['c'],
        },
        expectedArgs: ['provider-1', ['a', 'b', 'c']],
      },
    ])(
      'creates models through the $name branch',
      async ({ name, input, response, expectedArgs }) => {
        const create =
          name === 'single' ? storage.createProviderModel : storage.bulkCreateProviderModels;
        create.mockResolvedValue(response);
        const result = await controller.createProviderModel('provider-1', input);
        expect(create.mock.calls[0]).toEqual(expectedArgs);
        if (name === 'single') expect(result).toMatchObject({ name: 'gpt-4.1' });
        else expect(result).toEqual({ ...response, total: 3 });
      },
    );
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
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'gpt-4.1\n\nclaude-sonnet-4\n',
      });
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['gpt-4.1'],
        existing: ['claude-sonnet-4'],
      });

      const result = await controller.discoverProviderModels('provider-1');

      expect(mcpRegistration.resolveBinary).toHaveBeenCalledWith(opencodeProvider);
      expect(fakeExecutor.calls[0].argv).toEqual(['/usr/local/bin/opencode', 'models']);
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
      expect(fakeExecutor.calls).toHaveLength(0);
    });

    it('discovers agy models by parsing `agy models` display names (mirrors opencode)', async () => {
      storage.getProvider.mockResolvedValue(agyProvider);
      mcpRegistration.resolveBinary.mockResolvedValue({
        success: true,
        binaryPath: '/usr/local/bin/agy',
      });
      // Real `agy models` v1.0.12 output (8 display names, one per line).
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: [
          'Gemini 3.5 Flash (Medium)',
          'Gemini 3.5 Flash (High)',
          'Gemini 3.5 Flash (Low)',
          'Gemini 3.1 Pro (Low)',
          'Gemini 3.1 Pro (High)',
          'Claude Sonnet 4.6 (Thinking)',
          'Claude Opus 4.6 (Thinking)',
          'GPT-OSS 120B (Medium)',
        ].join('\n'),
      });
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['Gemini 3.5 Flash (High)'],
        existing: [],
      });

      const result = await controller.discoverProviderModels('provider-1');

      expect(mcpRegistration.resolveBinary).toHaveBeenCalledWith(agyProvider);
      expect(fakeExecutor.calls[0].argv).toEqual(['/usr/local/bin/agy', 'models']);
      // All 8 display names are parsed and bulk-created verbatim (each is also the
      // `--model` value agy accepts).
      expect(storage.bulkCreateProviderModels).toHaveBeenCalledWith('provider-1', [
        'Gemini 3.5 Flash (Medium)',
        'Gemini 3.5 Flash (High)',
        'Gemini 3.5 Flash (Low)',
        'Gemini 3.1 Pro (Low)',
        'Gemini 3.1 Pro (High)',
        'Claude Sonnet 4.6 (Thinking)',
        'Claude Opus 4.6 (Thinking)',
        'GPT-OSS 120B (Medium)',
      ]);
      expect(result).toEqual({ added: ['Gemini 3.5 Flash (High)'], existing: [], total: 1 });
    });

    it('returns bad request when binary cannot be resolved', async () => {
      mcpRegistration.resolveBinary.mockResolvedValue({
        success: false,
        message: 'Unable to locate binary',
      });

      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(fakeExecutor.calls).toHaveLength(0);
    });

    it.each([
      { name: 'timeout', response: { type: 'timeout' as const } },
      { name: 'nonzero exit', response: { type: 'failure' as const, exitCode: 1, stderr: 'boom' } },
      {
        name: 'missing executable',
        response: { type: 'failure' as const, exitCode: undefined, stdout: '', stderr: '' },
      },
    ])('maps discovery $name to bad request', async ({ response }) => {
      fakeExecutor.enqueueResponse(response);
      await expect(controller.discoverProviderModels('provider-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
