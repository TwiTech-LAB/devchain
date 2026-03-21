import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersController } from './providers.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { ProviderAdapterFactory } from '../adapters';
import { ProbeProofService } from '../services/probe-proof.service';
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
import { probe1mSupport, ProbeOutcome } from '../utils/probe-1m';

jest.mock('fs/promises', () => ({
  stat: jest.fn(),
  access: jest.fn(),
}));

jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = jest.requireActual('child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require('util');
  const asyncMock = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
  const mockFn = jest.fn();
  Object.defineProperty(mockFn, promisify.custom, {
    value: asyncMock,
    writable: true,
  });
  return { ...actual, execFile: mockFn, __mockExecFileAsync: asyncMock };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mockExecFileAsync = require('child_process').__mockExecFileAsync as jest.Mock;

jest.mock('../../sessions/utils/claude-config', () => ({
  disableClaudeAutoCompact: jest.fn(),
  enableClaudeAutoCompact: jest.fn(),
}));

jest.mock('../utils/probe-1m', () => ({
  probe1mSupport: jest.fn(),
}));

const mockProbe1mSupport = probe1mSupport as jest.MockedFunction<typeof probe1mSupport>;

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
  let probeProofService: ProbeProofService;
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
    mockExecFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    mockProbe1mSupport.mockReset();
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
        ProbeProofService,
      ],
    }).compile();

    controller = module.get(ProvidersController);
    probeProofService = module.get(ProbeProofService);
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

    it('rejects oneMillionContextEnabled=true on create (no server proof possible)', async () => {
      await expect(
        controller.createProvider({
          name: 'claude',
          binPath: '/usr/local/bin/claude',
          oneMillionContextEnabled: true,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(storage.createProvider).not.toHaveBeenCalled();
    });

    it('allows oneMillionContextEnabled=false on create', async () => {
      const now = new Date('2024-01-01T00:00:00Z');
      storage.createProvider.mockImplementation(async (payload) => ({
        id: 'p1',
        ...payload,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));

      await controller.createProvider({
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        oneMillionContextEnabled: false,
      });

      expect(storage.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          oneMillionContextEnabled: false,
        }),
      );
    });

    it('defaults oneMillionContextEnabled to undefined when omitted on create', async () => {
      const now = new Date('2024-01-01T00:00:00Z');
      storage.createProvider.mockImplementation(async (payload) => ({
        id: 'p1',
        oneMillionContextEnabled: false,
        ...payload,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));

      await controller.createProvider({
        name: 'claude',
        binPath: '/usr/local/bin/claude',
      });

      expect(storage.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          oneMillionContextEnabled: undefined,
        }),
      );
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

    it('allows oneMillionContextEnabled=true with valid server probe proof', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      // Record server-side proof for the correct binPath
      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      const result = await controller.updateProvider('p1', {
        oneMillionContextEnabled: true,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ oneMillionContextEnabled: true }),
      );
      expect(result.oneMillionContextEnabled).toBe(true);
    });

    it('rejects oneMillionContextEnabled=true without server probe proof', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      await expect(
        controller.updateProvider('p1', {
          oneMillionContextEnabled: true,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(storage.updateProvider).not.toHaveBeenCalled();
    });

    it('rejects oneMillionContextEnabled=true when binPath changed after probe (stale proof)', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      // Proof recorded for old binPath
      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      // Update with new binPath AND oneMillionContextEnabled=true
      await expect(
        controller.updateProvider('p1', {
          binPath: '/opt/new-claude/bin/claude',
          oneMillionContextEnabled: true,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(storage.updateProvider).not.toHaveBeenCalled();
    });

    it('rejects forged probeConfirmed boolean in request body on update', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      // No server-side proof recorded — forged boolean should not bypass gate
      await expect(
        controller.updateProvider('p1', {
          oneMillionContextEnabled: true,
          probeConfirmed: true, // forged client boolean
        } as Record<string, unknown>),
      ).rejects.toThrow(BadRequestException);

      expect(storage.updateProvider).not.toHaveBeenCalled();
    });

    it('allows oneMillionContextEnabled=false without server proof', async () => {
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      await controller.updateProvider('p1', {
        oneMillionContextEnabled: false,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ oneMillionContextEnabled: false }),
      );
    });
    it('auto-disables oneMillionContextEnabled when binPath changes on already-enabled Claude provider', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/opt/new-claude/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      // Proof exists for old binPath
      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      // binPath-only update — no oneMillionContextEnabled in payload
      const result = await controller.updateProvider('p1', {
        binPath: '/opt/new-claude/bin/claude',
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          binPath: '/opt/new-claude/bin/claude',
          oneMillionContextEnabled: false,
          autoCompactThreshold: 95,
        }),
      );
      expect(result.oneMillionContextEnabled).toBe(false);

      // Proof should be cleared
      expect(probeProofService.hasValidProof('p1', '/usr/local/bin/claude')).toBe(false);
      expect(probeProofService.hasValidProof('p1', '/opt/new-claude/bin/claude')).toBe(false);
    });

    it('does not auto-disable when binPath changes on non-Claude provider', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'codex',
        binPath: '/usr/local/bin/codex',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'codex',
        binPath: '/opt/new/codex',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      await controller.updateProvider('p1', {
        binPath: '/opt/new/codex',
      });

      // Should NOT include oneMillionContextEnabled in the payload
      expect(storage.updateProvider).toHaveBeenCalledWith('p1', { binPath: '/opt/new/codex' });
    });

    it('does not auto-disable when binPath unchanged on already-enabled Claude provider', async () => {
      storage.getProvider.mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      }));

      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      // Same binPath — should not auto-disable
      await controller.updateProvider('p1', {
        binPath: '/usr/local/bin/claude',
      });

      // Should NOT include oneMillionContextEnabled in the payload
      expect(storage.updateProvider).toHaveBeenCalledWith('p1', {
        binPath: '/usr/local/bin/claude',
      });
    });

    it('full reprobe cycle: binPath change auto-disables, then reprobe + enable succeeds for new path', async () => {
      // Step 1: existing enabled Claude provider
      const existingProvider = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      storage.getProvider.mockResolvedValue(existingProvider);
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        ...existingProvider,
        ...payload,
        id,
      }));

      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      // Step 2: update binPath — should auto-disable 1M and clear proof
      await controller.updateProvider('p1', {
        binPath: '/opt/new-claude/bin/claude',
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          binPath: '/opt/new-claude/bin/claude',
          oneMillionContextEnabled: false,
          autoCompactThreshold: 95,
        }),
      );
      expect(probeProofService.hasValidProof('p1', '/usr/local/bin/claude')).toBe(false);
      expect(probeProofService.hasValidProof('p1', '/opt/new-claude/bin/claude')).toBe(false);

      // Step 3: probe with new binPath — should record proof for new path
      storage.getProvider.mockResolvedValue({
        ...existingProvider,
        binPath: '/opt/new-claude/bin/claude',
        oneMillionContextEnabled: false,
      });
      mockProbe1mSupport.mockResolvedValue({
        supported: true,
        status: 'supported',
        capture: '{}',
      });

      const probeResult = await controller.probe1mContext('p1');
      expect(probeResult.supported).toBe(true);
      expect(probeProofService.hasValidProof('p1', '/opt/new-claude/bin/claude')).toBe(true);

      // Step 4: enable 1M with new proof — should succeed
      storage.updateProvider.mockClear();
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        ...existingProvider,
        binPath: '/opt/new-claude/bin/claude',
        oneMillionContextEnabled: true,
        ...payload,
        id,
      }));

      const result = await controller.updateProvider('p1', {
        oneMillionContextEnabled: true,
      });

      expect(result.oneMillionContextEnabled).toBe(true);
      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ oneMillionContextEnabled: true, autoCompactThreshold: 50 }),
      );
    });

    it('defaults autoCompactThreshold to 50 when enabling 1M via API without explicit threshold', async () => {
      const existingProvider = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      storage.getProvider.mockResolvedValue(existingProvider);
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        ...existingProvider,
        ...payload,
        id,
      }));

      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      await controller.updateProvider('p1', {
        oneMillionContextEnabled: true,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          oneMillionContextEnabled: true,
          autoCompactThreshold: 50,
        }),
      );
    });

    it('defaults autoCompactThreshold to 95 when disabling 1M via API without explicit threshold', async () => {
      const existingProvider = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      storage.getProvider.mockResolvedValue(existingProvider);
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        ...existingProvider,
        ...payload,
        id,
      }));

      await controller.updateProvider('p1', {
        oneMillionContextEnabled: false,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          oneMillionContextEnabled: false,
          autoCompactThreshold: 95,
        }),
      );
    });

    it('preserves explicit autoCompactThreshold when enabling 1M via API', async () => {
      const existingProvider = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      storage.getProvider.mockResolvedValue(existingProvider);
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        ...existingProvider,
        ...payload,
        id,
      }));

      probeProofService.recordProof('p1', '/usr/local/bin/claude');

      await controller.updateProvider('p1', {
        oneMillionContextEnabled: true,
        autoCompactThreshold: 60,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          oneMillionContextEnabled: true,
          autoCompactThreshold: 60,
        }),
      );
    });

    it('preserves explicit autoCompactThreshold when disabling 1M via API', async () => {
      const existingProvider = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      storage.getProvider.mockResolvedValue(existingProvider);
      storage.updateProvider.mockImplementation(async (id, payload) => ({
        ...existingProvider,
        ...payload,
        id,
      }));

      await controller.updateProvider('p1', {
        oneMillionContextEnabled: false,
        autoCompactThreshold: 80,
      });

      expect(storage.updateProvider).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          oneMillionContextEnabled: false,
          autoCompactThreshold: 80,
        }),
      );
    });

    it('reprobe after binPath change fails when new binary does not support 1M', async () => {
      const existingProvider = {
        id: 'p1',
        name: 'claude',
        binPath: '/opt/new-claude/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };
      storage.getProvider.mockResolvedValue(existingProvider);
      mockProbe1mSupport.mockResolvedValue({
        supported: false,
        status: 'unsupported',
        capture: '{}',
      });

      // Probe with unsupported binary — no proof recorded
      const probeResult = await controller.probe1mContext('p1');
      expect(probeResult.supported).toBe(false);
      expect(probeProofService.hasValidProof('p1', '/opt/new-claude/bin/claude')).toBe(false);

      // Attempt to enable 1M — should fail
      await expect(
        controller.updateProvider('p1', { oneMillionContextEnabled: true }),
      ).rejects.toThrow(BadRequestException);
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

  describe('probe1mContext', () => {
    const claudeProvider = {
      id: 'p1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      autoCompactThreshold: null,
      oneMillionContextEnabled: false,
      createdAt: '',
      updatedAt: '',
    };

    it('rejects non-Claude providers', async () => {
      storage.getProvider.mockResolvedValue({ ...claudeProvider, name: 'codex' });

      await expect(controller.probe1mContext('p1')).rejects.toThrow(BadRequestException);
      expect(mockProbe1mSupport).not.toHaveBeenCalled();
    });

    it('rejects Claude provider without binPath', async () => {
      storage.getProvider.mockResolvedValue({ ...claudeProvider, binPath: null });

      await expect(controller.probe1mContext('p1')).rejects.toThrow(BadRequestException);
      expect(mockProbe1mSupport).not.toHaveBeenCalled();
    });

    it('delegates to probe1mSupport with binPath and timeout', async () => {
      storage.getProvider.mockResolvedValue(claudeProvider);
      mockProbe1mSupport.mockResolvedValue({
        supported: true,
        status: 'supported',
        capture: '{}',
      });

      await controller.probe1mContext('p1');

      expect(mockProbe1mSupport).toHaveBeenCalledWith('/usr/local/bin/claude', 30_000);
    });

    it('records proof when outcome is supported', async () => {
      storage.getProvider.mockResolvedValue(claudeProvider);
      mockProbe1mSupport.mockResolvedValue({
        supported: true,
        status: 'supported',
        capture: '{}',
      });

      const result = await controller.probe1mContext('p1');

      expect(result.supported).toBe(true);
      expect(result.status).toBe('supported');
      expect(probeProofService.hasValidProof('p1', '/usr/local/bin/claude')).toBe(true);
    });

    it('does not record proof when outcome is unsupported', async () => {
      storage.getProvider.mockResolvedValue(claudeProvider);
      mockProbe1mSupport.mockResolvedValue({
        supported: false,
        status: 'unsupported',
        capture: '{}',
      });

      const result = await controller.probe1mContext('p1');

      expect(result.supported).toBe(false);
      expect(result.status).toBe('unsupported');
      expect(probeProofService.hasValidProof('p1', '/usr/local/bin/claude')).toBe(false);
    });

    it('does not record proof on timeout', async () => {
      storage.getProvider.mockResolvedValue(claudeProvider);
      mockProbe1mSupport.mockResolvedValue({
        supported: false,
        status: 'timeout',
        detail: 'Timed out',
      });

      const result = await controller.probe1mContext('p1');

      expect(result.supported).toBe(false);
      expect(result.status).toBe('timeout');
      expect(probeProofService.hasValidProof('p1', '/usr/local/bin/claude')).toBe(false);
    });

    it('does not record proof on launch_failure', async () => {
      storage.getProvider.mockResolvedValue(claudeProvider);
      mockProbe1mSupport.mockResolvedValue({
        supported: false,
        status: 'launch_failure',
        detail: 'No output from probe command',
      });

      const result = await controller.probe1mContext('p1');

      expect(result.supported).toBe(false);
      expect(result.status).toBe('launch_failure');
      expect(probeProofService.hasValidProof('p1', '/usr/local/bin/claude')).toBe(false);
    });

    it('returns the outcome from probe1mSupport as-is', async () => {
      storage.getProvider.mockResolvedValue(claudeProvider);
      const outcome: ProbeOutcome = {
        supported: false,
        status: 'launch_failure',
        capture: 'some output',
        detail: 'Probe returned error',
      };
      mockProbe1mSupport.mockResolvedValue(outcome);

      const result = await controller.probe1mContext('p1');

      expect(result).toEqual(outcome);
    });
  });
});
