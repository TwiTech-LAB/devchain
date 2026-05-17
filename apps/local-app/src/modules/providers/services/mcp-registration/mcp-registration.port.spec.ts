import type { Provider } from '../../../storage/models/domain.models';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import {
  ProviderAdapterFactory,
  ClaudeAdapter,
  CodexAdapter,
  GeminiAdapter,
} from '../../../providers/adapters';
import { OpencodeAdapter } from '../../../providers/adapters/opencode.adapter';
import { FakeProcessExecutor } from '../../../terminal/services/process-executor/fake-process-executor';
import { McpRegistrationPort } from './mcp-registration.port';
import { CliMcpRegistrationAdapter } from './cli-mcp-registration.adapter';
import { ConfigFileMcpRegistrationAdapter } from './config-file-mcp-registration.adapter';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
}));

jest.mock('../../../../common/logging/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => instance };
});

const accessMock = jest.requireMock('fs/promises').access as jest.Mock;
const readFileMock = jest.requireMock('fs/promises').readFile as jest.Mock;
const writeFileMock = jest.requireMock('fs/promises').writeFile as jest.Mock;
const renameMock = jest.requireMock('fs/promises').rename as jest.Mock;

describe('McpRegistrationPort', () => {
  let port: McpRegistrationPort;
  let fakeExecutor: FakeProcessExecutor;

  const claudeProvider: Provider = {
    id: 'p-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const geminiProvider: Provider = {
    id: 'p-gemini',
    name: 'gemini',
    binPath: '/usr/local/bin/gemini',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const opencodeProvider: Provider = {
    id: 'p-opencode',
    name: 'opencode',
    binPath: '/usr/local/bin/opencode',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    const storage = { updateProviderMcpMetadata: jest.fn() } as unknown as StorageService;
    const opencodeAdapter = new OpencodeAdapter();
    const factory = new ProviderAdapterFactory(
      storage,
      new ClaudeAdapter(),
      new CodexAdapter(),
      new GeminiAdapter(),
      opencodeAdapter,
    );
    fakeExecutor = new FakeProcessExecutor();
    const cliAdapter = new CliMcpRegistrationAdapter(factory, fakeExecutor);
    const configFileAdapter = new ConfigFileMcpRegistrationAdapter(factory);
    port = new McpRegistrationPort(cliAdapter, configFileAdapter, factory);

    accessMock.mockReset();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    renameMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);
  });

  describe('CLI adapter routing (Claude)', () => {
    it('register delegates to CLI adapter and spawns process', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'ok' });

      const result = await port.register(claudeProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls[0].argv).toEqual([
        '/usr/local/bin/claude',
        'mcp',
        'add',
        '--transport',
        'http',
        'claude',
        'http://127.0.0.1:3000/mcp',
      ]);
      expect(fakeExecutor.calls[0].mode).toBe('pipe');
    });

    it('list delegates to CLI adapter and parses output', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'devchain: http://127.0.0.1:3000/mcp (http) - ✓ Connected',
      });

      const result = await port.list(claudeProvider);

      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].alias).toBe('devchain');
      expect(fakeExecutor.calls[0].mode).toBe('pipe');
    });

    it('remove delegates to CLI adapter', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'removed' });

      const result = await port.remove(claudeProvider, 'devchain');

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls[0].argv).toEqual([
        '/usr/local/bin/claude',
        'mcp',
        'remove',
        'devchain',
      ]);
    });
  });

  describe('CLI adapter routing (Gemini — PTY + upsert)', () => {
    it('list uses PTY mode for Gemini', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: '' });

      await port.list(geminiProvider);

      expect(fakeExecutor.calls[0].mode).toBe('pty');
    });

    it('ensure uses upsert strategy for Gemini (skips list)', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'ok' });

      const result = await port.ensure(
        geminiProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(fakeExecutor.calls).toHaveLength(1);
      expect(fakeExecutor.calls[0].argv).toEqual(expect.arrayContaining(['--scope', 'project']));
    });
  });

  describe('CLI adapter ensure — list-then-add (Claude)', () => {
    it('returns already_configured when entry exists with correct endpoint', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'devchain: http://127.0.0.1:3000/mcp (http) - ✓ Connected',
      });

      const result = await port.ensure(claudeProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(fakeExecutor.calls).toHaveLength(1);
    });

    it('returns added when entry does not exist', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: '' });
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'ok' });

      const result = await port.ensure(claudeProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(fakeExecutor.calls).toHaveLength(2);
    });

    it('returns fixed_mismatch when endpoint differs', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: 'devchain: http://127.0.0.1:4000/mcp (http) - ✓ Connected',
      });
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'removed' });
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'added' });

      const result = await port.ensure(claudeProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('fixed_mismatch');
      expect(fakeExecutor.calls).toHaveLength(3);
    });
  });

  describe('ConfigFile adapter routing (OpenCode)', () => {
    it('register writes opencode.json', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      const result = await port.register(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(writeFileMock).toHaveBeenCalled();
      const written = JSON.parse(writeFileMock.mock.calls[0][1].trim());
      expect(written.mcp.devchain.url).toBe('http://127.0.0.1:3000/mcp');
      expect(fakeExecutor.calls).toHaveLength(0);
    });

    it('list reads opencode.json and parses entries', async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mcp: { devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
        }),
      );

      const result = await port.list(opencodeProvider, { cwd: '/projects/myapp' });

      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].alias).toBe('devchain');
      expect(fakeExecutor.calls).toHaveLength(0);
    });

    it('remove deletes entry from opencode.json', async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mcp: { devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
        }),
      );

      const result = await port.remove(opencodeProvider, 'devchain', {
        cwd: '/projects/myapp',
      });

      expect(result.success).toBe(true);
      const written = JSON.parse(writeFileMock.mock.calls[0][1].trim());
      expect(written.mcp.devchain).toBeUndefined();
    });

    it('requires cwd for all operations', async () => {
      const regResult = await port.register(opencodeProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
      });
      expect(regResult.success).toBe(false);

      const listResult = await port.list(opencodeProvider);
      expect(listResult.success).toBe(false);

      const removeResult = await port.remove(opencodeProvider, 'devchain');
      expect(removeResult.success).toBe(false);
    });
  });

  describe('ConfigFile adapter ensure (OpenCode)', () => {
    it('returns already_configured when entry matches', async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mcp: { devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
        }),
      );

      const result = await port.ensure(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
    });

    it('returns added when config file is empty', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValueOnce(enoent);
      readFileMock.mockRejectedValueOnce(enoent);

      const result = await port.ensure(
        opencodeProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
    });
  });
});
