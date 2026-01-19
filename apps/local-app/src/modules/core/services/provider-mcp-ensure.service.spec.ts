import { Test, TestingModule } from '@nestjs/testing';
import { ProviderMcpEnsureService } from './provider-mcp-ensure.service';
import { PreflightService } from './preflight.service';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { ProviderAdapterFactory } from '../../providers/adapters';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider } from '../../storage/models/domain.models';
import * as envConfig from '../../../common/config/env.config';

// Mock getEnvConfig for deterministic PORT
jest.spyOn(envConfig, 'getEnvConfig').mockReturnValue({
  PORT: 3000,
  DATABASE_PATH: ':memory:',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
});

// Mock fs/promises
jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

import { mkdir, readFile, writeFile } from 'fs/promises';
const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;

describe('ProviderMcpEnsureService', () => {
  let service: ProviderMcpEnsureService;
  let mockStorage: jest.Mocked<Partial<StorageService>>;
  let mockMcpRegistration: {
    listRegistrations: jest.Mock;
    registerProvider: jest.Mock;
    removeRegistration: jest.Mock;
  };
  let mockAdapterFactory: {
    isSupported: jest.Mock;
  };
  let mockPreflight: {
    clearCache: jest.Mock;
  };

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
    };

    mockAdapterFactory = {
      isSupported: jest
        .fn()
        .mockImplementation((name: string) => ['claude', 'codex', 'gemini'].includes(name)),
    };

    mockPreflight = {
      clearCache: jest.fn(),
    };

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
          provide: PreflightService,
          useValue: mockPreflight,
        },
      ],
    }).compile();

    service = module.get<ProviderMcpEnsureService>(ProviderMcpEnsureService);

    // Reset mocks
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
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
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(mockStorage.updateProviderMcpMetadata).not.toHaveBeenCalled();
      expect(mockPreflight.clearCache).toHaveBeenCalled();
    });

    it('returns added when MCP is not registered', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(mockMcpRegistration.registerProvider).toHaveBeenCalledWith(
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
      expect(mockPreflight.clearCache).toHaveBeenCalled();
    });

    it('returns fixed_mismatch when endpoint needs to be updated', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:4000/mcp' }], // Wrong port
      });
      mockMcpRegistration.removeRegistration.mockResolvedValue({
        success: true,
        message: 'OK',
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(true);
      expect(result.action).toBe('fixed_mismatch');
      expect(mockMcpRegistration.removeRegistration).toHaveBeenCalledWith(provider, 'devchain', {
        cwd: undefined,
      });
      expect(mockMcpRegistration.registerProvider).toHaveBeenCalled();
      expect(mockStorage.updateProviderMcpMetadata).toHaveBeenCalled();
    });

    it('returns error when listRegistrations fails', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: false,
        message: 'Command failed',
        entries: [],
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('Failed to list MCP registrations');
    });

    it('returns error when registerProvider fails', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: false,
        message: 'Registration failed',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('Failed to register MCP');
    });

    it('returns error when removeRegistration fails during mismatch fix', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:4000/mcp' }],
      });
      mockMcpRegistration.removeRegistration.mockResolvedValue({
        success: false,
        message: 'Removal failed',
      });

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toContain('Failed to remove existing MCP registration');
    });

    it('passes projectPath to registration methods', async () => {
      const provider = createProvider();
      const projectPath = '/home/user/project';
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });

      await service.ensureMcp(provider, projectPath);

      expect(mockMcpRegistration.listRegistrations).toHaveBeenCalledWith(provider, {
        cwd: projectPath,
      });
      expect(mockMcpRegistration.registerProvider).toHaveBeenCalledWith(
        provider,
        expect.any(Object),
        { cwd: projectPath },
      );
    });

    it('updates Claude project settings for claude provider', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith('/home/user/project/.claude', { recursive: true });
      expect(mockWriteFile).toHaveBeenCalled();
      const writeCall = mockWriteFile.mock.calls[0];
      expect(writeCall[0]).toBe('/home/user/project/.claude/settings.local.json');
      const writtenContent = JSON.parse((writeCall[1] as string).trim());
      expect(writtenContent.permissions.allow).toContain('mcp__devchain');
    });

    it('does not update Claude settings when MCP already configured', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('does not fail if Claude settings update fails', async () => {
      const provider = createProvider({ name: 'claude' });
      const projectPath = '/home/user/project';
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      const result = await service.ensureMcp(provider, projectPath);

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
    });
  });

  describe('per-provider locking', () => {
    it('returns same promise for concurrent calls on same provider and project', async () => {
      const provider = createProvider();
      const projectPath = '/home/user/project';
      let listCallCount = 0;

      mockMcpRegistration.listRegistrations.mockImplementation(async () => {
        listCallCount++;
        // Simulate delay
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          message: 'OK',
          entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
        };
      });

      // Fire concurrent requests with same provider and project
      const [result1, result2] = await Promise.all([
        service.ensureMcp(provider, projectPath),
        service.ensureMcp(provider, projectPath),
      ]);

      // Both should return the same result
      expect(result1).toEqual(result2);
      // listRegistrations should only be called once due to locking
      expect(listCallCount).toBe(1);
    });

    it('allows concurrent calls for different providers', async () => {
      const provider1 = createProvider({ id: 'provider-1', name: 'claude' });
      const provider2 = createProvider({ id: 'provider-2', name: 'codex' });
      let listCallCount = 0;

      mockMcpRegistration.listRegistrations.mockImplementation(async () => {
        listCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          message: 'OK',
          entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
        };
      });

      await Promise.all([service.ensureMcp(provider1), service.ensureMcp(provider2)]);

      // Both providers should have their own call
      expect(listCallCount).toBe(2);
    });

    it('allows concurrent calls for same provider but different projects', async () => {
      const provider = createProvider();
      // Use registered project paths from mock storage
      const projectPath1 = '/home/user/project';
      const projectPath2 = '/home/user/another-project';
      let listCallCount = 0;

      mockMcpRegistration.listRegistrations.mockImplementation(async () => {
        listCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          message: 'OK',
          entries: [],
        };
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });

      await Promise.all([
        service.ensureMcp(provider, projectPath1),
        service.ensureMcp(provider, projectPath2),
      ]);

      // Both project-specific calls should execute
      expect(listCallCount).toBe(2);
      // Both should call registerProvider with their respective projectPath
      expect(mockMcpRegistration.registerProvider).toHaveBeenCalledWith(
        provider,
        expect.any(Object),
        { cwd: projectPath1 },
      );
      expect(mockMcpRegistration.registerProvider).toHaveBeenCalledWith(
        provider,
        expect.any(Object),
        { cwd: projectPath2 },
      );
    });

    it('treats undefined projectPath as "global" for lock key', async () => {
      const provider = createProvider();
      let listCallCount = 0;

      mockMcpRegistration.listRegistrations.mockImplementation(async () => {
        listCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return {
          success: true,
          message: 'OK',
          entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
        };
      });

      // Fire concurrent requests with undefined projectPath
      const [result1, result2] = await Promise.all([
        service.ensureMcp(provider),
        service.ensureMcp(provider, undefined),
      ]);

      // Both should return the same result (both map to 'global')
      expect(result1).toEqual(result2);
      expect(listCallCount).toBe(1);
    });
  });

  describe('exception handling', () => {
    it('catches and returns error when listRegistrations throws', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockRejectedValue(new Error('Network timeout'));

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Network timeout');
    });

    it('catches and returns error when registerProvider throws', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockRejectedValue(new Error('CLI crashed'));

      const result = await service.ensureMcp(provider);

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('CLI crashed');
    });

    it('succeeds even when storage metadata update throws (best-effort)', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
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
      mockMcpRegistration.listRegistrations.mockRejectedValue('string error');

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
      // Should not call listRegistrations if validation fails
      expect(mockMcpRegistration.listRegistrations).not.toHaveBeenCalled();
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
      expect(mockMcpRegistration.listRegistrations).not.toHaveBeenCalled();
    });

    it('rejects unregistered project path', async () => {
      const provider = createProvider();

      const result = await service.ensureMcp(provider, '/home/user/unknown-project');

      expect(result.success).toBe(false);
      expect(result.action).toBe('error');
      expect(result.message).toBe('Project path is not a registered project');
      expect(mockMcpRegistration.listRegistrations).not.toHaveBeenCalled();
    });

    it('accepts registered project path', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.ensureMcp(provider, '/home/user/project');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      // Validation passed, should call listRegistrations
      expect(mockMcpRegistration.listRegistrations).toHaveBeenCalledWith(provider, {
        cwd: '/home/user/project',
      });
    });

    it('validates against all registered projects', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });
      mockMcpRegistration.registerProvider.mockResolvedValue({
        success: true,
        message: 'OK',
      });

      // Use second registered project
      const result = await service.ensureMcp(provider, '/home/user/another-project');

      expect(result.success).toBe(true);
      expect(mockStorage.listProjects).toHaveBeenCalledWith({ limit: 1000 });
    });

    it('skips validation when projectPath is undefined', async () => {
      const provider = createProvider();
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
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
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      // Path with ".." in segment name should NOT be rejected as path traversal
      const result = await service.ensureMcp(provider, '/home/user/my..project');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      // Should proceed to call listRegistrations
      expect(mockMcpRegistration.listRegistrations).toHaveBeenCalledWith(provider, {
        cwd: '/home/user/my..project',
      });
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
});
