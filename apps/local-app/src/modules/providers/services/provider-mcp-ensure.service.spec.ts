import { Test, TestingModule } from '@nestjs/testing';
import { ProviderMcpEnsureService } from './provider-mcp-ensure.service';
import { McpProviderRegistrationService } from './mcp-provider-registration.service';
import { ProviderAdapterFactory } from '../adapters';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider } from '../../storage/models/domain.models';
import * as envConfig from '../../../common/config/env.config';

// Mock getEnvConfig for deterministic PORT
jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue({
  PORT: 3000,
  HOST: '127.0.0.1',
  DATABASE_PATH: ':memory:',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
});

describe('ProviderMcpEnsureService', () => {
  let service: ProviderMcpEnsureService;
  let mockStorage: jest.Mocked<Partial<StorageService>>;
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
  let mockGeminiTrustedFolders: {
    ensure: jest.Mock;
  };
  let mockClaudeEnsureProjectSettings: jest.Mock;

  const createProvider = (overrides: Partial<Provider> = {}): Provider => ({
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
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
          ['claude', 'codex', 'gemini', 'opencode'].includes(name),
        ),
      getAdapter: jest.fn().mockImplementation((name: string) => {
        if (name === 'opencode') {
          return { providerName: 'opencode', mcpMode: 'project_config' };
        }
        if (name === 'gemini') {
          return {
            providerName: 'gemini',
            mcpProjectRegistrationStrategy: 'upsert',
            requiresProjectProvisioning: true,
            provisionProjectPath: mockGeminiTrustedFolders.provisionProjectPath,
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

    mockGeminiTrustedFolders = {
      ensure: jest.fn().mockResolvedValue({ success: true, action: 'added', message: 'Added' }),
      provisionProjectPath: jest.fn().mockResolvedValue({ success: true, warnings: [] }),
    };

    mockClaudeEnsureProjectSettings = jest.fn().mockResolvedValue(undefined);

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

    it('returns fixed_mismatch when endpoint needs to be updated', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'fixed_mismatch',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      expect(result.action).toBe('fixed_mismatch');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: undefined },
      );
      expect(mockStorage.updateProviderMcpMetadata).toHaveBeenCalled();
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

    it('returns error when ensureRegistration fails with register error', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: false,
        action: 'error',
        message: 'Failed to register MCP: Registration failed',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('Failed to register MCP');
    });

    it('returns error when ensureRegistration fails with remove error during mismatch fix', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: false,
        action: 'error',
        message: 'Failed to remove existing MCP registration: Removal failed',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('Failed to remove existing MCP registration');
    });

    it('passes projectPath to ensureRegistration', async () => {
      const provider = createProvider();
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      await service.ensureMcp(provider, projectPath);

      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: projectPath },
      );
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

    it('catches and returns error when ensureRegistration throws with CLI crash', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockRejectedValue(new Error('CLI crashed'));

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('CLI crashed');
    });

    it('succeeds even when storage metadata update throws (best-effort)', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });
      mockStorage.updateProviderMcpMetadata!.mockRejectedValue(
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
    it('rejects relative project path', async () => {
      const provider = createProvider();

      const result = await service.ensureMcp(provider, 'relative/path');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Project path must be an absolute path');
      // Should not call ensureRegistration if validation fails
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
    });

    it('rejects path traversal attempt with ..', async () => {
      const provider = createProvider();

      // Path with traversal that normalizes to a non-registered path
      const result = await service.ensureMcp(provider, '/home/user/../../../etc/passwd');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      // After normalize(), '../../../' resolves and path becomes /etc/passwd
      // which is not a registered project
      expect(result.message).toBe('Project path is not a registered project');
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
    });

    it('rejects unregistered project path', async () => {
      const provider = createProvider();

      const result = await service.ensureMcp(provider, '/home/user/unknown-project');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Project path is not a registered project');
      expect(mockMcpRegistration.ensureRegistration).not.toHaveBeenCalled();
    });

    it('accepts registered project path', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(provider, '/home/user/project');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      // Validation passed, should call ensureRegistration
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/home/user/project' },
      );
    });

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

    it('rejects arbitrary filesystem path', async () => {
      const provider = createProvider();

      // Try to write to arbitrary location
      const result = await service.ensureMcp(provider, '/etc/passwd');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Project path is not a registered project');
    });

    it('rejects path with traversal that normalizes outside registered projects', async () => {
      const provider = createProvider();

      // Path that normalizes to /home/etc (outside registered projects)
      const result = await service.ensureMcp(provider, '/home/user/project/./../../etc');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      // After normalization, path becomes /home/etc which is not registered
      expect(result.message).toBe('Project path is not a registered project');
    });

    it('rejects path starting with traversal that normalizes outside projects', async () => {
      const provider = createProvider();

      // Path starting with /.. that normalizes to /etc/passwd
      const result = await service.ensureMcp(provider, '/../etc/passwd');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      // normalize('/../etc/passwd') = '/etc/passwd' which is not registered
      expect(result.message).toBe('Project path is not a registered project');
    });

    it('accepts path with ".." as part of segment name (not traversal)', async () => {
      const provider = createProvider();
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      // Path with ".." in segment name should NOT be rejected as path traversal
      const result = await service.ensureMcp(provider, '/home/user/my..project');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      // Should proceed to call ensureRegistration
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/home/user/my..project' },
      );
    });

    it('rejects actual traversal even when path contains ".." in other segments', async () => {
      const provider = createProvider();

      // Path with actual traversal segment (..) should still be rejected
      // even if other segments contain ".." as substring
      const result = await service.ensureMcp(
        provider,
        '/home/user/my..project/../../../etc/passwd',
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      // After normalize, this becomes /etc/passwd which is not registered
      expect(result.message).toBe('Project path is not a registered project');
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

    it('registers MCP via config file when not yet configured', async () => {
      const projectPath = '/home/user/project';
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(opencodeProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: projectPath },
      );
    });
  });

  describe('regression: no wildcard in generated endpoint URL', () => {
    it('with HOST=0.0.0.0: endpoint does not contain 0.0.0.0', async () => {
      jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue({
        PORT: 3000,
        HOST: '0.0.0.0',
        DATABASE_PATH: ':memory:',
        LOG_LEVEL: 'info',
        NODE_ENV: 'test',
      } as ReturnType<typeof envConfig.getEnvConfig>);

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
      jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue({
        PORT: 3000,
        HOST: '192.168.1.10',
        DATABASE_PATH: ':memory:',
        LOG_LEVEL: 'info',
        NODE_ENV: 'test',
      } as ReturnType<typeof envConfig.getEnvConfig>);

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

  describe('Gemini upsert routing and trust folders', () => {
    const geminiProvider = createProvider({ name: 'gemini', binPath: '/usr/local/bin/gemini' });
    const projectPath = '/home/user/project';

    it('Gemini with projectPath calls ensureRegistration correctly', async () => {
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        geminiProvider,
        expect.objectContaining({ alias: 'devchain' }),
        expect.objectContaining({ cwd: projectPath }),
      );
    });

    it('Gemini calls provisionProjectPath BEFORE ensureRegistration', async () => {
      const callOrder: string[] = [];
      mockGeminiTrustedFolders.provisionProjectPath.mockImplementation(async () => {
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

      await service.ensureMcp(geminiProvider, projectPath);

      expect(callOrder).toEqual(['provision', 'ensure']);
    });

    it('trust-folder distrusted_warning → ensure proceeds with warning', async () => {
      mockGeminiTrustedFolders.provisionProjectPath.mockResolvedValue({
        success: true,
        warnings: [
          {
            source: 'trusted_folders',
            level: 'warn',
            message: 'Path is distrusted',
            code: 'GEMINI_PATH_DISTRUSTED',
          },
        ],
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'trusted_folders', code: 'GEMINI_PATH_DISTRUSTED' }),
        ]),
      );
    });

    it('trust-folder malformed_warning → ensure proceeds with warning', async () => {
      mockGeminiTrustedFolders.provisionProjectPath.mockResolvedValue({
        success: true,
        warnings: [
          {
            source: 'trusted_folders',
            level: 'warn',
            message: 'File is malformed',
            code: 'GEMINI_TRUST_FILE_MALFORMED',
          },
        ],
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'trusted_folders',
            code: 'GEMINI_TRUST_FILE_MALFORMED',
          }),
        ]),
      );
    });

    it('trust-folder throws → ensure proceeds with GEMINI_TRUST_WRITE_FAILED warning', async () => {
      mockGeminiTrustedFolders.provisionProjectPath.mockResolvedValue({
        success: true,
        warnings: [
          {
            source: 'trusted_folders',
            level: 'warn',
            message: 'write failed',
            code: 'GEMINI_TRUST_WRITE_FAILED',
          },
        ],
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'trusted_folders', code: 'GEMINI_TRUST_WRITE_FAILED' }),
        ]),
      );
    });

    it('REGRESSION: user-scope devchain entry does not suppress project-scope registration', async () => {
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        geminiProvider,
        expect.objectContaining({ alias: 'devchain' }),
        expect.objectContaining({ cwd: projectPath }),
      );
    });
  });

  describe('Side-effect placement bug fix', () => {
    beforeEach(() => {
      jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue({
        PORT: 3000,
        HOST: '127.0.0.1',
        DATABASE_PATH: ':memory:',
        LOG_LEVEL: 'info',
        NODE_ENV: 'test',
      } as ReturnType<typeof envConfig.getEnvConfig>);
    });

    it('Claude project settings run even when MCP action is already_configured', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';

      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'already_configured',
      });

      const result = await service.ensureMcp(provider, projectPath);

      expect(result).toMatchObject({ success: true, action: 'already_configured' });
      expect(mockClaudeEnsureProjectSettings).toHaveBeenCalledWith(projectPath);
    });

    it('Codex calls ensureRegistration correctly', async () => {
      const provider = createProvider({ name: 'codex', binPath: '/usr/local/bin/codex' });
      const projectPath = '/home/user/project';

      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(mockMcpRegistration.ensureRegistration).toHaveBeenCalledWith(
        provider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: projectPath },
      );
    });
  });

  describe('R3: provisioning catch block visibility (Option B)', () => {
    const geminiProvider = createProvider({ name: 'gemini', binPath: '/usr/local/bin/gemini' });
    const projectPath = '/home/user/project';

    it('provisioning throws → result is still success with provisioning warning', async () => {
      mockGeminiTrustedFolders.provisionProjectPath.mockRejectedValue(
        new Error('Unexpected provisioning failure'),
      );
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

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
      // getAdapter is called 3 times for gemini+projectPath: isMcpCli check, settings check, provisioning check.
      // Only the 3rd call (inside the provisioning try block) should throw to test that specific path.
      let callCount = 0;
      mockAdapterFactory.getAdapter.mockImplementation((name: string) => {
        if (name === 'gemini') {
          callCount++;
          if (callCount === 3) throw new Error('Adapter lookup failed');
          return {
            providerName: 'gemini',
            mcpProjectRegistrationStrategy: 'upsert',
            requiresProjectProvisioning: true,
            provisionProjectPath: mockGeminiTrustedFolders.provisionProjectPath,
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

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'provisioning', level: 'warn' }),
        ]),
      );
    });

    it('provisioning throws non-Error → warning message is generic fallback', async () => {
      mockGeminiTrustedFolders.provisionProjectPath.mockRejectedValue('string error');
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'provisioning', message: 'Unknown error' }),
        ]),
      );
    });

    it('provisioning happy path → no provisioning warning in result', async () => {
      mockGeminiTrustedFolders.provisionProjectPath.mockResolvedValue({
        success: true,
        warnings: [],
      });
      mockMcpRegistration.ensureRegistration.mockResolvedValue({
        success: true,
        action: 'added',
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      const result = await service.ensureMcp(geminiProvider, projectPath);

      expect(result.success).toBe(true);
      const provisioningWarning = result.warnings?.find((w) => w.source === 'provisioning');
      expect(provisioningWarning).toBeUndefined();
    });
  });
});
