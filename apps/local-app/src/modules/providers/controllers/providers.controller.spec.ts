import { ProviderCliInstallerService } from '../services/provider-cli-installer.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersController } from './providers.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { McpProviderRegistrationService } from '../services/mcp-provider-registration.service';
import { ProviderMcpEnsureService } from '../services/provider-mcp-ensure.service';
import { ProviderAdapterFactory } from '../adapters';
import { ProviderStateManager } from '../services/provider-state-manager.service';
import { ProviderProjectSyncService } from '../services/provider-project-sync.service';
import { ProviderDiscoveryService } from '../services/provider-discovery.service';
import { ProviderEffortSeedingService } from '../services/provider-effort-seeding.service';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { NotFoundError, ProjectRemoteError } from '../../../common/errors/error-types';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';

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
    updateProviderWithScopes: jest.Mock;
    updateProviderMcpMetadata: jest.Mock;
    getProvider: jest.Mock;
    listProviders: jest.Mock;
    listAgentProfiles: jest.Mock;
    getProject: jest.Mock;
    listProjects: jest.Mock;
    listEnvScopesByProviderIds: jest.Mock;
    deleteProvider: jest.Mock;
  };
  let mcpRegistration: {
    registerProvider: jest.Mock;
    listRegistrations: jest.Mock;
    removeRegistration: jest.Mock;
  };
  let mcpEnsureService: {
    ensureMcp: jest.Mock;
    assertPathNotRemoteOwned: jest.Mock;
  };
  let providerStateManager: ProviderStateManager;
  let mockSyncService: { syncProviderToAllProjects: jest.Mock };
  let mockDiscoveryService: { discoverInstalledBinaries: jest.Mock };
  let mockEffortSeeding: { seedForProvider: jest.Mock; backfillAll: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    storage = {
      createProvider: jest.fn(),
      updateProvider: jest.fn(),
      updateProviderWithScopes: jest.fn().mockImplementation(async (id, payload) => ({
        id,
        name: 'claude',
        binPath: null,
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        claudeLaunchSettingsJson: null,
        env: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        ...payload,
      })),
      updateProviderMcpMetadata: jest.fn(),
      getProvider: jest.fn().mockResolvedValue({
        id: 'p1',
        name: 'claude',
        binPath: null,
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        claudeLaunchSettingsJson: null,
        env: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      }),
      listProviders: jest.fn(),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [] }),
      getProject: jest.fn().mockRejectedValue(new NotFoundError('Project')),
      listProjects: jest.fn().mockResolvedValue({ items: [] }),
      listEnvScopesByProviderIds: jest.fn().mockReturnValue(new Map()),
      deleteProvider: jest.fn(),
    };

    mcpRegistration = {
      registerProvider: jest.fn(),
      listRegistrations: jest.fn(),
      removeRegistration: jest.fn(),
    };

    mcpEnsureService = {
      ensureMcp: jest.fn().mockResolvedValue({
        success: true,
        action: 'already_configured',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      }),
      assertPathNotRemoteOwned: jest.fn().mockResolvedValue(undefined),
    };
    mockDisableClaudeAutoCompact.mockResolvedValue({ success: true });

    mockSyncService = {
      syncProviderToAllProjects: jest.fn().mockResolvedValue({
        providerId: 'p1',
        insertedCount: 0,
        affectedProjectIds: [],
        skippedExistingCount: 0,
        skippedConflictCount: 0,
        warnings: [],
        excludedAuthorCount: 0,
        scopeConfigHash: 'test',
      }),
    };

    mockEffortSeeding = {
      seedForProvider: jest.fn().mockResolvedValue({ added: [], existing: [] }),
      backfillAll: jest.fn().mockResolvedValue({ providers: 0, seededProviders: 0 }),
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
        {
          provide: ProviderProjectSyncService,
          useValue: mockSyncService,
        },
        {
          provide: ProviderDiscoveryService,
          useFactory: () => {
            mockDiscoveryService = {
              discoverInstalledBinaries: jest.fn().mockResolvedValue({
                discovered: [],
                alreadyPresent: [],
                notFound: [],
              }),
            };
            return mockDiscoveryService;
          },
        },
        ProviderStateManager,
        {
          provide: ProviderCliInstallerService,
          useValue: { editBinaryPath: jest.fn((_name, _path, edit) => edit()) },
        },
        { provide: ProviderEffortSeedingService, useValue: mockEffortSeeding },
        {
          provide: ProcessExecutor,
          useFactory: () => {
            const fake = new FakeProcessExecutor();
            fake.setDefaultResponse({ type: 'success', stdout: '' });
            return fake;
          },
        },
      ],
    }).compile();

    controller = module.get(ProvidersController);
    providerStateManager = module.get(ProviderStateManager);
    jest
      .spyOn(providerStateManager, 'normalizeBinPath')
      .mockImplementation(async (value) => value ?? null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createProvider', () => {
    it('rejects invalid, reserved, and non-Claude launch settings before storage', async () => {
      await expect(
        controller.createProvider({
          name: 'claude',
          claudeLaunchSettingsJson: '[]',
        }),
      ).rejects.toMatchObject({ details: { field: 'claudeLaunchSettingsJson' } });
      await expect(
        controller.createProvider({
          name: 'claude',
          claudeLaunchSettingsJson: '{"env":{"DEVCHAIN_CONTEXT_WINDOW_TOKENS":"1000000"}}',
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('/env/DEVCHAIN_CONTEXT_WINDOW_TOKENS'),
        details: { field: 'claudeLaunchSettingsJson' },
      });
      await expect(
        controller.createProvider({
          name: 'codex',
          claudeLaunchSettingsJson: '{}',
        }),
      ).rejects.toMatchObject({ details: { field: 'claudeLaunchSettingsJson' } });

      expect(storage.createProvider).not.toHaveBeenCalled();
    });

    it('rejects create with invalid env key (regex violation)', async () => {
      await expect(
        controller.createProvider({
          name: 'claude',
          binPath: '/usr/local/bin/claude',
          env: { 'invalid-key': 'value' },
        }),
      ).rejects.toThrow();

      expect(storage.createProvider).not.toHaveBeenCalled();
    });

    it('rejects create with control char in env value', async () => {
      await expect(
        controller.createProvider({
          name: 'claude',
          binPath: '/usr/local/bin/claude',
          env: { GOOD_KEY: 'value\x00bad' },
        }),
      ).rejects.toThrow();

      expect(storage.createProvider).not.toHaveBeenCalled();
    });
  });

  describe('updateProvider', () => {
    it('rejects update with invalid env key', async () => {
      await expect(
        controller.updateProvider('p1', {
          env: { '123bad': 'val' },
        }),
      ).rejects.toThrow();

      expect(storage.updateProviderWithScopes).not.toHaveBeenCalled();
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

    it('refuses a projectPath owned by a remote before registering', async () => {
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
      const remoteError = new ProjectRemoteError('project-1', 'remote-9', 'vm-01');
      mcpEnsureService.assertPathNotRemoteOwned.mockRejectedValueOnce(remoteError);

      await expect(
        controller.configureMcp('p1', {
          endpoint: 'http://127.0.0.1:3000/mcp',
          projectPath: '/home/user/project',
        }),
      ).rejects.toBe(remoteError);
      expect(mcpEnsureService.assertPathNotRemoteOwned).toHaveBeenCalledWith('/home/user/project');
      expect(mcpRegistration.registerProvider).not.toHaveBeenCalled();
    });

    it('checks the projectPath ownership before a successful registration', async () => {
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
      mcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'MCP command completed successfully.',
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      });

      await controller.configureMcp('p1', {
        endpoint: 'http://127.0.0.1:3000/mcp',
        projectPath: '/home/user/project',
      });

      expect(mcpEnsureService.assertPathNotRemoteOwned).toHaveBeenCalledWith('/home/user/project');
      expect(mcpRegistration.registerProvider).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cwd: '/home/user/project' }),
      );
    });
  });

  describe('disableAutoCompact', () => {
    it.each([
      {
        name: 'disable invalid config',
        enable: false,
        errorType: 'invalid_config' as const,
        error: 'Unexpected token } in JSON',
        exception: BadRequestException,
        message: '~/.claude.json contains invalid JSON. Please fix the file manually.',
      },
      {
        name: 'disable IO failure',
        enable: false,
        errorType: 'io_error' as const,
        error: 'EACCES: permission denied',
        exception: InternalServerErrorException,
        message: 'Failed to write ~/.claude.json',
      },
      {
        name: 'enable invalid config',
        enable: true,
        errorType: 'invalid_config' as const,
        error: 'Unexpected token',
        exception: BadRequestException,
        message: '~/.claude.json contains invalid JSON. Please fix the file manually.',
      },
      {
        name: 'enable IO failure',
        enable: true,
        errorType: 'io_error' as const,
        error: 'EACCES: permission denied',
        exception: InternalServerErrorException,
        message: 'Failed to write ~/.claude.json',
      },
    ])('maps auto-compact $name', async ({ enable, errorType, error, exception, message }) => {
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
      const change = enable ? mockEnableClaudeAutoCompact : mockDisableClaudeAutoCompact;
      change.mockResolvedValue({ success: false, error, errorType });
      const result = await (
        enable ? controller.enableAutoCompact('p1') : controller.disableAutoCompact('p1')
      ).catch((error) => error);
      expect(result).toBeInstanceOf(exception);
      expect(result.getResponse()).toEqual(expect.objectContaining({ message }));
      expect(change).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncToProjects', () => {
    it('throws NotFoundException when provider does not exist', async () => {
      storage.getProvider.mockRejectedValue(new NotFoundException('Provider not found'));

      await expect(controller.syncToProjects('no-such-id')).rejects.toThrow(NotFoundException);
      expect(mockSyncService.syncProviderToAllProjects).not.toHaveBeenCalled();
    });
  });

  describe('envScopes', () => {
    const baseProvider = {
      id: 'p1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      autoCompactThreshold: null,
      env: { API_KEY: 'secret' },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };

    describe('GET /api/providers/:id', () => {
      it.each([
        { name: 'no scopes', scopes: new Map(), expected: {} },
        {
          name: 'populated scopes',
          scopes: new Map([['p1', { API_KEY: ['proj-1', 'proj-2'] }]]),
          expected: { API_KEY: ['proj-1', 'proj-2'] },
        },
      ])('returns env scopes for $name', async ({ scopes, expected }) => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.listEnvScopesByProviderIds.mockReturnValue(scopes);
        expect((await controller.getProvider('p1')).envScopes).toEqual(expected);
        expect(storage.listEnvScopesByProviderIds).toHaveBeenCalledWith(['p1']);
      });
    });

    describe('GET /api/providers (list)', () => {
      it('returns envScopes for each provider via a single batched read', async () => {
        storage.listProviders.mockResolvedValue({
          items: [
            { ...baseProvider, id: 'p1' },
            { ...baseProvider, id: 'p2', env: null },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });
        const scopesMap = new Map([['p1', { API_KEY: ['proj-1'] }]]);
        storage.listEnvScopesByProviderIds.mockReturnValue(scopesMap);

        const result = await controller.listProviders();

        expect(storage.listEnvScopesByProviderIds).toHaveBeenCalledWith(['p1', 'p2']);
        expect(storage.listEnvScopesByProviderIds).toHaveBeenCalledTimes(1);
        expect(result.items[0].envScopes).toEqual({ API_KEY: ['proj-1'] });
        expect(result.items[1].envScopes).toEqual({});
      });
    });

    describe('PUT /api/providers/:id with envScopes', () => {
      it('calls updateProviderWithScopes atomically when envScopes is present', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.updateProviderWithScopes.mockResolvedValue({ ...baseProvider });
        storage.getProject.mockResolvedValue({ id: 'proj-1', name: 'Project 1' });
        storage.listEnvScopesByProviderIds.mockReturnValue(
          new Map([['p1', { API_KEY: ['proj-1'] }]]),
        );

        await controller.updateProvider('p1', {
          envScopes: { API_KEY: ['proj-1'] },
        });

        expect(storage.updateProviderWithScopes).toHaveBeenCalledWith(
          'p1',
          expect.any(Object),
          { API_KEY: ['proj-1'] },
          ['API_KEY'],
        );
        expect(storage.updateProvider).not.toHaveBeenCalled();
      });

      it('envScopes: {} clears all scopes', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.updateProviderWithScopes.mockResolvedValue({ ...baseProvider });
        storage.listEnvScopesByProviderIds.mockReturnValue(new Map());

        await controller.updateProvider('p1', { envScopes: {} });

        expect(storage.updateProviderWithScopes).toHaveBeenCalledWith(
          'p1',
          expect.any(Object),
          {},
          ['API_KEY'],
        );
      });

      it('routes omitted envScopes through updateProviderWithScopes (preserves scope rows for current env keys)', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.updateProviderWithScopes.mockResolvedValue({ ...baseProvider });
        storage.listEnvScopesByProviderIds.mockReturnValue(
          new Map([['p1', { API_KEY: ['proj-1'] }]]),
        );

        await controller.updateProvider('p1', { binPath: '/new/claude' });

        expect(storage.updateProviderWithScopes).toHaveBeenCalledWith(
          'p1',
          expect.any(Object),
          undefined,
          ['API_KEY'],
        );
        expect(storage.updateProvider).not.toHaveBeenCalled();
      });

      it('routes omitted envScopes through updateProviderWithScopes (prunes scope rows for removed env key)', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.updateProviderWithScopes.mockResolvedValue({ ...baseProvider, env: null });
        storage.listEnvScopesByProviderIds.mockReturnValue(new Map());

        await controller.updateProvider('p1', { env: null });

        expect(storage.updateProviderWithScopes).toHaveBeenCalledWith(
          'p1',
          expect.any(Object),
          undefined,
          [],
        );
        expect(storage.updateProvider).not.toHaveBeenCalled();
      });

      it('rejects unknown env key in envScopes → 400 with field hint', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);

        await expect(
          controller.updateProvider('p1', {
            envScopes: { UNKNOWN_KEY: ['proj-1'] },
          }),
        ).rejects.toMatchObject({ details: { field: 'envScopes.UNKNOWN_KEY' } });

        expect(storage.updateProviderWithScopes).not.toHaveBeenCalled();
      });

      it('rejects unknown project ID in envScopes → 400 with field hint', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.getProject.mockRejectedValue(new NotFoundError('Project', 'no-such-project'));

        await expect(
          controller.updateProvider('p1', {
            envScopes: { API_KEY: ['no-such-project'] },
          }),
        ).rejects.toMatchObject({ details: { field: 'envScopes.API_KEY[0]' } });

        expect(storage.updateProviderWithScopes).not.toHaveBeenCalled();
      });

      it('rejects duplicate project IDs in envScopes array → 400 with field hint', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.getProject.mockResolvedValue({ id: 'proj-1', name: 'Project 1' });

        await expect(
          controller.updateProvider('p1', {
            envScopes: { API_KEY: ['proj-1', 'proj-1'] },
          }),
        ).rejects.toMatchObject({ details: { field: 'envScopes.API_KEY[1]' } });

        expect(storage.updateProviderWithScopes).not.toHaveBeenCalled();
      });

      it('accepts a project ID beyond the 100-item listProjects default page size', async () => {
        const beyondPageId = 'proj-101';
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.updateProviderWithScopes.mockResolvedValue({ ...baseProvider });
        storage.getProject.mockResolvedValue({ id: beyondPageId, name: 'Project 101' });
        storage.listEnvScopesByProviderIds.mockReturnValue(new Map());

        await controller.updateProvider('p1', {
          envScopes: { API_KEY: [beyondPageId] },
        });

        expect(storage.updateProviderWithScopes).toHaveBeenCalledWith(
          'p1',
          expect.any(Object),
          { API_KEY: [beyondPageId] },
          ['API_KEY'],
        );
      });

      it('uses post-update env keys for validation when env is also updated', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);
        storage.updateProviderWithScopes.mockResolvedValue({
          ...baseProvider,
          env: { NEW_KEY: 'val' },
        });
        storage.getProject.mockResolvedValue({ id: 'proj-1', name: 'Project 1' });
        storage.listEnvScopesByProviderIds.mockReturnValue(new Map());

        await controller.updateProvider('p1', {
          env: { NEW_KEY: 'val' },
          envScopes: { NEW_KEY: ['proj-1'] },
        });

        expect(storage.updateProviderWithScopes).toHaveBeenCalledWith(
          'p1',
          expect.objectContaining({ env: { NEW_KEY: 'val' } }),
          { NEW_KEY: ['proj-1'] },
          ['NEW_KEY'],
        );
      });

      it('rejects old env key in envScopes when env is updated to remove it', async () => {
        storage.getProvider.mockResolvedValue(baseProvider);

        await expect(
          controller.updateProvider('p1', {
            env: { NEW_KEY: 'val' },
            envScopes: { API_KEY: ['proj-1'] },
          }),
        ).rejects.toMatchObject({ details: { field: 'envScopes.API_KEY' } });
      });
    });
  });

  describe('rescanProviders', () => {
    it('returns discovery result with syncResults for each discovered provider', async () => {
      mockDiscoveryService.discoverInstalledBinaries.mockResolvedValue({
        discovered: [
          { name: 'claude', binPath: '/usr/bin/claude' },
          { name: 'codex', binPath: '/usr/bin/codex' },
        ],
        alreadyPresent: ['agy'],
        notFound: ['opencode'],
      });

      storage.createProvider
        .mockResolvedValueOnce({ id: 'new-1', name: 'claude' })
        .mockResolvedValueOnce({ id: 'new-2', name: 'codex' });

      const syncResult1 = {
        providerId: 'new-1',
        insertedCount: 2,
        affectedProjectIds: ['p1'],
        skippedExistingCount: 0,
        skippedConflictCount: 0,
        warnings: [],
        excludedAuthorCount: 0,
        scopeConfigHash: 'test',
      };
      const syncResult2 = {
        providerId: 'new-2',
        insertedCount: 1,
        affectedProjectIds: ['p1'],
        skippedExistingCount: 0,
        skippedConflictCount: 0,
        warnings: [],
        excludedAuthorCount: 0,
        scopeConfigHash: 'test',
      };
      mockSyncService.syncProviderToAllProjects
        .mockResolvedValueOnce(syncResult1)
        .mockResolvedValueOnce(syncResult2);

      const result = await controller.rescanProviders();

      expect(result.discovered).toHaveLength(2);
      expect(result.alreadyPresent).toEqual(['agy']);
      expect(result.notFound).toEqual(['opencode']);
      expect(result.syncResults).toEqual([syncResult1, syncResult2]);
      expect(storage.createProvider).toHaveBeenCalledTimes(2);
      expect(mockSyncService.syncProviderToAllProjects).toHaveBeenCalledWith('new-1');
      expect(mockSyncService.syncProviderToAllProjects).toHaveBeenCalledWith('new-2');
    });

    it('seeds the effort catalog for each rescan-discovered provider (same shared path)', async () => {
      mockDiscoveryService.discoverInstalledBinaries.mockResolvedValue({
        discovered: [
          { name: 'claude', binPath: '/usr/bin/claude' },
          { name: 'codex', binPath: '/usr/bin/codex' },
        ],
        alreadyPresent: [],
        notFound: [],
      });
      storage.createProvider
        .mockResolvedValueOnce({ id: 'new-1', name: 'claude' })
        .mockResolvedValueOnce({ id: 'new-2', name: 'codex' });

      await controller.rescanProviders();

      expect(mockEffortSeeding.seedForProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-1', name: 'claude' }),
      );
      expect(mockEffortSeeding.seedForProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-2', name: 'codex' }),
      );
    });

    it('still completes rescan when effort seeding throws (non-fatal)', async () => {
      mockDiscoveryService.discoverInstalledBinaries.mockResolvedValue({
        discovered: [{ name: 'claude', binPath: '/usr/bin/claude' }],
        alreadyPresent: [],
        notFound: [],
      });
      storage.createProvider.mockResolvedValueOnce({ id: 'new-1', name: 'claude' });
      mockEffortSeeding.seedForProvider.mockRejectedValueOnce(new Error('seed boom'));

      const result = await controller.rescanProviders();

      expect(result.discovered).toHaveLength(1);
      expect(mockSyncService.syncProviderToAllProjects).toHaveBeenCalledWith('new-1');
    });

    it('continues creating other providers when sync fails for one', async () => {
      mockDiscoveryService.discoverInstalledBinaries.mockResolvedValue({
        discovered: [
          { name: 'claude', binPath: '/usr/bin/claude' },
          { name: 'codex', binPath: '/usr/bin/codex' },
        ],
        alreadyPresent: [],
        notFound: [],
      });

      storage.createProvider
        .mockResolvedValueOnce({ id: 'new-1', name: 'claude' })
        .mockResolvedValueOnce({ id: 'new-2', name: 'codex' });

      const syncResult2 = {
        providerId: 'new-2',
        insertedCount: 1,
        affectedProjectIds: [],
        skippedExistingCount: 0,
        skippedConflictCount: 0,
        warnings: [],
        excludedAuthorCount: 0,
        scopeConfigHash: 'test',
      };
      mockSyncService.syncProviderToAllProjects
        .mockRejectedValueOnce(new Error('sync failed'))
        .mockResolvedValueOnce(syncResult2);

      const result = await controller.rescanProviders();

      expect(result.discovered).toHaveLength(2);
      expect(result.syncResults).toEqual([syncResult2]);
      expect(storage.createProvider).toHaveBeenCalledTimes(2);
    });
  });
});
