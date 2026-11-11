import * as path from 'path';
import type { Provider } from '../../../storage/models/domain.models';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory, ClaudeAdapter, CodexAdapter } from '../../../providers/adapters';
import { OpencodeAdapter } from '../../../providers/adapters/opencode.adapter';
import { AntigravityAdapter } from '../../../providers/adapters/antigravity.adapter';
import { CopilotAdapter } from '../../../providers/adapters/copilot.adapter';
import { DevinAdapter } from '../../../providers/adapters/devin.adapter';
import { FakeProcessExecutor } from '../../../terminal/services/process-executor/fake-process-executor';
import { McpRegistrationPort } from './mcp-registration.port';
import { CliMcpRegistrationAdapter } from './cli-mcp-registration.adapter';
import { ConfigFileMcpRegistrationAdapter } from './config-file-mcp-registration.adapter';
import { AntigravityMcpRegistrationAdapter } from './antigravity-mcp-registration.adapter';
import { parseJsonc } from '../../../../common/jsonc';

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
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
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
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
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
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
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
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const devinProvider: Provider = {
    id: 'p-devin',
    name: 'devin',
    binPath: '/usr/local/bin/devin',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
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
      // MCP methods don't use the injected trust/auth services, so stub them.
      new AntigravityAdapter(undefined as never),
      new CopilotAdapter(undefined as never, undefined as never),
      new DevinAdapter(),
    );
    fakeExecutor = new FakeProcessExecutor();
    const cliAdapter = new CliMcpRegistrationAdapter(factory, fakeExecutor);
    // A separate executor: the git-exclude lookup is not a provider CLI call.
    const configFileAdapter = new ConfigFileMcpRegistrationAdapter(
      factory,
      new FakeProcessExecutor(),
    );
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

  it.each(['claude', 'copilot', 'codex'])(
    'applies update policy to every %s MCP command',
    async (name) => {
      accessMock.mockResolvedValue(undefined);
      const provider = { ...claudeProvider, name, binPath: `/usr/local/bin/${name}` };
      fakeExecutor.enqueueResponse(
        { type: 'success', stdout: '' },
        { type: 'success', stdout: '' },
        { type: 'success', stdout: '' },
      );
      const saved = { ...process.env };
      process.env.DISABLE_AUTOUPDATER = '0';
      process.env.COPILOT_AUTO_UPDATE = 'true';
      try {
        await port.register(provider, { endpoint: 'http://localhost:3000/mcp' });
        await port.list(provider);
        await port.remove(provider, 'devchain');
        expect(fakeExecutor.calls).toHaveLength(3);
        for (const call of fakeExecutor.calls) {
          if (name === 'codex')
            expect(call.argv.slice(1, 3)).toEqual(['-c', 'check_for_update_on_startup=false']);
          else
            expect(call.env).toMatchObject(
              name === 'claude' ? { DISABLE_AUTOUPDATER: '1' } : { COPILOT_AUTO_UPDATE: 'false' },
            );
        }
      } finally {
        process.env = saved;
      }
    },
  );

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

  describe('ConfigFile adapter routing (Devin — .devin/mcp_config.local.json)', () => {
    // Devin declares mcpMode='project_config' → isMcpCli=false → the port must
    // route it to ConfigFileMcpRegistrationAdapter, never the CLI adapter
    // (`devin mcp remove` can't touch foreign configs).
    const devinConfigPath = path.join('/projects/myapp', '.devin', 'mcp_config.local.json');

    it('register writes mcpServers.<alias> under .devin/ with mkdir, zero CLI calls', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      const result = await port.register(
        devinProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(fakeExecutor.calls).toHaveLength(0);
      expect(mkdirMock).toHaveBeenCalledWith(path.dirname(devinConfigPath), {
        recursive: true,
      });
      expect(writeFileMock).toHaveBeenCalledWith(
        devinConfigPath + '.tmp',
        expect.any(String),
        'utf-8',
      );
      expect(renameMock).toHaveBeenCalledWith(devinConfigPath + '.tmp', devinConfigPath);
      const written = JSON.parse(writeFileMock.mock.calls[0][1] as string);
      expect(written.mcpServers.devchain).toEqual({
        url: 'http://127.0.0.1:3000/mcp',
        transport: 'http',
      });
      expect(written.mcp).toBeUndefined();
    });

    it('ensure reports already_configured when the commented file entry endpoint matches', async () => {
      readFileMock.mockResolvedValue(`{
  // devin documents comments in this file
  "mcpServers": {
    "devchain": { "url": "http://127.0.0.1:3000/mcp", "transport": "http" },
  },
}`);

      const result = await port.ensure(
        devinProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_configured');
      expect(fakeExecutor.calls).toHaveLength(0);
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('register and remove edit only the DevChain entry of a commented file', async () => {
      const original = `{
  // user servers
  "mcpServers": {
    "mine": { "command": "my-mcp", "args": [] } /* stdio */
  }
}
`;
      readFileMock.mockResolvedValueOnce(original);
      await port.register(
        devinProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );
      const added = writeFileMock.mock.calls[0][1] as string;
      expect(added).toContain('// user servers');
      expect(added).toContain('/* stdio */');
      expect(parseJsonc(added)).toEqual({
        mcpServers: {
          mine: { command: 'my-mcp', args: [] },
          devchain: { url: 'http://127.0.0.1:3000/mcp', transport: 'http' },
        },
      });

      readFileMock.mockResolvedValueOnce(added);
      const removed = await port.remove(devinProvider, 'devchain', { cwd: '/projects/myapp' });

      expect(removed.success).toBe(true);
      const after = writeFileMock.mock.calls[1][1] as string;
      expect(after).toContain('// user servers');
      expect(after).toContain('/* stdio */');
      expect(parseJsonc(after)).toEqual({ mcpServers: { mine: { command: 'my-mcp', args: [] } } });
    });

    it('ensure adds the entry when the file is missing (no devin CLI involved)', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      readFileMock.mockRejectedValue(enoent);

      const result = await port.ensure(
        devinProvider,
        { endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' },
        { cwd: '/projects/myapp' },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(fakeExecutor.calls).toHaveLength(0);
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
  });
});
