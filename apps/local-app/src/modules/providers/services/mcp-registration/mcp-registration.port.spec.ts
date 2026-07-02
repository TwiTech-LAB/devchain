import type { Provider } from '../../../storage/models/domain.models';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory, ClaudeAdapter, CodexAdapter } from '../../../providers/adapters';
import { OpencodeAdapter } from '../../../providers/adapters/opencode.adapter';
import { AntigravityAdapter } from '../../../providers/adapters/antigravity.adapter';
import { CopilotAdapter } from '../../../providers/adapters/copilot.adapter';
import { FakeProcessExecutor } from '../../../terminal/services/process-executor/fake-process-executor';
import { McpRegistrationPort } from './mcp-registration.port';
import { CliMcpRegistrationAdapter } from './cli-mcp-registration.adapter';
import { ConfigFileMcpRegistrationAdapter } from './config-file-mcp-registration.adapter';
import { AntigravityMcpRegistrationAdapter } from './antigravity-mcp-registration.adapter';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
  mkdir: jest.fn(),
}));

jest.mock('../../../../common/logging/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => instance };
});

const accessMock = jest.requireMock('fs/promises').access as jest.Mock;
const readFileMock = jest.requireMock('fs/promises').readFile as jest.Mock;
const writeFileMock = jest.requireMock('fs/promises').writeFile as jest.Mock;
const renameMock = jest.requireMock('fs/promises').rename as jest.Mock;
const mkdirMock = jest.requireMock('fs/promises').mkdir as jest.Mock;

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

  const agyProvider: Provider = {
    id: 'p-agy',
    name: 'agy',
    binPath: '/usr/local/bin/agy',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const copilotProvider: Provider = {
    id: 'p-copilot',
    name: 'copilot',
    binPath: '/usr/local/bin/copilot',
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
      opencodeAdapter,
      new AntigravityAdapter(),
      // MCP methods don't use the injected trust/auth services, so stub them.
      new CopilotAdapter(undefined as never, undefined as never),
    );
    fakeExecutor = new FakeProcessExecutor();
    const cliAdapter = new CliMcpRegistrationAdapter(factory, fakeExecutor);
    const configFileAdapter = new ConfigFileMcpRegistrationAdapter(factory);
    const antigravityAdapter = new AntigravityMcpRegistrationAdapter(factory);
    port = new McpRegistrationPort(cliAdapter, configFileAdapter, antigravityAdapter, factory);

    accessMock.mockReset();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    renameMock.mockReset();
    mkdirMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
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

  describe('CLI adapter routing (Copilot — pipe + list-then-add, no Authorization)', () => {
    it('register delegates to CLI adapter with --transport http and NO --header', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'Added server "devchain"' });

      const result = await port.register(copilotProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls[0].argv).toEqual([
        '/usr/local/bin/copilot',
        'mcp',
        'add',
        '--transport',
        'http',
        'devchain',
        'http://127.0.0.1:3000/mcp',
      ]);
      expect(fakeExecutor.calls[0].argv).not.toContain('--header');
      expect(fakeExecutor.calls[0].mode).toBe('pipe');
    });

    it('list uses pipe mode with --json and parses the {mcpServers:{}} shape', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: JSON.stringify({
          mcpServers: {
            devchain: { type: 'http', url: 'http://127.0.0.1:3000/mcp', source: 'user' },
          },
        }),
      });

      const result = await port.list(copilotProvider);

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls[0].argv).toEqual([
        '/usr/local/bin/copilot',
        'mcp',
        'list',
        '--json',
      ]);
      expect(fakeExecutor.calls[0].mode).toBe('pipe');
      expect(result.entries).toEqual([
        { alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp', transport: 'HTTP' },
      ]);
    });

    it('remove delegates to CLI adapter', async () => {
      accessMock.mockResolvedValue(undefined);
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'Removed server "devchain"' });

      const result = await port.remove(copilotProvider, 'devchain');

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls[0].argv).toEqual([
        '/usr/local/bin/copilot',
        'mcp',
        'remove',
        'devchain',
      ]);
    });

    it('ensure (list-then-add): already_configured on empty list → adds, on match → no re-add', async () => {
      accessMock.mockResolvedValue(undefined);
      // First ensure: empty list ({mcpServers:{}}) → add (2 calls).
      fakeExecutor.enqueueResponse({ type: 'success', stdout: JSON.stringify({ mcpServers: {} }) });
      fakeExecutor.enqueueResponse({ type: 'success', stdout: 'Added server "devchain"' });

      const added = await port.ensure(copilotProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(added.success).toBe(true);
      expect(added.action).toBe('added');
      expect(fakeExecutor.calls).toHaveLength(2);

      // Second ensure: list now shows the alias at the same endpoint → no re-add
      // (critical — copilot's `mcp add` ERRORS on a duplicate alias).
      fakeExecutor.enqueueResponse({
        type: 'success',
        stdout: JSON.stringify({
          mcpServers: { devchain: { type: 'http', url: 'http://127.0.0.1:3000/mcp' } },
        }),
      });

      const idempotent = await port.ensure(copilotProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(idempotent.success).toBe(true);
      expect(idempotent.action).toBe('already_configured');
      // Only the single list call from the second ensure — no add was attempted.
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

  describe('Antigravity (agy) HOME-global adapter routing', () => {
    it('register writes ~/.gemini/config/mcp_config.json with a serverUrl entry (no CLI, no cwd)', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      // No cwd passed — agy MCP config is HOME-global, not project-local.
      const result = await port.register(agyProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls).toHaveLength(0);
      const writtenPath = writeFileMock.mock.calls[0][0] as string;
      expect(writtenPath).toContain('/.gemini/config/mcp_config.json');
      const written = JSON.parse(writeFileMock.mock.calls[0][1].trim());
      expect(written.mcpServers.devchain.serverUrl).toBe('http://127.0.0.1:3000/mcp');
      // Routed to the global-config adapter, not opencode-flat `mcp`.
      expect(written.mcp).toBeUndefined();
    });

    it('treats an empty (0-byte) config file as "no servers" and adds', async () => {
      readFileMock.mockResolvedValue('');

      const result = await port.ensure(agyProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      const written = JSON.parse(writeFileMock.mock.calls[0][1].trim());
      expect(written.mcpServers.devchain.serverUrl).toBe('http://127.0.0.1:3000/mcp');
    });

    it('list parses mcpServers[].serverUrl into entries', async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mcpServers: { devchain: { serverUrl: 'http://127.0.0.1:3000/mcp' } },
        }),
      );

      const result = await port.list(agyProvider);

      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
      });
      expect(fakeExecutor.calls).toHaveLength(0);
    });

    it('ensure returns already_configured when the serverUrl matches', async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mcpServers: { devchain: { serverUrl: 'http://127.0.0.1:3000/mcp' } },
        }),
      );

      const result = await port.ensure(agyProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('register preserves other servers and top-level keys', async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mcpServers: { other: { serverUrl: 'http://example.test/mcp' } },
          someOtherKey: 'keep-me',
        }),
      );

      const result = await port.register(agyProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(true);
      const written = JSON.parse(writeFileMock.mock.calls[0][1].trim());
      expect(written.mcpServers.other.serverUrl).toBe('http://example.test/mcp');
      expect(written.mcpServers.devchain.serverUrl).toBe('http://127.0.0.1:3000/mcp');
      expect(written.someOtherKey).toBe('keep-me');
    });

    it('refuses to write malformed JSON (no data loss)', async () => {
      readFileMock.mockResolvedValue('{ not json');

      const result = await port.register(agyProvider, {
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/malformed JSON/);
      expect(writeFileMock).not.toHaveBeenCalled();
    });
  });
});
