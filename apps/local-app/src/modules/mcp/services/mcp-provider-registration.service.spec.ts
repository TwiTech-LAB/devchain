import { EventEmitter } from 'events';
import { McpProviderRegistrationService } from './mcp-provider-registration.service';
import type { Provider } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import {
  ProviderAdapterFactory,
  ClaudeAdapter,
  CodexAdapter,
  GeminiAdapter,
} from '../../providers/adapters';
import { OpencodeAdapter } from '../../providers/adapters/opencode.adapter';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
}));

jest.mock('child_process', () => {
  return {
    execFile: jest.fn(),
    spawn: jest.fn(),
  };
});

const accessMock = jest.requireMock('fs/promises').access as jest.Mock;
const readFileMock = jest.requireMock('fs/promises').readFile as jest.Mock;
const writeFileMock = jest.requireMock('fs/promises').writeFile as jest.Mock;
const renameMock = jest.requireMock('fs/promises').rename as jest.Mock;
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

  const opencodeProvider: Provider = {
    id: 'provider-oc',
    name: 'opencode',
    binPath: '/usr/local/bin/opencode',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    factory = new ProviderAdapterFactory(
      new ClaudeAdapter(),
      new CodexAdapter(),
      new GeminiAdapter(),
      new OpencodeAdapter(),
    );
    storage = {
      updateProviderMcpMetadata: jest.fn(),
    };
    service = new McpProviderRegistrationService(factory, storage as unknown as StorageService);
    accessMock.mockReset();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    renameMock.mockReset();
    execFileMock.mockReset();
    spawnMock.mockReset();

    writeFileMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);

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
      expect(result.message).toContain('Unable to resolve binary');
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

  describe('unsupported provider handling', () => {
    const unsupportedProvider: Provider = {
      ...baseProvider,
      name: 'unsupported-provider',
    };

    beforeEach(() => {
      accessMock.mockResolvedValue(undefined);
    });

    it('registerProvider returns failure for unsupported provider', async () => {
      const result = await service.registerProvider(unsupportedProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported provider');
      expect(result.message).toContain('unsupported-provider');
    });

    it('listRegistrations returns failure for unsupported provider', async () => {
      const result = await service.listRegistrations(unsupportedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported provider');
      expect(result.entries).toEqual([]);
    });

    it('removeRegistration returns failure for unsupported provider', async () => {
      const result = await service.removeRegistration(unsupportedProvider, 'devchain');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported provider');
    });
  });

  // ── Config-file mode (project_config) tests ────────────────────────

  describe('config-file mode — listRegistrations', () => {
    it('reads opencode.json and returns parsed entries', async () => {
      const configContent = JSON.stringify({
        mcp: {
          devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
        },
      });
      readFileMock.mockResolvedValue(configContent);

      const result = await service.listRegistrations(opencodeProvider, {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'REMOTE',
      });
      expect(readFileMock).toHaveBeenCalledWith('/projects/myapp/opencode.json', 'utf-8');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns success with empty entries when file not found', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      const result = await service.listRegistrations(opencodeProvider, {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      expect(result.entries).toEqual([]);
      expect(result.message).toContain('not found');
    });

    it('returns error for malformed JSON', async () => {
      readFileMock.mockResolvedValue('not valid json {{{');

      const result = await service.listRegistrations(opencodeProvider, {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('malformed JSON');
    });

    it('returns error when cwd is missing', async () => {
      const result = await service.listRegistrations(opencodeProvider);

      expect(result.success).toBe(false);
      expect(result.message).toContain('requires a project path');
    });
  });

  describe('config-file mode — registerProvider', () => {
    it('creates opencode.json if not exists', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('devchain');
      expect(writeFileMock).toHaveBeenCalledWith(
        '/projects/myapp/opencode.json.tmp',
        expect.stringContaining('"devchain"'),
        'utf-8',
      );
      expect(renameMock).toHaveBeenCalledWith(
        '/projects/myapp/opencode.json.tmp',
        '/projects/myapp/opencode.json',
      );
    });

    it('merges MCP entry preserving other config fields', async () => {
      const existingConfig = JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        mcp: {
          existing: { type: 'remote', url: 'http://other:8000/mcp' },
        },
        tools: { enabled: true },
      });
      readFileMock.mockResolvedValue(existingConfig);

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);

      const writtenContent = writeFileMock.mock.calls[0][1] as string;
      const written = JSON.parse(writtenContent);
      expect(written.model).toBe('anthropic/claude-sonnet-4-5');
      expect(written.tools).toEqual({ enabled: true });
      expect(written.mcp.existing).toEqual({ type: 'remote', url: 'http://other:8000/mcp' });
      expect(written.mcp.devchain).toEqual({ type: 'remote', url: 'http://127.0.0.1:3000/mcp' });
    });

    it('returns error for malformed JSON (no destructive reset)', async () => {
      readFileMock.mockResolvedValue('broken json');

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('malformed JSON');
      expect(writeFileMock).not.toHaveBeenCalled();
      expect(renameMock).not.toHaveBeenCalled();
    });

    it('uses atomic write (tmp + rename)', async () => {
      readFileMock.mockResolvedValue('{}');

      await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(writeFileMock).toHaveBeenCalledWith(
        '/projects/myapp/opencode.json.tmp',
        expect.any(String),
        'utf-8',
      );
      expect(renameMock).toHaveBeenCalledWith(
        '/projects/myapp/opencode.json.tmp',
        '/projects/myapp/opencode.json',
      );
    });

    it('returns error when cwd is missing', async () => {
      const result = await service.registerProvider(opencodeProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('requires a project path');
    });

    it('uses default alias devchain when alias not specified', async () => {
      readFileMock.mockResolvedValue('{}');

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      const writtenContent = writeFileMock.mock.calls[0][1] as string;
      const written = JSON.parse(writtenContent);
      expect(written.mcp.devchain).toBeDefined();
    });
  });

  describe('config-file mode — removeRegistration', () => {
    it('removes alias and preserves other MCP entries', async () => {
      const existingConfig = JSON.stringify({
        model: 'google/gemini-2.5-pro',
        mcp: {
          devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
          other: { type: 'remote', url: 'http://other:8000/mcp' },
        },
      });
      readFileMock.mockResolvedValue(existingConfig);

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('removed');

      const writtenContent = writeFileMock.mock.calls[0][1] as string;
      const written = JSON.parse(writtenContent);
      expect(written.model).toBe('google/gemini-2.5-pro');
      expect(written.mcp.devchain).toBeUndefined();
      expect(written.mcp.other).toEqual({ type: 'remote', url: 'http://other:8000/mcp' });
    });

    it('returns success when alias not found in config', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ mcp: {} }));

      const result = await service.removeRegistration(opencodeProvider, 'nonexistent', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('not found');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('returns success when file not found', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('nothing to remove');
    });

    it('returns error for malformed JSON', async () => {
      readFileMock.mockResolvedValue('broken');

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('malformed JSON');
    });

    it('returns error when cwd is missing', async () => {
      const result = await service.removeRegistration(opencodeProvider, 'devchain');

      expect(result.success).toBe(false);
      expect(result.message).toContain('requires a project path');
    });
  });

  // ── Shape guard regression tests (isPlainRecord) ────────────────────

  describe('config-file mode — invalid mcp shape guards', () => {
    it('register returns error when mcp is a string', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ mcp: 'abc' }));

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid "mcp" field');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('register returns error when mcp is a number', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ mcp: 42 }));

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid "mcp" field');
    });

    it('register returns error when mcp is an array', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ mcp: [1, 2] }));

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid "mcp" field');
    });

    it('remove returns error when mcp is a string', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ mcp: 'abc' }));

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid "mcp" field');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('list returns empty entries when mcp is a string', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ mcp: 'abc' }));

      const result = await service.listRegistrations(opencodeProvider, {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      expect(result.entries).toEqual([]);
    });
  });

  // ── Root JSON shape guard regression tests ──────────────────────────

  describe('config-file mode — invalid root JSON shape guards', () => {
    it('register returns error when root is null', async () => {
      readFileMock.mockResolvedValue('null');

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('register returns error when root is a string', async () => {
      readFileMock.mockResolvedValue('"abc"');

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('register returns error when root is a number', async () => {
      readFileMock.mockResolvedValue('42');

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
    });

    it('register returns error when root is an array', async () => {
      readFileMock.mockResolvedValue('[1, 2]');

      const result = await service.registerProvider(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('remove returns error when root is null', async () => {
      readFileMock.mockResolvedValue('null');

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
    });

    it('remove returns error when root is a string', async () => {
      readFileMock.mockResolvedValue('"abc"');

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
    });

    it('remove returns error when root is an array', async () => {
      readFileMock.mockResolvedValue('[1, 2]');

      const result = await service.removeRegistration(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid root structure');
    });
  });
});
