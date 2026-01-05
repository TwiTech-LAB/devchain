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
  let service: PreflightService;
  let mockStorage: jest.Mocked<StorageService>;
  let mockMcpRegistration: {
    resolveBinary: jest.Mock;
    listRegistrations: jest.Mock;
  };
  let mockAdapterFactory: {
    isSupported: jest.Mock;
    getSupportedProviders: jest.Mock;
  };

  beforeEach(async () => {
    // Create mock storage service (partial mock - only methods needed for PreflightService)
    mockStorage = {
      listProviders: jest.fn(),
      getProvider: jest.fn(),
      createProvider: jest.fn(),
      updateProvider: jest.fn(),
      deleteProvider: jest.fn(),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 0, offset: 0 }),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    } as unknown as jest.Mocked<StorageService>;

    mockMcpRegistration = {
      resolveBinary: jest.fn(),
      listRegistrations: jest.fn(),
    };

    mockAdapterFactory = {
      isSupported: jest
        .fn()
        .mockImplementation((name: string) => ['claude', 'codex', 'gemini'].includes(name)),
      getSupportedProviders: jest.fn().mockReturnValue(['claude', 'codex', 'gemini']),
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
    jest.clearAllMocks();
    jest.resetAllMocks();
    mockMcpRegistration.resolveBinary.mockReset();
    mockMcpRegistration.listRegistrations.mockReset();
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

    it('should cache results for 60 seconds', async () => {
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
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      // First call
      const result1 = await service.runChecks();
      expect(mockStorage.listProviders).toHaveBeenCalledTimes(1);

      // Second call within cache window
      const result2 = await service.runChecks();
      expect(mockStorage.listProviders).toHaveBeenCalledTimes(1); // Still 1, cached

      expect(result1.timestamp).toBe(result2.timestamp); // Same cached result
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
    it('should clear cache for specific project path', () => {
      service.clearCache('/test/project');
      // No errors should be thrown
      expect(true).toBe(true);
    });

    it('should clear all cache when no project path specified', () => {
      service.clearCache();
      // No errors should be thrown
      expect(true).toBe(true);
    });
  });
});
