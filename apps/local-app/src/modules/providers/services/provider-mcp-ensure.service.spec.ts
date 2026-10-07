import { Test, TestingModule } from '@nestjs/testing';
import { ProviderMcpEnsureService } from './provider-mcp-ensure.service';
import { McpProviderRegistrationService } from './mcp-provider-registration.service';
import { ProviderAdapterFactory } from '../adapters';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { ProjectRemoteError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider } from '../../storage/models/domain.models';
import * as envConfig from '../../../common/config/env.config';

const baseEnv = envConfig.getEnvConfig();
const testEnv = (overrides: Partial<envConfig.EnvConfig> = {}): envConfig.EnvConfig => ({
  ...baseEnv,
  PORT: 3000,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
  ...overrides,
});

// Mock getEnvConfig for deterministic PORT
jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue(testEnv());

describe('ProviderMcpEnsureService', () => {
  let service: ProviderMcpEnsureService;
  let mockStorage: jest.Mocked<Pick<StorageService, 'updateProviderMcpMetadata' | 'listProjects'>>;
  let mockMcpRegistration: {
    listRegistrations: jest.Mock;
    registerProvider: jest.Mock;
    removeRegistration: jest.Mock;
    ensureRegistration: jest.Mock;
  };
  let mockAdapterFactory: {
    isSupported: jest.Mock;
    getAdapter: jest.Mock;
  };
  let mockTrustProvisioner: {
    ensure: jest.Mock;
    provisionProjectPath: jest.Mock;
  };
  let mockClaudeEnsureProjectSettings: jest.Mock;
  let mockAdmission: { getRemoteOwner: jest.Mock };

  const createProvider = (overrides: Partial<Provider> = {}): Provider => ({
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  });

  beforeEach(async () => {
    mockStorage = {
      updateProviderMcpMetadata: jest.fn().mockResolvedValue(undefined),
      listProjects: jest.fn().mockResolvedValue({
        items: [
          { id: 'project-1', name: 'Project 1', rootPath: '/home/user/project' },
          { id: 'project-2', name: 'Project 2', rootPath: '/home/user/another-project' },
          { id: 'project-3', name: 'My..Project', rootPath: '/home/user/my..project' },
        ],
        total: 3,
      }),
    };

    mockMcpRegistration = {
      listRegistrations: jest.fn(),
      registerProvider: jest.fn(),
      removeRegistration: jest.fn(),
      ensureRegistration: jest.fn(),
    };

    mockAdapterFactory = {
      isSupported: jest
        .fn()
        .mockImplementation((name: string) =>
          ['claude', 'codex', 'opencode', 'agy', 'copilot'].includes(name),
        ),
      getAdapter: jest.fn().mockImplementation((name: string) => {
        if (name === 'opencode') {
          return { providerName: 'opencode', mcpMode: 'project_config' };
        }
        if (name === 'agy') {
          // P2-1: agy is real-MCP (HOME-global config) + provisioning-capable.
          // No `mcpMode='project_config'` → isMcpCli=true → no projectPath required.
          return {
            providerName: 'agy',
            requiresProjectProvisioning: true,
            provisionProjectPath: mockTrustProvisioner.provisionProjectPath,
            parseGlobalMcpConfig: jest.fn().mockReturnValue([]),
            buildGlobalMcpServerEntry: jest.fn(),
          };
        }
        if (name === 'claude') {
          return {
            providerName: 'claude',
            ensureProjectSettings: mockClaudeEnsureProjectSettings,
          };
        }
        return { providerName: name };
      }),
    };

    mockTrustProvisioner = {
      ensure: jest.fn().mockResolvedValue({ success: true, action: 'added', message: 'Added' }),
      provisionProjectPath: jest.fn().mockResolvedValue({ success: true, warnings: [] }),
    };

    mockClaudeEnsureProjectSettings = jest.fn().mockResolvedValue(undefined);

    mockAdmission = { getRemoteOwner: jest.fn().mockReturnValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderMcpEnsureService,
        {
          provide: 'STORAGE_SERVICE',
          useValue: mockStorage,
        },
        {
          provide: McpProviderRegistrationService,
          useValue: mockMcpRegistration,
        },
        {
          provide: ProviderAdapterFactory,
          useValue: mockAdapterFactory,
        },
        {
          provide: ProjectWriteAdmissionService,
          useValue: mockAdmission,
        },
      ],
    }).compile();

    service = module.get<ProviderMcpEnsureService>(ProviderMcpEnsureService);

    // Reset mocks
    jest.clearAllMocks();
    mockClaudeEnsureProjectSettings.mockResolvedValue(undefined);
  });

  describe('ensureMcp', () => {
    it('returns error for unsupported provider', async () => {
      const provider = createProvider({ name: 'unknown-provider' });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('not supported');
    });

    it('runs trust provisioning AND registers agy MCP when a project path is given', async () => {
      const provider = createProvider({ name: 'agy' });
      const projectPath = '/home/user/project';
      const provisionProjectPath = jest.fn().mockResolvedValue({
        success: true,
        warnings: [{ source: 'trusted_workspaces', level: 'warn', message: 'heads up' }],
      });
      mockAdapterFactory.getAdapter.mockImplementation((name: string) => {
        if (name === 'agy') {
          return {
            providerName: 'agy',
            requiresProjectProvisioning: true,
            provisionProjectPath,
            parseGlobalMcpConfig: jest.fn().mockReturnValue([]),
            buildGlobalMcpServerEntry: jest.fn(),
          };
        }
        return { providerName: name };
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(provider, projectPath);

      // Trust provisioning ran AND surfaced its warnings...
      expect(provisionProjectPath).toHaveBeenCalledWith(projectPath);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'heads up' })]),
      );
      // ...and MCP registration now runs (no longer deferred).
      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalled();
      expect(mockStorage.updateProviderMcpMetadata).toHaveBeenCalled();
    });

    it('returns already_configured when MCP is correctly set up', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(mockStorage.updateProviderMcpMetadata).not.toHaveBeenCalled();
    });

    it('returns added when MCP is not registered', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: undefined },
      );
      expect(mockStorage.updateProviderMcpMetadata).toHaveBeenCalledWith(
        provider.id,
        expect.objectContaining({
          mcpConfigured: true,
          mcpEndpoint: 'http://127.0.0.1:3000/mcp',
        }),
      );
    });

    it('returns error when ensureRegistration fails with list error', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: false,
        action: 'error',
        message: 'Failed to list MCP registrations: Command failed',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('Failed to list MCP registrations');
    });

    it('calls ensureProjectSettings on capable adapter for claude provider', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(mockClaudeEnsureProjectSettings).toHaveBeenCalledWith(projectPath);
    });

    it('still calls ensureProjectSettings when MCP already configured (placement fix)', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(mockClaudeEnsureProjectSettings).toHaveBeenCalledWith(projectPath);
    });

    it('does not fail if ensureProjectSettings throws (non-fatal)', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });
      mockClaudeEnsureProjectSettings.mockRejectedValue(new Error('Permission denied'));

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
    });

    it('does not call ensureProjectSettings for non-capable adapter (codex)', async () => {
      const provider = createProvider({ name: 'codex' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(mockClaudeEnsureProjectSettings).not.toHaveBeenCalled();
    });
  });

  describe('per-provider locking', () => {
    it('returns same promise for concurrent calls on same provider and project', async () => {
      const provider = createProvider();
      const projectPath = '/home/user/project';
      let ensureCallCount = 0;

      mockMcpRegistration.ensureRegistration.mockImplementation(async () => {
        ensureCallCount++;
        // Simulate delay
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          action: 'already_configured',
        };
      });

      // Fire concurrent requests with same provider and project
      const [result1, result2] = await Promise.all([
        service.ensureMcp(provider, projectPath),
        service.ensureMcp(provider, projectPath),
      ]);

      // Both should return the same result
      expect(result1).toEqual(result2);
      // ensureRegistration should only be called once due to locking
      expect(ensureCallCount).toBe(1);
    });

    it('allows concurrent calls for different providers', async () => {
      const provider1 = createProvider({ id: 'provider-1', name: 'claude' });
      const provider2 = createProvider({ id: 'provider-2', name: 'codex' });
      let ensureCallCount = 0;

      mockMcpRegistration.ensureRegistration.mockImplementation(async () => {
        ensureCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          action: 'already_configured',
        };
      });

      await Promise.all([service.ensureMcp(provider1), service.ensureMcp(provider2)]);

      // Both providers should have their own call
      expect(ensureCallCount).toBe(2);
    });

    it('allows concurrent calls for same provider but different projects', async () => {
      const provider = createProvider();
      // Use registered project paths from mock storage
      const projectPath1 = '/home/user/project';
      const projectPath2 = '/home/user/another-project';
      let ensureCallCount = 0;

      mockMcpRegistration.ensureRegistration.mockImplementation(async () => {
        ensureCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          action: 'added',
          endpoint: 'http://127.0.0.1:3000/mcp',
          alias: 'devchain',
        };
      });

      await Promise.all([
        service.ensureMcp(provider, projectPath1),
        service.ensureMcp(provider, projectPath2),
      ]);

      // Both project-specific calls should execute
      expect(ensureCallCount).toBe(2);
      // Both should call ensureRegistration with their respective projectPath
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: projectPath1 },
      );
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: projectPath2 },
      );
    });

    it('treats undefined projectPath as "global" for lock key', async () => {
      const provider = createProvider();
      let ensureCallCount = 0;

      mockMcpRegistration.ensureRegistration.mockImplementation(async () => {
        ensureCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          action: 'already_configured',
        };
      });

      // Fire concurrent requests with undefined projectPath
      const [result1, result2] = await Promise.all([
        service.ensureMcp(provider),
        service.ensureMcp(provider, undefined),
      ]);

      // Both should return the same result (both map to 'global')
      expect(result1).toEqual(result2);
      expect(ensureCallCount).toBe(1);
    });
  });

  describe('exception handling', () => {
    it('catches and returns error when ensureRegistration throws', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockRejectedValue(new Error('Network timeout'));

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Network timeout');
    });

    it('succeeds even when storage metadata update throws (best-effort)', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });
      mockStorage.updateProviderMcpMetadata.mockRejectedValue(
        new Error('Database connection lost'),
      );

      const result = await service.ensureMcp(provider);

      // MCP registration succeeded, so operation succeeds despite metadata update failure
      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      // Storage update was still attempted
      expect(mockStorage.updateProviderMcpMetadata).toHaveBeenCalled();
    });

    it('handles non-Error exceptions gracefully', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockRejectedValue('string error');

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Unknown error during MCP ensure');
    });
  });

  describe('projectPath validation', () => {
    it.each([
      {
        name: 'rejects relative project path',
        path: 'relative/path',
        message: 'Project path must be an absolute path',
      },
      {
        name: 'rejects path traversal attempt with ..',
        path: '/home/user/../../../etc/passwd',
        message: 'Project path cannot contain path traversal sequences',
      },
      {
        name: 'rejects unregistered project path',
        path: '/home/user/unknown-project',
        message: 'Project path is not a registered project',
      },
      {
        name: 'rejects arbitrary filesystem path',
        path: '/etc/passwd',
        message: 'Project path is not a registered project',
      },
      {
        name: 'rejects path with traversal that normalizes outside registered projects',
        path: '/home/user/project/./../../etc',
        message: 'Project path cannot contain path traversal sequences',
      },
      {
        name: 'rejects path starting with traversal that normalizes outside projects',
        path: '/../etc/passwd',
        message: 'Project path cannot contain path traversal sequences',
      },
      {
        name: 'rejects actual traversal even when path contains ".." in other segments',
        path: '/home/user/my..project/../../../etc/passwd',
        message: 'Project path cannot contain path traversal sequences',
      },
      {
        name: 'REGRESSION: rejects traversal that normalizes back onto a registered root',
        path: '/home/user/project/../project',
        message: 'Project path cannot contain path traversal sequences',
      },
    ])('$name', async ({ path, message }) => {
      const result = await service.ensureMcp(createProvider(), path);
      expect(result).toMatchObject({ success: false, action: 'error', message });
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
    });

    it.each(['/home/user/project', '/home/user/my..project'])(
      'accepts registered path %s',
      async (path) => {
        const provider = createProvider();
        mockMcpRegistration.ensureRegistration.mockResolvedValue({
          success: true,
          action: 'already_configured',
        });
        expect(await service.ensureMcp(provider, path)).toMatchObject({
          success: true,
          action: 'already_configured',
        });
        expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
          provider,
          { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
          { cwd: path },
        );
      },
    );

    it('validates against all registered projects', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      // Use second registered project
      const result = await service.ensureMcp(provider, '/home/user/another-project');

      expect(result.success).toBe(true);
      expect(mockStorage.listProjects).toHaveBeenCalledWith({ limit: 1000 });
    });

    it('skips validation when projectPath is undefined', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      // Should not call listProjects when no projectPath
      expect(mockStorage.listProjects).not.toHaveBeenCalled();
    });
  });

  describe('config-file provider (opencode)', () => {
    const opencodeProvider = createProvider({ id: 'provider-oc', name: 'opencode' });

    it('returns error when opencode has no projectPath', async () => {
      const result = await service.ensureMcp(opencodeProvider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('requires a project path');
      expect(result.message).toContain('opencode');
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
    });

    it('delegates to registration service when projectPath is provided', async () => {
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(opencodeProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: projectPath },
      );
    });
  });

  describe('regression: no wildcard in generated endpoint URL', () => {
    it('with HOST=0.0.0.0: endpoint does not contain 0.0.0.0', async () => {
      jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue(testEnv({ HOST: '0.0.0.0' }));

      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      await service.ensureMcp(provider);

      const registeredEndpoint = mockMcpRegistration.ensureRegistration.mock.calls[0][1].endpoint;
      expect(registeredEndpoint).not.toContain('0.0.0.0');
      expect(registeredEndpoint).toBe('http://127.0.0.1:3000/mcp');
    });

    it('with HOST=192.168.1.10: endpoint uses concrete host', async () => {
      jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue(testEnv({ HOST: '192.168.1.10' }));

      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://192.168.1.10:3000/mcp',
        alias: 'devchain',
      });

      await service.ensureMcp(provider);

      const registeredEndpoint = mockMcpRegistration.ensureRegistration.mock.calls[0][1].endpoint;
      expect(registeredEndpoint).toBe('http://192.168.1.10:3000/mcp');
    });
  });

  describe('agy provisioning and trust folders', () => {
    const agyProvider = createProvider({ name: 'agy', binPath: '/usr/local/bin/agy' });
    const projectPath = '/home/user/project';

    it('agy with projectPath calls ensureRegistration correctly', async () => {
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(agyProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        agyProvider,
        expect.objectContaining({ alias: 'devchain' }),
        expect.objectContaining({ cwd: projectPath }),
      );
    });

    it('agy calls provisionProjectPath BEFORE ensureRegistration', async () => {
      const callOrder: string[] = [];
      mockTrustProvisioner.provisionProjectPath.mockImplementation(async () => {
        callOrder.push('provision');
        return { success: true, warnings: [] };
      });
      mockMcpRegistration.ensureRegistration.mockImplementation(async () => {
        callOrder.push('ensure');
        return {
          success: true,
          action: 'added',
          endpoint: 'http://127.0.0.1:3000/mcp',
          alias: 'devchain',
        };
      });

      await service.ensureMcp(agyProvider, projectPath);

      expect(callOrder).toEqual(['provision', 'ensure']);
    });

    it('passes the provisioning environment through the full MCP ensure path', async () => {
      const context = { env: { CODEX_HOME: '/custom/codex-home' } };
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      await service.ensureMcp(agyProvider, projectPath, context);

      expect(mockTrustProvisioner.provisionProjectPath).toHaveBeenCalledWith(projectPath, context);
    });
  });

  describe('R3: provisioning catch block visibility (Option B)', () => {
    const agyProvider = createProvider({ name: 'agy', binPath: '/usr/local/bin/agy' });
    const projectPath = '/home/user/project';

    it('provisioning throws → result is still success with provisioning warning', async () => {
      mockTrustProvisioner.provisionProjectPath.mockRejectedValue(
        new Error('Unexpected provisioning failure'),
      );
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(agyProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'provisioning',
            level: 'warn',
            message: 'Unexpected provisioning failure',
          }),
        ]),
      );
    });

    it('adapter lookup throws inside provisioning block → result is still success with provisioning warning', async () => {
      // getAdapter is called 3 times for agy+projectPath: isMcpCli check, settings check, provisioning check.
      // Only the 3rd call (inside the provisioning try block) should throw to test that specific path.
      // (The mcp-deferred skip reuses the already-fetched adapter, so it adds no extra getAdapter call.)
      let callCount = 0;
      mockAdapterFactory.getAdapter.mockImplementation((name: string) => {
        if (name === 'agy') {
          callCount++;
          if (callCount === 3) throw new Error('Adapter lookup failed');
          return {
            providerName: 'agy',
            requiresProjectProvisioning: true,
            provisionProjectPath: mockTrustProvisioner.provisionProjectPath,
          };
        }
        if (name === 'opencode') return { providerName: 'opencode', mcpMode: 'project_config' };
        if (name === 'claude')
          return { providerName: 'claude', ensureProjectSettings: mockClaudeEnsureProjectSettings };
        return { providerName: name };
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(agyProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'provisioning', level: 'warn' }),
        ]),
      );
    });

    it('provisioning throws non-Error → warning message is generic fallback', async () => {
      mockTrustProvisioner.provisionProjectPath.mockRejectedValue('string error');
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(agyProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'provisioning', message: 'Unknown error' }),
        ]),
      );
    });

    it('provisioning happy path → no provisioning warning in result', async () => {
      mockTrustProvisioner.provisionProjectPath.mockResolvedValue({
        success: true,
        warnings: [],
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(agyProvider, projectPath);

      expect(result.success).toBe(true);
      const provisioningWarning = result.warnings?.find((w) => w.source === 'provisioning');
      expect(provisioningWarning).toBeUndefined();
    });
  });

  describe('ensureProjectProvisioning (trust-only)', () => {
    const claudeProvider = createProvider({ name: 'claude' });
    const projectPath = '/home/user/project';
    let claudeProvisionProjectPath: jest.Mock;

    beforeEach(() => {
      claudeProvisionProjectPath = jest.fn().mockResolvedValue({ success: true, warnings: [] });
      mockAdapterFactory.getAdapter.mockImplementation((name: string) => {
        if (name === 'claude') {
          return {
            providerName: 'claude',
            ensureProjectSettings: mockClaudeEnsureProjectSettings,
            requiresProjectProvisioning: true,
            provisionProjectPath: claudeProvisionProjectPath,
          };
        }
        if (name === 'opencode') {
          return { providerName: 'opencode', mcpMode: 'project_config' };
        }
        return { providerName: name };
      });
    });

    it('delegates to provisionProjectPath for a validated registered root', async () => {
      const context = { env: { CODEX_HOME: '/custom/codex-home' } };
      const result = await service.ensureProjectProvisioning(claudeProvider, projectPath, context);

      expect(result).toEqual({ success: true, warnings: [] });
      expect(claudeProvisionProjectPath).toHaveBeenCalledWith(projectPath, context);
    });

    it('performs zero MCP registration calls and no project-local settings writes', async () => {
      await service.ensureProjectProvisioning(claudeProvider, projectPath);

      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
      expect(mockMcpRegistration.listRegistrations).not.toHaveBeenCalled();
      expect(mockMcpRegistration.registerProvider).not.toHaveBeenCalled();
      expect(mockMcpRegistration.removeRegistration).not.toHaveBeenCalled();
      expect(mockClaudeEnsureProjectSettings).not.toHaveBeenCalled();
    });

    it('maps adapter provisioning warnings through', async () => {
      claudeProvisionProjectPath.mockResolvedValue({
        success: false,
        warnings: [
          {
            source: 'claude_project_trust',
            level: 'warn',
            message: 'malformed config',
            code: 'CLAUDE_TRUST_PROVISION_FAILED',
          },
        ],
      });

      const result = await service.ensureProjectProvisioning(claudeProvider, projectPath);

      expect(result.success).toBe(false);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'CLAUDE_TRUST_PROVISION_FAILED' }),
      ]);
    });

    it.each(['/home/user/unknown-project', 'relative/path', '/home/user/project/../project'])(
      'refuses provisioning path %s before reaching adapters',
      async (path) => {
        const result = await service.ensureProjectProvisioning(claudeProvider, path);
        expect(result.success).toBe(false);
        expect(result.warnings).toEqual([
          expect.objectContaining({ code: 'PROVISIONING_PATH_INVALID' }),
        ]);
        expect(claudeProvisionProjectPath).not.toHaveBeenCalled();
        expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
      },
    );

    it('still accepts segment names containing ".." as a substring (not traversal)', async () => {
      // Registered root '/home/user/my..project' with '..' inside the name —
      // the segment-exact raw check must not reject it.
      const result = await service.ensureProjectProvisioning(
        claudeProvider,
        '/home/user/my..project',
      );

      expect(result).toEqual({ success: true, warnings: [] });
      expect(claudeProvisionProjectPath).toHaveBeenCalledWith('/home/user/my..project');
    });

    it('returns a fixed-code warning for unsupported providers', async () => {
      const result = await service.ensureProjectProvisioning(
        createProvider({ name: 'unknown-provider' }),
        projectPath,
      );

      expect(result.success).toBe(false);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'PROVISIONING_UNSUPPORTED' }),
      ]);
    });

    it('a provisioning throw stays non-fatal with a fixed-code warning', async () => {
      claudeProvisionProjectPath.mockRejectedValue(new Error('disk on fire'));

      const result = await service.ensureProjectProvisioning(claudeProvider, projectPath);

      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'PROVISIONING_FAILED', message: 'disk on fire' }),
      ]);
    });

    it('is a no-op success for a non-provisioning adapter', async () => {
      const result = await service.ensureProjectProvisioning(
        createProvider({ name: 'codex' }),
        projectPath,
      );

      expect(result).toEqual({ success: true, warnings: [] });
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
    });
  });

  describe('remote-owned project skip', () => {
    const remoteOwner = {
      projectId: 'project-1',
      remoteId: 'remote-9',
      remoteName: 'vm-01',
      state: 'remote' as const,
    };

    beforeEach(() => {
      mockAdmission.getRemoteOwner.mockReturnValue(remoteOwner);
    });

    afterEach(() => {
      mockAdmission.getRemoteOwner.mockReturnValue(null);
    });

    it('ensureMcp skips a remote-owned project without registering', async () => {
      const provider = createProvider({ name: 'claude' });

      const result = await service.ensureMcp(provider, '/home/user/project');

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
      expect(result.message).toContain('vm-01');
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
      expect(mockClaudeEnsureProjectSettings).not.toHaveBeenCalled();
    });

    it('ensureMcp still registers for a home-owned project', async () => {
      mockAdmission.getRemoteOwner.mockReturnValue(null);
      const provider = createProvider({ name: 'claude' });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
      });

      const result = await service.ensureMcp(provider, '/home/user/project');

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        expect.anything(),
        expect.objectContaining({ cwd: '/home/user/project' }),
      );
    });

    it('ensureProjectProvisioning skips a remote-owned project', async () => {
      const provider = createProvider({ name: 'agy' });

      const result = await service.ensureProjectProvisioning(provider, '/home/user/project');

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'PROVISIONING_REMOTE_OWNED' }),
      ]);
    });

    it('assertPathNotRemoteOwned throws ProjectRemoteError for a remote-owned path', async () => {
      await expect(service.assertPathNotRemoteOwned('/home/user/project')).rejects.toBeInstanceOf(
        ProjectRemoteError,
      );
    });

    it('assertPathNotRemoteOwned accepts a home-owned path', async () => {
      mockAdmission.getRemoteOwner.mockReturnValue(null);

      await expect(service.assertPathNotRemoteOwned('/home/user/project')).resolves.toBeUndefined();
    });

    it('assertPathNotRemoteOwned rejects an unregistered path', async () => {
      mockAdmission.getRemoteOwner.mockReturnValue(null);

      await expect(service.assertPathNotRemoteOwned('/nowhere/at/all')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });
});
