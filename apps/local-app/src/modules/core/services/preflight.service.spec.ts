import { Test, TestingModule } from '@nestjs/testing';
import { PreflightService } from './preflight.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { access } from 'fs/promises';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { ProviderAdapterFactory } from '../../providers/adapters';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

// Mock dependencies with custom promisify support
jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { promisify } = require('util');
  const mockExecFn = jest.fn();
  const mockExecFileFn = jest.fn();

  // Use 'any' for custom promisify symbol property to avoid symbol index conflicts
  type MockExecFn = jest.Mock & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: symbol]: any;
  };

  type MockExecFileFn = jest.Mock & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: symbol]: any;
  };

  // Add custom promisify support to make promisify(exec) return {stdout, stderr}
  (mockExecFn as MockExecFn)[promisify.custom] = (
    cmd: string,
    options?: Record<string, unknown>,
  ) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFn(cmd, options, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };

  // Add custom promisify support for execFile as well
  (mockExecFileFn as MockExecFileFn)[promisify.custom] = (
    file: string,
    args?: string[],
    options?: Record<string, unknown>,
  ) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFileFn(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };

  return {
    exec: mockExecFn,
    execFile: mockExecFileFn,
  };
});
jest.mock('fs/promises');

import { exec } from 'child_process';
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockAccess = access as jest.MockedFunction<typeof access>;

describe('PreflightService', () => {
  const originalEnabledProviders = process.env.ENABLED_PROVIDERS;

  let service: PreflightService;
  let mockStorage: jest.Mocked<StorageService>;
  let mockMcpRegistration: {
    resolveBinary: jest.Mock;
    listRegistrations: jest.Mock;
  };
  let mockAdapterFactory: {
    isSupported: jest.Mock;
    getSupportedProviders: jest.Mock;
    getAdapter: jest.Mock;
  };

  beforeEach(async () => {
    delete process.env.ENABLED_PROVIDERS;

    // Create mock storage service (partial mock - only methods needed for PreflightService)
    mockStorage = {
      listProviders: jest.fn(),
      getProvider: jest.fn(),
      createProvider: jest.fn(),
      updateProvider: jest.fn(),
      deleteProvider: jest.fn(),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 0, offset: 0 }),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      getAgentProfile: jest.fn(),
      getProfileProviderConfig: jest.fn(),
      listAllProfileProviderConfigs: jest.fn().mockResolvedValue([]),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      listProfileProviderConfigsByIds: jest.fn().mockResolvedValue([]),
      listProvidersByIds: jest.fn().mockResolvedValue([]),
      findProjectByPath: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    mockMcpRegistration = {
      resolveBinary: jest.fn(),
      listRegistrations: jest.fn(),
    };

    mockAdapterFactory = {
      isSupported: jest
        .fn()
        .mockImplementation((name: string) =>
          ['claude', 'codex', 'gemini', 'opencode'].includes(name),
        ),
      getSupportedProviders: jest.fn().mockReturnValue(['claude', 'codex', 'gemini', 'opencode']),
      getAdapter: jest.fn().mockImplementation((name: string) => {
        if (name === 'opencode') {
          return { providerName: 'opencode', mcpMode: 'project_config' };
        }
        return { providerName: name };
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreflightService,
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

    service = module.get<PreflightService>(PreflightService);

    mockMcpRegistration.resolveBinary.mockResolvedValue({
      success: false,
      message: 'not found',
    });
    mockMcpRegistration.listRegistrations.mockResolvedValue({
      success: true,
      message: 'OK',
      entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
    });
  });

  afterEach(() => {
    delete process.env.ENABLED_PROVIDERS;
    jest.clearAllMocks();
    jest.resetAllMocks();
    mockMcpRegistration.resolveBinary.mockReset();
    mockMcpRegistration.listRegistrations.mockReset();
  });

  afterAll(() => {
    if (originalEnabledProviders === undefined) {
      delete process.env.ENABLED_PROVIDERS;
      return;
    }
    process.env.ENABLED_PROVIDERS = originalEnabledProviders;
  });

  describe('runChecks', () => {
    it('should validate tmux and all configured providers', async () => {
      // Mock tmux check
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2a', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      // Mock providers from storage
      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:4000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'p2',
            name: 'codex',
            binPath: null,
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:5000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      // Mock provider binary checks
      mockAccess.mockResolvedValueOnce(undefined); // claude binPath exists
      mockMcpRegistration.resolveBinary.mockResolvedValueOnce({
        success: true,
        binaryPath: '/usr/bin/codex',
        source: 'which',
      });
      mockMcpRegistration.listRegistrations
        .mockResolvedValueOnce({
          success: true,
          message: 'OK',
          entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
        })
        .mockResolvedValueOnce({
          success: true,
          message: 'OK',
          entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (callback) {
            if (cmd === 'tmux -V') {
              callback(null, 'tmux 3.2a', '');
            } else if (cmd === 'which codex') {
              callback(null, '/usr/bin/codex', '');
            }
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      const result = await service.runChecks();

      expect(result.overall).toBe('pass');
      expect(result.checks).toHaveLength(1); // tmux check
      expect(result.providers).toHaveLength(2); // 2 providers
      expect(result.checks[0].name).toBe('tmux');
      expect(result.checks[0].status).toBe('pass');
      expect(result.providers[0].name).toBe('claude');
      expect(result.providers[0].status).toBe('pass');
      expect(result.providers[0].mcpStatus).toBe('pass');
      expect(result.providers[1].name).toBe('codex');
      expect(result.providers[1].status).toBe('pass');
      expect(result.providers[1].binPath).toBe('/usr/bin/codex');
    });

    it('should return fail status when provider binPath is not executable', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/invalid/path/claude',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:4000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      // Mock access to fail (binPath not accessible)
      mockAccess.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks();

      expect(result.overall).toBe('fail');
      expect(result.providers[0].status).toBe('fail');
      expect(result.providers[0].message).toContain('not accessible');
    });

    it('should return warn status when provider not found in PATH', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (callback) {
            if (cmd === 'tmux -V') {
              callback(null, 'tmux 3.2', '');
            } else if (cmd === 'which newprovider') {
              callback(new Error('not found'), '', '');
            }
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'newprovider',
            binPath: null,
            mcpConfigured: false,
            mcpEndpoint: null,
            mcpRegisteredAt: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockMcpRegistration.resolveBinary.mockResolvedValue({
        success: false,
        message: 'not found',
      });
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [],
      });

      const result = await service.runChecks();

      expect(result.overall).toBe('warn');
      expect(result.providers[0].status).toBe('warn');
      expect(result.providers[0].message).toContain('binary not configured');
    });

    it('should handle storage service errors gracefully', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockRejectedValue(new Error('Database error'));

      const result = await service.runChecks();

      expect(result.overall).toBe('warn');
      expect(result.checks.some((c) => c.name === 'providers' && c.status === 'warn')).toBe(true);
      expect(result.providers).toHaveLength(0);
    });

    it('filters provider checks using ENABLED_PROVIDERS when set', async () => {
      process.env.ENABLED_PROVIDERS = 'claude';

      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2a', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:4000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'p2',
            name: 'codex',
            binPath: '/usr/local/bin/codex',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:5000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks();

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('claude');
      expect(mockMcpRegistration.listRegistrations).toHaveBeenCalledTimes(1);
    });

    it('gracefully skips provider checks when ENABLED_PROVIDERS is empty', async () => {
      process.env.ENABLED_PROVIDERS = '';

      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:4000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.runChecks();

      expect(result.overall).toBe('pass');
      expect(result.providers).toHaveLength(0);
      expect(mockMcpRegistration.listRegistrations).not.toHaveBeenCalled();
    });
  });

  describe('MCP list detection', () => {
    it('sets mcpStatus warn when list does not include devchain alias', async () => {
      // tmux ok
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:4000',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockAccess.mockResolvedValueOnce(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'something-else', endpoint: 'http://localhost:4000/mcp' }],
      });

      const result = await service.runChecks();
      expect(result.providers[0].mcpStatus).toBe('warn');
      expect(result.providers[0].mcpMessage).toContain('devchain');
      expect(result.providers[0].mcpMessage).toContain('not found');
    });

    it('sets mcpStatus warn when devchain exists but endpoint mismatches', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: true,
            mcpEndpoint: 'http://127.0.0.1:3000/mcp',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockAccess.mockResolvedValueOnce(undefined);
      // devchain exists but with wrong endpoint
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:4000/mcp' }],
      });

      const result = await service.runChecks();
      expect(result.providers[0].mcpStatus).toBe('warn');
      expect(result.providers[0].mcpMessage).toContain('mismatch');
      expect(result.providers[0].mcpDetails).toContain('Expected: http://127.0.0.1:3000/mcp');
      expect(result.providers[0].mcpDetails).toContain('Found: http://127.0.0.1:4000/mcp');
    });

    it('sets mcpStatus fail when list command fails', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'codex',
            binPath: '/usr/local/bin/codex',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:3000/mcp',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockAccess.mockResolvedValueOnce(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: false,
        message: 'MCP command exited with code 2.',
        entries: [],
      });

      const result = await service.runChecks();
      expect(result.providers[0].mcpStatus).toBe('fail');
    });

    it('sets mcpStatus fail when list times out', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );

      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'codex',
            binPath: '/usr/local/bin/codex',
            mcpConfigured: true,
            mcpEndpoint: 'ws://localhost:3000/mcp',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockAccess.mockResolvedValueOnce(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: false,
        message: 'MCP check timed out after 10000ms',
        stdout: '',
        stderr: '',
        exitCode: null,
      });

      const result = await service.runChecks();
      expect(result.providers[0].mcpStatus).toBe('fail');
      expect(result.providers[0].mcpMessage).toContain('timed out');
    });
  });

  describe('clearCache', () => {
    it('should be a no-op (cache removed)', () => {
      // clearCache is kept for backward compatibility but is now a no-op
      service.clearCache('/test/project');
      service.clearCache();
      // No errors should be thrown
      expect(true).toBe(true);
    });
  });

  describe('config-based validation', () => {
    const mockProvider = {
      id: 'p1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: 'http://127.0.0.1:3000/mcp',
      mcpRegisteredAt: '2024-01-01',
      createdAt: '',
      updatedAt: '',
    };

    // mockProfile commented out - currently unused in this test
    // const mockProfile = {
    //   id: 'profile-1',
    //   projectId: 'project-1',
    //   name: 'Test Profile',
    //   // Note: providerId and options removed in Phase 4
    //   familySlug: null,
    //   systemPrompt: null,
    //   instructions: null,
    //   temperature: null,
    //   maxTokens: null,
    //   createdAt: '',
    //   updatedAt: '',
    // };

    const mockAgent = {
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      name: 'Test Agent',
      description: null,
      createdAt: '',
      updatedAt: '',
    };

    const mockConfig = {
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'p1',
      options: '--model opus',
      env: { API_KEY: 'test-key' },
      createdAt: '',
      updatedAt: '',
    };

    beforeEach(() => {
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );
    });

    it('validates providers from agent configs when project path is provided', async () => {
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      // Use batch methods instead of single-item fetches
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([mockConfig]);
      mockStorage.listProvidersByIds.mockResolvedValue([mockProvider]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      expect(mockStorage.listAgents).toHaveBeenCalledWith('project-1');
      expect(mockStorage.listProfileProviderConfigsByIds).toHaveBeenCalledWith(['config-1']);
      expect(mockStorage.listProvidersByIds).toHaveBeenCalledWith(['p1']);
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].usedByAgents).toContain('Test Agent');
    });

    it('skips agents without providerConfigId (Phase 4 behavior)', async () => {
      // Agents without providerConfigId are now skipped (no profile.providerId fallback)
      const agentWithoutConfig = { ...mockAgent, providerConfigId: null };
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [agentWithoutConfig],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      // Agent was skipped because no providerConfigId - no providers returned
      expect(mockStorage.getAgentProfile).not.toHaveBeenCalled();
      expect(result.providers).toHaveLength(0);
    });

    it('validates config env vars and reports errors', async () => {
      const configWithInvalidEnv = {
        ...mockConfig,
        env: { 'INVALID-KEY': 'value' }, // Invalid key with hyphen
      };
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      // Use batch methods instead of single-item fetches
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([configWithInvalidEnv]);
      mockStorage.listProvidersByIds.mockResolvedValue([mockProvider]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      expect(result.providers[0].configEnvStatus).toBe('fail');
      expect(result.providers[0].configEnvMessage).toContain('INVALID-KEY');
    });

    it('validates provider-level env and reports errors for invalid key', async () => {
      const providerWithBadEnv = {
        ...mockProvider,
        env: { 'INVALID-PROVIDER-KEY': 'value' },
      };
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([mockConfig]);
      mockStorage.listProvidersByIds.mockResolvedValue([providerWithBadEnv]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      expect(result.providers[0].providerEnvStatus).toBe('fail');
      expect(result.providers[0].providerEnvMessage).toContain('INVALID-PROVIDER-KEY');
    });

    it('validates provider-level env and reports errors for control chars in value', async () => {
      const providerWithControlChar = {
        ...mockProvider,
        env: { GOOD_KEY: 'value\x01bad' },
      };
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([mockConfig]);
      mockStorage.listProvidersByIds.mockResolvedValue([providerWithControlChar]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      expect(result.providers[0].providerEnvStatus).toBe('fail');
      expect(result.providers[0].providerEnvMessage).toContain('GOOD_KEY');
    });

    it('passes preflight when provider env and config env are both valid with overlapping keys', async () => {
      const providerWithEnv = {
        ...mockProvider,
        env: { SHARED_KEY: 'provider-value', PROVIDER_ONLY: 'pval' },
      };
      const configWithEnv = {
        ...mockConfig,
        env: { SHARED_KEY: 'config-value', CONFIG_ONLY: 'cval' },
      };
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([configWithEnv]);
      mockStorage.listProvidersByIds.mockResolvedValue([providerWithEnv]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      expect(result.providers[0].providerEnvStatus).toBe('pass');
      expect(result.providers[0].configEnvStatus).toBe('pass');
    });

    it('validates all providers when no project path', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [mockProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      // Provider-profile relationship now via configs (not profile.providerId)
      mockStorage.listAllProfileProviderConfigs.mockResolvedValue([mockConfig]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks();

      expect(mockStorage.listProviders).toHaveBeenCalled();
      expect(mockStorage.listAllProfileProviderConfigs).toHaveBeenCalled();
      expect(result.providers).toHaveLength(1);
    });
  });

  describe('config-file provider (opencode) preflight', () => {
    const opencodeProvider = {
      id: 'p-oc',
      name: 'opencode',
      binPath: '/usr/local/bin/opencode',
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '',
      updatedAt: '',
    };

    beforeEach(() => {
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );
    });

    it('returns warn MCP status for opencode without project context', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [opencodeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAllProfileProviderConfigs.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);

      const result = await service.runChecks();

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('opencode');
      expect(result.providers[0].mcpStatus).toBe('warn');
      expect(result.providers[0].mcpMessage).toContain('requires project context');
      expect(mockMcpRegistration.listRegistrations).not.toHaveBeenCalled();
    });

    it('evaluates MCP normally for opencode with project context', async () => {
      mockStorage.findProjectByPath.mockResolvedValue({
        id: 'project-1',
        name: 'Test',
        rootPath: '/test',
        isTemplate: false,
        description: null,
        createdAt: '',
        updatedAt: '',
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-oc',
            projectId: 'project-1',
            profileId: 'profile-1',
            providerConfigId: 'config-oc',
            name: 'OC Agent',
            description: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([
        {
          id: 'config-oc',
          profileId: 'profile-1',
          providerId: 'p-oc',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      mockStorage.listProvidersByIds.mockResolvedValue([opencodeProvider]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks('/test/project');

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('opencode');
      expect(result.providers[0].mcpStatus).toBe('pass');
      expect(mockMcpRegistration.listRegistrations).toHaveBeenCalledWith(opencodeProvider, {
        cwd: '/test/project',
      });
    });
  });

  describe('requiresProjectContext', () => {
    const setupExec = () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) {
            callback(null, 'tmux 3.2', '');
          }
          return {} as ReturnType<typeof mockExec>;
        },
      );
    };

    it('sets requiresProjectContext true for project_config provider (opencode)', async () => {
      setupExec();
      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p-oc',
            name: 'opencode',
            binPath: '/usr/local/bin/opencode',
            mcpConfigured: false,
            mcpEndpoint: null,
            mcpRegisteredAt: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAllProfileProviderConfigs.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);

      const result = await service.runChecks();

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('opencode');
      expect(result.providers[0].requiresProjectContext).toBe(true);
    });

    it('omits requiresProjectContext for cli-mode provider (claude)', async () => {
      setupExec();
      mockStorage.listProviders.mockResolvedValue({
        items: [
          {
            id: 'p-cl',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: true,
            mcpEndpoint: 'http://127.0.0.1:3000/mcp',
            mcpRegisteredAt: '2024-01-01',
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAllProfileProviderConfigs.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue({
        success: true,
        message: 'OK',
        entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
      });

      const result = await service.runChecks();

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('claude');
      expect(result.providers[0].requiresProjectContext).toBeUndefined();
    });
  });

  describe('includeAllProviders mode', () => {
    const mockProject = {
      id: 'project-1',
      name: 'Test',
      rootPath: '/test',
      isTemplate: false,
      description: null,
      createdAt: '',
      updatedAt: '',
    };

    const claudeProvider = {
      id: 'p-cl',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: 'http://127.0.0.1:3000/mcp',
      mcpRegisteredAt: '2024-01-01',
      createdAt: '',
      updatedAt: '',
    };

    const codexProvider = {
      id: 'p-cx',
      name: 'codex',
      binPath: '/usr/local/bin/codex',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '',
      updatedAt: '',
    };

    const claudeAgent = {
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-cl',
      name: 'Claude Agent',
      description: null,
      createdAt: '',
      updatedAt: '',
    };

    const claudeConfig = {
      id: 'config-cl',
      profileId: 'profile-1',
      providerId: 'p-cl',
      options: null,
      env: null,
      createdAt: '',
      updatedAt: '',
    };

    const okMcpResult = {
      success: true,
      message: 'OK',
      entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
    };

    it('returns all registered providers regardless of agent usage', async () => {
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider, codexProvider],
        total: 2,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [claudeAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([claudeConfig]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);
      mockMcpRegistration.resolveBinary.mockResolvedValue({
        success: true,
        binaryPath: '/usr/bin/codex',
      });

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(2);
      expect(result.providers.map((p) => p.name)).toContain('claude');
      expect(result.providers.map((p) => p.name)).toContain('codex');
    });

    it('does not call listAllProfileProviderConfigs (no cross-project leakage)', async () => {
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);

      await service.runChecks('/test', { includeAllProviders: true });

      expect(mockStorage.listAllProfileProviderConfigs).not.toHaveBeenCalled();
    });

    it('checks[] does not contain tmux or .devchain access entries', async () => {
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAgents.mockResolvedValue({
        items: [claudeAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([claudeConfig]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.checks).toHaveLength(0);
      expect(result.checks.some((c) => c.name === 'tmux')).toBe(false);
      expect(result.checks.some((c) => c.name === '.devchain access')).toBe(false);
    });

    it('populates usedByAgents from project agents; unused provider gets undefined', async () => {
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider, codexProvider],
        total: 2,
        limit: 100,
        offset: 0,
      });
      // Only claude agent exists for this project
      mockStorage.listAgents.mockResolvedValue({
        items: [claudeAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([claudeConfig]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);
      mockMcpRegistration.resolveBinary.mockResolvedValue({
        success: true,
        binaryPath: '/usr/bin/codex',
      });

      const result = await service.runChecks('/test', { includeAllProviders: true });

      const claudeCheck = result.providers.find((p) => p.name === 'claude');
      const codexCheck = result.providers.find((p) => p.name === 'codex');
      expect(claudeCheck?.usedByAgents).toEqual(['Claude Agent']);
      expect(codexCheck?.usedByAgents).toBeUndefined();
    });

    it('failing provider surfaces status:fail; other providers succeed (Promise.allSettled)', async () => {
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider, codexProvider],
        total: 2,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);
      // listRegistrations throws for codex; succeeds for claude
      mockMcpRegistration.listRegistrations.mockImplementation(
        async (provider: { name: string }) => {
          if (provider.name === 'codex') throw new Error('connection timeout');
          return okMcpResult;
        },
      );

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(2);
      const claudeCheck = result.providers.find((p) => p.name === 'claude');
      const codexCheck = result.providers.find((p) => p.name === 'codex');
      expect(claudeCheck?.status).toBe('pass');
      // Rejected provider: aggregate fail + full MCP fail fields + warn binary
      expect(codexCheck?.status).toBe('fail');
      expect(codexCheck?.message).toContain('connection timeout');
      expect(codexCheck?.mcpStatus).toBe('fail');
      expect(codexCheck?.mcpMessage).toContain('connection timeout');
      expect(codexCheck?.binaryStatus).toBe('warn');
      expect(codexCheck?.binaryMessage).toContain('Could not verify');
    });

    it('honors ENABLED_PROVIDERS filter in includeAllProviders mode', async () => {
      process.env.ENABLED_PROVIDERS = 'claude';
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider, codexProvider],
        total: 2,
        limit: 100,
        offset: 0,
      });
      mockStorage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('claude');
    });

    it('returns all providers with empty metadata when project path does not resolve', async () => {
      mockStorage.findProjectByPath.mockResolvedValue(null);
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider, codexProvider],
        total: 2,
        limit: 100,
        offset: 0,
      });
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);
      mockMcpRegistration.resolveBinary.mockResolvedValue({
        success: true,
        binaryPath: '/usr/bin/codex',
      });

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(2);
      result.providers.forEach((p) => expect(p.usedByAgents).toBeUndefined());
    });

    it('default path regression guard: checks[] still includes tmux and devchain access', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          optionsOrCallback?: unknown,
          maybeCallback?: unknown,
        ): ReturnType<typeof mockExec> => {
          const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
          ) as ExecCallback;
          if (cmd === 'tmux -V' && callback) callback(null, 'tmux 3.2', '');
          return {} as ReturnType<typeof mockExec>;
        },
      );
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listAgents.mockResolvedValue({
        items: [claudeAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([claudeConfig]);
      mockStorage.listProvidersByIds.mockResolvedValue([claudeProvider]);
      mockAccess.mockResolvedValue(undefined);
      mockMcpRegistration.listRegistrations.mockResolvedValue(okMcpResult);

      const result = await service.runChecks('/test'); // no opts

      expect(result.checks.some((c) => c.name === 'tmux')).toBe(true);
      expect(result.checks.some((c) => c.name === '.devchain access')).toBe(true);
    });
  });

  describe('allSettled rejection fallback contract', () => {
    const mockProject = {
      id: 'project-1',
      name: 'Test',
      rootPath: '/test',
      isTemplate: false,
      description: null,
      createdAt: '',
      updatedAt: '',
    };

    const claudeProvider = {
      id: 'p-cl',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: 'http://127.0.0.1:3000/mcp',
      mcpRegisteredAt: '2024-01-01',
      createdAt: '',
      updatedAt: '',
    };

    const codexProvider = {
      id: 'p-cx',
      name: 'codex',
      binPath: '/usr/local/bin/codex',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '',
      updatedAt: '',
    };

    const opencodeProvider = {
      id: 'p-oc',
      name: 'opencode',
      binPath: '/usr/local/bin/opencode',
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '',
      updatedAt: '',
    };

    const okMcpResult = {
      success: true,
      message: 'OK',
      entries: [{ alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp' }],
    };

    beforeEach(() => {
      mockStorage.findProjectByPath.mockResolvedValue(mockProject);
      mockStorage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      mockStorage.listProfileProviderConfigsByIds.mockResolvedValue([]);
      mockAccess.mockResolvedValue(undefined);
    });

    it('case 1: rejected provider gets mcpStatus:fail, non-empty mcpMessage, binaryStatus:warn, aggregate status:fail', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockMcpRegistration.listRegistrations.mockRejectedValue(new Error('connection refused'));

      const result = await service.runChecks('/test', { includeAllProviders: true });

      const check = result.providers[0];
      expect(result.providers).toHaveLength(1);
      expect(check.status).toBe('fail');
      expect(check.mcpStatus).toBe('fail');
      expect(check.mcpMessage).toBeTruthy();
      expect(check.mcpMessage).toContain('connection refused');
      expect(check.binaryStatus).toBe('warn');
      expect(result.overall).toBe('fail');
    });

    it('case 2: rejected project_config provider (opencode) returns requiresProjectContext:true', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [opencodeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockMcpRegistration.listRegistrations.mockRejectedValue(new Error('mcp registration failed'));

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].requiresProjectContext).toBe(true);
    });

    it('case 3: rejected cli-mode provider (claude) returns requiresProjectContext:undefined', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockMcpRegistration.listRegistrations.mockRejectedValue(new Error('mcp registration failed'));

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].requiresProjectContext).toBeUndefined();
    });

    it('case 4: adapter lookup failure inside rejection fallback does not re-throw', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider],
        total: 1,
        limit: 100,
        offset: 0,
      });
      mockMcpRegistration.listRegistrations.mockRejectedValue(new Error('primary failure'));
      // First getAdapter call (inside evaluateMcpStatus) succeeds;
      // second call (inside the allSettled rejection fallback) throws — must be caught, not re-thrown
      mockAdapterFactory.getAdapter
        .mockImplementationOnce(() => ({ providerName: 'claude' }))
        .mockImplementation(() => {
          throw new Error('adapter registry unavailable');
        });

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].status).toBe('fail');
      expect(result.providers[0].requiresProjectContext).toBeUndefined();
    });

    it('case 5: non-throwing providers return correct mcpStatus alongside the failed one', async () => {
      mockStorage.listProviders.mockResolvedValue({
        items: [claudeProvider, codexProvider],
        total: 2,
        limit: 100,
        offset: 0,
      });
      mockMcpRegistration.listRegistrations.mockImplementation(
        async (provider: { name: string }) => {
          if (provider.name === 'codex') throw new Error('codex exploded');
          return okMcpResult;
        },
      );

      const result = await service.runChecks('/test', { includeAllProviders: true });

      expect(result.providers).toHaveLength(2);
      const claudeCheck = result.providers.find((p) => p.name === 'claude');
      const codexCheck = result.providers.find((p) => p.name === 'codex');
      expect(claudeCheck?.mcpStatus).toBe('pass');
      expect(codexCheck?.mcpStatus).toBe('fail');
      expect(codexCheck?.mcpMessage).toContain('codex exploded');
    });
  });
});
