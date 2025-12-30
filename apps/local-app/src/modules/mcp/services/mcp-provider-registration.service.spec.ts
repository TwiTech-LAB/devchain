import { EventEmitter } from 'events';
import { McpProviderRegistrationService } from './mcp-provider-registration.service';
import type { Provider } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory } from '../../providers/adapters';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
}));

jest.mock('child_process', () => {
  return {
    execFile: jest.fn(),
    spawn: jest.fn(),
  };
});

const accessMock = jest.requireMock('fs/promises').access as jest.Mock;
const execFileMock = jest.requireMock('child_process').execFile as jest.Mock;
const spawnMock = jest.requireMock('child_process').spawn as jest.Mock;

describe('McpProviderRegistrationService', () => {
  let service: McpProviderRegistrationService;
  let factory: ProviderAdapterFactory;
  let storage: { updateProviderMcpMetadata: jest.Mock };

  const baseProvider: Provider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    factory = new ProviderAdapterFactory();
    storage = {
      updateProviderMcpMetadata: jest.fn(),
    };
    service = new McpProviderRegistrationService(factory, storage as unknown as StorageService);
    accessMock.mockReset();
    execFileMock.mockReset();
    spawnMock.mockReset();

    execFileMock.mockImplementation((cmd: string, args: unknown, callback?: unknown) => {
      const cb = typeof args === 'function' ? args : callback;
      if (typeof cb === 'function') {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined;
    });
  });

  describe('resolveBinary', () => {
    it('returns configured binPath when accessible', async () => {
      accessMock.mockResolvedValue(undefined);

      const result = await service.resolveBinary(baseProvider);

      expect(result.success).toBe(true);
      expect(result.binaryPath).toBe(baseProvider.binPath);
      expect(result.source).toBe('configured');
      expect(accessMock).toHaveBeenCalledWith(baseProvider.binPath, expect.any(Number));
    });

    it("falls back to 'which' lookup when binPath missing", async () => {
      accessMock.mockResolvedValue(undefined);
      execFileMock.mockImplementationOnce((cmd: string, args: unknown, callback?: unknown) => {
        const cb = typeof args === 'function' ? args : callback;
        if (typeof cb === 'function') {
          cb(null, { stdout: '/usr/bin/codex\n', stderr: '' });
        }
      });

      const provider = { ...baseProvider, name: 'codex', binPath: null };
      const result = await service.resolveBinary(provider);

      expect(execFileMock).toHaveBeenCalledWith('which', ['codex'], expect.any(Function));
      expect(result.success).toBe(true);
      expect(result.binaryPath).toBe('/usr/bin/codex');
      expect(result.source).toBe('which');
    });

    it('returns failure when discovery fails', async () => {
      const provider = { ...baseProvider, name: 'codex', binPath: null };
      execFileMock.mockImplementationOnce((cmd: string, args: unknown, callback?: unknown) => {
        const cb = typeof args === 'function' ? args : callback;
        if (typeof cb === 'function') {
          cb(new Error('not found'));
        }
      });

      const result = await service.resolveBinary(provider);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  describe('registerProvider', () => {
    it('runs registration command with resolved binary', async () => {
      accessMock.mockResolvedValue(undefined);
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
      });
      spawnMock.mockReturnValue(child);

      const promise = service.registerProvider(baseProvider, {
        endpoint: 'http://127.0.0.1:4000/mcp',
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      stdoutEmitter.emit('data', 'ok');
      stderrEmitter.emit('data', '');
      child.emit('close', 0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('ok');
      expect(spawnMock).toHaveBeenCalledWith(
        baseProvider.binPath,
        ['mcp', 'add', '--transport', 'http', 'claude', 'http://127.0.0.1:4000/mcp'],
        { env: process.env },
      );
    });

    it('returns failure when command errors', async () => {
      accessMock.mockResolvedValue(undefined);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      spawnMock.mockReturnValue(child);

      const promise = service.registerProvider(baseProvider, { endpoint: 'ws://localhost:4000' });

      await new Promise((resolve) => setTimeout(resolve, 0));

      child.emit('error', new Error('spawn failed'));

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.message).toContain('spawn failed');
    });
  });

  describe('listRegistrations', () => {
    it('executes list command and returns normalized entries', async () => {
      accessMock.mockResolvedValue(undefined);
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
      });
      spawnMock.mockReturnValue(child);

      const promise = service.listRegistrations(baseProvider);
      await new Promise((resolve) => setTimeout(resolve, 0));
      stdoutEmitter.emit('data', 'devchain: http://127.0.0.1:3000/mcp (http) - ✓ Connected');
      child.emit('close', 0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'HTTP',
      });
      expect(spawnMock).toHaveBeenCalledWith(baseProvider.binPath, ['mcp', 'list'], {
        env: process.env,
      });
    });

    it('returns empty entries on command failure', async () => {
      accessMock.mockResolvedValue(undefined);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      spawnMock.mockReturnValue(child);

      const promise = service.listRegistrations(baseProvider);
      await new Promise((resolve) => setTimeout(resolve, 0));
      child.emit('close', 1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.entries).toEqual([]);
    });
  });

  describe('removeRegistration', () => {
    it('executes remove command with adapter', async () => {
      accessMock.mockResolvedValue(undefined);
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
      });
      spawnMock.mockReturnValue(child);

      const promise = service.removeRegistration(baseProvider, 'devchain');
      await new Promise((resolve) => setTimeout(resolve, 0));
      stdoutEmitter.emit('data', 'removed');
      child.emit('close', 0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('removed');
      expect(spawnMock).toHaveBeenCalledWith(baseProvider.binPath, ['mcp', 'remove', 'devchain'], {
        env: process.env,
      });
    });
  });
});
