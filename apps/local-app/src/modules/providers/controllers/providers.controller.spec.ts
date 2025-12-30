import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersController } from './providers.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderAdapterFactory } from '../adapters';
import { BadRequestException } from '@nestjs/common';
import * as fsPromises from 'fs/promises';
import { Stats, constants } from 'fs';

jest.mock('fs/promises', () => ({
  stat: jest.fn(),
  access: jest.fn(),
}));

describe('ProvidersController', () => {
  let controller: ProvidersController;
  let storage: {
    createProvider: jest.Mock;
    updateProvider: jest.Mock;
    updateProviderMcpMetadata: jest.Mock;
    getProvider: jest.Mock;
    listAgentProfiles: jest.Mock;
    deleteProvider: jest.Mock;
  };
  let mcpRegistration: {
    registerProvider: jest.Mock;
    listRegistrations: jest.Mock;
    removeRegistration: jest.Mock;
    runShellCommand: jest.Mock;
  };
  let normalizeBinPathSpy: jest.SpyInstance;

  beforeEach(async () => {
    storage = {
      createProvider: jest.fn(),
      updateProvider: jest.fn(),
      updateProviderMcpMetadata: jest.fn(),
      getProvider: jest.fn(),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [] }),
      deleteProvider: jest.fn(),
    };

    mcpRegistration = {
      registerProvider: jest.fn(),
      listRegistrations: jest.fn(),
      removeRegistration: jest.fn(),
      runShellCommand: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProvidersController],
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
          provide: PreflightService,
          useValue: {
            clearCache: jest.fn(),
          },
        },
        {
          provide: ProviderAdapterFactory,
          useValue: {
            isSupported: jest.fn().mockReturnValue(true),
            getAdapter: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(ProvidersController);
    normalizeBinPathSpy = jest
      .spyOn(
        controller as unknown as {
          normalizeBinPath: (p: string | null) => Promise<string | null>;
        },
        'normalizeBinPath',
      )
      .mockImplementation(async (value) => value);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createProvider', () => {
    it('creates provider without auto-registering MCP', async () => {
      const now = new Date('2024-01-01T00:00:00Z');
      storage.createProvider.mockImplementation(async (payload) => ({
        id: 'p1',
        ...payload,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));

      const result = await controller.createProvider({
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpEndpoint: 'ws://localhost:4000',
      });

      expect(mcpRegistration.registerProvider).not.toHaveBeenCalled();
      expect(storage.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'claude',
          binPath: '/usr/local/bin/claude',
          mcpConfigured: false,
          mcpEndpoint: 'ws://localhost:4000',
          mcpRegisteredAt: null,
        }),
      );
      expect(result.mcpConfigured).toBe(false);
    });
  });

  describe('normalizeBinPath', () => {
    it('preserves the provided absolute path without resolving symlinks', async () => {
      normalizeBinPathSpy.mockRestore();

      const statMock = fsPromises.stat as jest.Mock;
      const accessMock = fsPromises.access as jest.Mock;
      statMock.mockResolvedValue({ isFile: () => true } as unknown as Stats);
      accessMock.mockResolvedValue(undefined);

      const input = '/tmp/some/path/bin';
      const result = await (
        controller as unknown as {
          normalizeBinPath: (p: string | null | undefined) => Promise<string | null>;
        }
      ).normalizeBinPath(input);

      expect(statMock).toHaveBeenCalledWith(input);
      expect(accessMock).toHaveBeenCalledWith(input, constants.X_OK);
      expect(result).toBe(input);

      statMock.mockReset();
      accessMock.mockReset();
    });
  });

  describe('updateProvider', () => {
    it('updates provider without auto-re-registering MCP', async () => {
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: 'ws://localhost:5000',
        mcpRegisteredAt: '2024-01-01',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      await controller.updateProvider('p1', {
        mcpEndpoint: 'ws://localhost:5000',
      });

      expect(mcpRegistration.registerProvider).not.toHaveBeenCalled();
      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          mcpEndpoint: 'ws://localhost:5000',
        }),
      );
    });
  });

  describe('ensureMcp', () => {
    it('returns already_configured when devchain alias exists with correct endpoint', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: 'http://127.0.0.1:3000/mcp',
        mcpRegisteredAt: '2024-01-01',
        createdAt: '',
        updatedAt: '',
      });
      mcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const response = await controller.ensureMcp('p1', {});

      expect(response.action).toBe('already_configured');
      expect(mcpRegistration.registerProvider).not.toHaveBeenCalled();
      expect(storage.updateProviderMcpMetadata).not.toHaveBeenCalled();
    });

    it('returns added when devchain alias does not exist', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'MCP command completed successfully.',
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const response = await controller.ensureMcp('p1', {});

      expect(response.action).toBe('added');
      expect(mcpRegistration.registerProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', name: 'claude' }),
        expect.objectContaining({ endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' }),
        expect.anything(), // execOptions
      );
      expect(storage.updateProviderMcpMetadata).toHaveBeenCalled();
    });

    it('returns fixed_mismatch when endpoint differs', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: 'http://127.0.0.1:4000/mcp',
        mcpRegisteredAt: '2024-01-01',
        createdAt: '',
        updatedAt: '',
      });
      mcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:4000/mcp' }],
      });
      mcpRegistration.removeRegistration.mockResolvedValue({
        success: true,
        message: 'Removed',
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      mcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'MCP command completed successfully.',
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const response = await controller.ensureMcp('p1', {});

      expect(response.action).toBe('fixed_mismatch');
      expect(mcpRegistration.removeRegistration).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        'devchain',
        expect.anything(), // execOptions
      );
      expect(mcpRegistration.registerProvider).toHaveBeenCalled();
      expect(storage.updateProviderMcpMetadata).toHaveBeenCalled();
    });

    it('throws when provider is not supported', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'unsupported',
        binPath: null,
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      const adapterFactory = {
        isSupported: jest.fn().mockReturnValue(false),
        getAdapter: jest.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controller as any).adapterFactory = adapterFactory;

      await expect(controller.ensureMcp('p1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('configureMcp', () => {
    it('fails when endpoint missing', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });

      await expect(controller.configureMcp('p1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updates metadata when MCP configuration succeeds', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: 'ws://localhost:4000',
        mcpRegisteredAt: '2024-01-01',
        createdAt: '',
        updatedAt: '',
      });
      mcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'MCP command completed successfully.',
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      });

      const response = await controller.configureMcp('p1', {
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(mcpRegistration.registerProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', name: 'claude' }),
        expect.objectContaining({ endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' }),
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
      expect(storage.updateProviderMcpMetadata).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          mcpConfigured: true,
          mcpEndpoint: 'http://127.0.0.1:3000/mcp',
          mcpRegisteredAt: expect.any(String),
        }),
      );
      expect(response?.success).toBe(true);
    });
  });
});
