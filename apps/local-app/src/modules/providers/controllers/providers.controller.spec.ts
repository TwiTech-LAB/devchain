import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersController } from './providers.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { ProviderAdapterFactory } from '../adapters';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as fsPromises from 'fs/promises';
import { Stats, constants } from 'fs';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';

jest.mock('fs/promises', () => ({
  stat: jest.fn(),
  access: jest.fn(),
}));

jest.mock('../../sessions/utils/claude-config', () => ({
  disableClaudeAutoCompact: jest.fn(),
  enableClaudeAutoCompact: jest.fn(),
}));

const mockDisableClaudeAutoCompact = disableClaudeAutoCompact as jest.MockedFunction<
  typeof disableClaudeAutoCompact
>;
const mockEnableClaudeAutoCompact = enableClaudeAutoCompact as jest.MockedFunction<
  typeof enableClaudeAutoCompact
>;

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
  let mcpEnsureService: {
    ensureMcp: jest.Mock;
  };
  let normalizeBinPathSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
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

    mcpEnsureService = {
      ensureMcp: jest.fn().mockResolvedValue({
        success: true,
        action: 'already_configured',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      }),
    };
    mockDisableClaudeAutoCompact.mockResolvedValue({ success: true });

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
        {
          provide: ProviderMcpEnsureService,
          useValue: mcpEnsureService,
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

    it('passes autoCompactThreshold to storage on create', async () => {
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
        autoCompactThreshold: 10,
      });

      expect(storage.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          autoCompactThreshold: 10,
        }),
      );
      expect(result.autoCompactThreshold).toBe(10);
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

    it('passes autoCompactThreshold to storage on update', async () => {
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: 15,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      const result = await controller.updateProvider('p1', {
        autoCompactThreshold: 15,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          autoCompactThreshold: 15,
        }),
      );
      expect(result.autoCompactThreshold).toBe(15);
    });

    it('clears autoCompactThreshold when set to null', async () => {
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      const result = await controller.updateProvider('p1', {
        autoCompactThreshold: null,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          autoCompactThreshold: null,
        }),
      );
      expect(result.autoCompactThreshold).toBeNull();
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
      mcpEnsureService.ensureMcp.mockResolvedValue({
        success: true,
        action: 'already_configured',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const response = await controller.ensureMcp('p1', {});

      expect(response.action).toBe('already_configured');
      expect(mcpEnsureService.ensureMcp).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', name: 'claude' }),
        undefined, // projectPath
      );
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
      mcpEnsureService.ensureMcp.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const response = await controller.ensureMcp('p1', {});

      expect(response.action).toBe('added');
      expect(mcpEnsureService.ensureMcp).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1', name: 'claude' }),
        undefined,
      );
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
      mcpEnsureService.ensureMcp.mockResolvedValue({
        success: true,
        action: 'fixed_mismatch',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const response = await controller.ensureMcp('p1', {});

      expect(response.action).toBe('fixed_mismatch');
      expect(mcpEnsureService.ensureMcp).toHaveBeenCalled();
    });

    it('throws when ensure service returns error', async () => {
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
      mcpEnsureService.ensureMcp.mockResolvedValue({
        success: false,
        action: 'error',
        message: 'MCP ensure not supported for provider: unsupported',
      });

      await expect(controller.ensureMcp('p1', {})).rejects.toThrow(BadRequestException);
    });

    it('passes projectPath to ensure service', async () => {
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
      mcpEnsureService.ensureMcp.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      await controller.ensureMcp('p1', { projectPath: '/home/user/project' });

      expect(mcpEnsureService.ensureMcp).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        '/home/user/project',
      );
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

  describe('disableAutoCompact', () => {
    it('returns success when Claude auto-compact is disabled', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mockDisableClaudeAutoCompact.mockResolvedValue({ success: true });

      const response = await controller.disableAutoCompact('p1');

      expect(response).toEqual({ success: true });
      expect(mockDisableClaudeAutoCompact).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when provider id is unknown', async () => {
      storage.getProvider.mockRejectedValue(new NotFoundException('Provider not found'));

      await expect(controller.disableAutoCompact('missing')).rejects.toThrow(NotFoundException);
      expect(mockDisableClaudeAutoCompact).not.toHaveBeenCalled();
    });

    it('returns 400 for non-Claude providers', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'codex',
        binPath: '/usr/local/bin/codex',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });

      await expect(controller.disableAutoCompact('p1')).rejects.toThrow(BadRequestException);
      expect(mockDisableClaudeAutoCompact).not.toHaveBeenCalled();

      try {
        await controller.disableAutoCompact('p1');
      } catch (error) {
        expect((error as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({
            message: 'Auto-compact configuration is only applicable to Claude provider',
          }),
        );
      }
    });

    it('returns 400 when Claude config is malformed', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mockDisableClaudeAutoCompact.mockResolvedValue({
        success: false,
        error: 'Unexpected token } in JSON',
        errorType: 'invalid_config',
      });

      await expect(controller.disableAutoCompact('p1')).rejects.toThrow(BadRequestException);
      expect(mockDisableClaudeAutoCompact).toHaveBeenCalledTimes(1);

      try {
        await controller.disableAutoCompact('p1');
      } catch (error) {
        expect((error as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({
            message: '~/.claude.json contains invalid JSON. Please fix the file manually.',
          }),
        );
      }
    });

    it('returns 500 when disable operation fails due to IO error', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mockDisableClaudeAutoCompact.mockResolvedValue({
        success: false,
        error: 'EACCES: permission denied',
        errorType: 'io_error',
      });

      await expect(controller.disableAutoCompact('p1')).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(mockDisableClaudeAutoCompact).toHaveBeenCalledTimes(1);

      try {
        await controller.disableAutoCompact('p1');
      } catch (error) {
        expect((error as InternalServerErrorException).getResponse()).toEqual(
          expect.objectContaining({
            message: 'Failed to write ~/.claude.json',
          }),
        );
      }
    });
  });

  describe('enableAutoCompact', () => {
    it('returns success when Claude auto-compact is enabled', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mockEnableClaudeAutoCompact.mockResolvedValue({ success: true });

      const response = await controller.enableAutoCompact('p1');

      expect(response).toEqual({ success: true });
      expect(mockEnableClaudeAutoCompact).toHaveBeenCalledTimes(1);
    });

    it('returns 400 for non-Claude providers', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'codex',
        binPath: '/usr/local/bin/codex',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });

      await expect(controller.enableAutoCompact('p1')).rejects.toThrow(BadRequestException);
      expect(mockEnableClaudeAutoCompact).not.toHaveBeenCalled();
    });

    it('returns 400 when Claude config is malformed', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mockEnableClaudeAutoCompact.mockResolvedValue({
        success: false,
        error: 'Unexpected token',
        errorType: 'invalid_config',
      });

      await expect(controller.enableAutoCompact('p1')).rejects.toThrow(BadRequestException);
    });

    it('returns 500 when enable operation fails due to IO error', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        createdAt: '',
        updatedAt: '',
      });
      mockEnableClaudeAutoCompact.mockResolvedValue({
        success: false,
        error: 'EACCES: permission denied',
        errorType: 'io_error',
      });

      await expect(controller.enableAutoCompact('p1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
