import * as os from 'os';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { AntigravityMcpRegistrationAdapter } from './antigravity-mcp-registration.adapter';
import { AntigravityAdapter } from '../../adapters/antigravity.adapter';
import type { ProviderAdapterFactory } from '../../adapters/provider-adapter.factory';
import type { Provider } from '../../../storage/models/domain.models';

// `os.homedir` is read-only, so mock the module and override homedir per-test.
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: jest.fn(() => actual.homedir()) };
});

jest.mock('../../../../common/logging/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => instance };
});

describe('AntigravityMcpRegistrationAdapter (HOME-global mcp_config.json)', () => {
  let home: string;
  let adapter: AntigravityMcpRegistrationAdapter;

  const endpoint = 'http://127.0.0.1:3000/mcp';
  const configPath = () => join(home, '.gemini', 'config', 'mcp_config.json');
  const readConfig = async () => JSON.parse(await readFile(configPath(), 'utf-8'));
  const seedConfig = async (value: unknown) => {
    await mkdir(join(home, '.gemini', 'config'), { recursive: true });
    await writeFile(
      configPath(),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    );
  };

  const provider: Provider = {
    id: 'p-agy',
    name: 'agy',
    binPath: '/usr/local/bin/agy',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
    createdAt: '',
    updatedAt: '',
  };

  // Minimal factory stub: agy resolves to the real (pure) capability methods.
  const factory = {
    getAdapter: () => new AntigravityAdapter(undefined as never),
  } as unknown as ProviderAdapterFactory;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'agy-mcp-home-'));
    (os.homedir as jest.Mock).mockReturnValue(home);
    adapter = new AntigravityMcpRegistrationAdapter(factory);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('register creates the config (and parent dirs) with a serverUrl entry', async () => {
    const result = await adapter.register(provider, { endpoint, alias: 'devchain' });

    expect(result.success).toBe(true);
    const config = await readConfig();
    expect(config.mcpServers.devchain).toEqual({ serverUrl: endpoint });
  });

  it('uses the HOME of the given environment and names it $HOME in messages', async () => {
    const sessionHome = await mkdtemp(join(os.tmpdir(), 'agy-mcp-session-home-'));
    try {
      const result = await adapter.register(
        provider,
        { endpoint, alias: 'devchain' },
        { env: { HOME: sessionHome } },
      );

      const written = JSON.parse(
        await readFile(join(sessionHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'),
      );
      expect(written.mcpServers.devchain).toEqual({ serverUrl: endpoint });
      await expect(readFile(configPath(), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.message).toContain(join('$HOME', '.gemini', 'config', 'mcp_config.json'));
      expect(result.message).not.toContain(sessionHome);
    } finally {
      await rm(sessionHome, { recursive: true, force: true });
    }
  });

  // agy refuses an empty or relative HOME. Without the check the file lands in the service
  // directory (relative) or in the service account's home (empty).
  it.each([
    ['a relative', '.agent-home'],
    ['an empty', ''],
  ])('refuses %s HOME of the given environment before any file access', async (_kind, home) => {
    const serviceDir = await mkdtemp(join(os.tmpdir(), 'agy-mcp-service-'));
    const previousCwd = process.cwd();
    const env = { HOME: home };
    process.chdir(serviceDir);
    try {
      const results = [
        await adapter.register(provider, { endpoint, alias: 'devchain' }, { env }),
        await adapter.list(provider, { env }),
        await adapter.remove(provider, 'devchain', { env }),
        await adapter.ensure(provider, { endpoint, alias: 'devchain' }, { env }),
      ];

      for (const result of results) {
        expect(result.success).toBe(false);
        expect(result.message).toContain('must be an absolute path');
        if (home) expect(result.message).not.toContain(home);
      }
      const sessionConfig = join(serviceDir, home, '.gemini', 'config', 'mcp_config.json');
      await expect(readFile(sessionConfig, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(configPath(), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.chdir(previousCwd);
      await rm(serviceDir, { recursive: true, force: true });
    }
  });

  // The endpoint in a config of a session HOME is the session's data: messages and logs leave it out.
  it('does not log the found endpoint when it fixes a mismatch under a session HOME', async () => {
    const sessionHome = await mkdtemp(join(os.tmpdir(), 'agy-mcp-session-home-'));
    const found = `http://127.0.0.1:4000/mcp?token=${'sentinel-session-value'}`;
    try {
      await mkdir(join(sessionHome, '.gemini', 'config'), { recursive: true });
      await writeFile(
        join(sessionHome, '.gemini', 'config', 'mcp_config.json'),
        JSON.stringify({ mcpServers: { devchain: { serverUrl: found } } }),
      );
      const logger = jest.requireMock('../../../../common/logging/logger').createLogger();
      logger.info.mockClear();

      const result = await adapter.ensure(
        provider,
        { endpoint, alias: 'devchain' },
        { env: { HOME: sessionHome } },
      );

      expect(result.action).toBe('fixed_mismatch');
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('sentinel-session-value');
    } finally {
      await rm(sessionHome, { recursive: true, force: true });
    }
  });

  it('treats an empty (0-byte) config file as "no servers" and adds', async () => {
    await seedConfig('');

    const result = await adapter.ensure(provider, { endpoint, alias: 'devchain' });

    expect(result.success).toBe(true);
    expect(result.action).toBe('added');
    const config = await readConfig();
    expect(config.mcpServers.devchain.serverUrl).toBe(endpoint);
  });

  it('is idempotent — ensure returns already_configured when the endpoint matches', async () => {
    await adapter.register(provider, { endpoint, alias: 'devchain' });

    const result = await adapter.ensure(provider, { endpoint, alias: 'devchain' });

    expect(result.success).toBe(true);
    expect(result.action).toBe('already_configured');
  });

  it('ensure fixes a mismatched endpoint in place', async () => {
    await seedConfig({ mcpServers: { devchain: { serverUrl: 'http://127.0.0.1:4000/mcp' } } });

    const result = await adapter.ensure(provider, { endpoint, alias: 'devchain' });

    expect(result.success).toBe(true);
    expect(result.action).toBe('fixed_mismatch');
    const config = await readConfig();
    expect(config.mcpServers.devchain.serverUrl).toBe(endpoint);
  });

  it('preserves other servers and unrelated top-level keys', async () => {
    await seedConfig({
      mcpServers: { other: { serverUrl: 'http://example.test/mcp' } },
      keepMe: { nested: true },
    });

    await adapter.register(provider, { endpoint, alias: 'devchain' });

    const config = await readConfig();
    expect(config.mcpServers.other.serverUrl).toBe('http://example.test/mcp');
    expect(config.mcpServers.devchain.serverUrl).toBe(endpoint);
    expect(config.keepMe).toEqual({ nested: true });
  });

  it('list reads mcpServers into entries', async () => {
    await seedConfig({ mcpServers: { devchain: { serverUrl: endpoint } } });

    const result = await adapter.list(provider);

    expect(result.success).toBe(true);
    expect(result.entries).toEqual([{ alias: 'devchain', endpoint, transport: 'HTTP' }]);
  });

  it('remove deletes the entry and preserves the rest', async () => {
    await seedConfig({
      mcpServers: {
        devchain: { serverUrl: endpoint },
        other: { serverUrl: 'http://example.test/mcp' },
      },
    });

    const result = await adapter.remove(provider, 'devchain');

    expect(result.success).toBe(true);
    const config = await readConfig();
    expect(config.mcpServers.devchain).toBeUndefined();
    expect(config.mcpServers.other.serverUrl).toBe('http://example.test/mcp');
  });

  it('refuses to modify a malformed config (no data loss) and reports it', async () => {
    await seedConfig('{ this is not json');

    const result = await adapter.register(provider, { endpoint, alias: 'devchain' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/malformed JSON/);
    // Original content untouched.
    expect(await readFile(configPath(), 'utf-8')).toBe('{ this is not json');
  });

  it('refuses to modify when mcpServers is not an object', async () => {
    await seedConfig({ mcpServers: 'oops' });

    const result = await adapter.register(provider, { endpoint, alias: 'devchain' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid "mcpServers"/);
    const raw = await readConfig();
    expect(raw.mcpServers).toBe('oops');
  });
});
