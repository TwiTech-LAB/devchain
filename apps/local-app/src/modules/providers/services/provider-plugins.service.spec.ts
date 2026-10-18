import { Test, type TestingModule } from '@nestjs/testing';
import { createMockProvider } from '../../../../test/factories/provider';
import * as resolveBinaryModule from '../../../common/resolve-binary';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ClaudeAdapter } from '../adapters/claude.adapter';
import { CodexAdapter } from '../adapters/codex.adapter';
import type { ProviderAdapter } from '../adapters/provider-adapter.interface';
import { ProviderAdapterFactory } from '../adapters/provider-adapter.factory';
import { CodexAppServerClient } from './codex-app-server.client';
import { ProviderPluginsService } from './provider-plugins.service';

const mockWarn = jest.fn();
jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

jest.mock('../../../common/resolve-binary');
const mockResolveBinary = resolveBinaryModule.resolveBinary as jest.MockedFunction<
  typeof resolveBinaryModule.resolveBinary
>;

const CLAUDE_CATALOG = JSON.stringify({
  installed: [
    {
      id: 'installed@claude-market',
      version: '2.0.0',
      scope: 'user',
      enabled: true,
    },
  ],
  available: [
    {
      pluginId: 'available@claude-market',
      name: 'available',
      description: 'Claude plugin',
      marketplaceName: 'claude-market',
    },
  ],
});

const CODEX_PLUGIN_LIST = {
  marketplaces: [
    {
      name: 'codex-market',
      plugins: [
        {
          id: 'available@codex-market',
          name: 'available',
          version: '1.0.0',
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
          availability: 'AVAILABLE',
          interface: { displayName: 'Available', shortDescription: 'Codex plugin' },
        },
      ],
    },
  ],
  marketplaceLoadErrors: [],
};

describe('ProviderPluginsService (module unit: mocked storage/binary resolution/process I/O)', () => {
  let service: ProviderPluginsService;
  let executor: FakeProcessExecutor;
  let appServer: { request: jest.Mock };
  let storage: {
    listProviders: jest.Mock;
    getProvider: jest.Mock;
  };
  let adapters: Map<string, ProviderAdapter>;

  const claudeProvider = createMockProvider({
    id: 'provider-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
  });
  const codexProvider = createMockProvider({
    id: 'provider-codex',
    name: 'codex',
    binPath: '/usr/local/bin/codex',
  });
  const unsupportedProvider = createMockProvider({
    id: 'provider-opencode',
    name: 'opencode',
    binPath: '/usr/local/bin/opencode',
  });

  let savedAutoUpdater: string | undefined;

  beforeEach(async () => {
    savedAutoUpdater = process.env.DISABLE_AUTOUPDATER;
    process.env.DISABLE_AUTOUPDATER = '0';
    executor = new FakeProcessExecutor();
    appServer = { request: jest.fn().mockResolvedValue(CODEX_PLUGIN_LIST) };
    storage = {
      listProviders: jest.fn().mockResolvedValue({
        items: [claudeProvider, codexProvider, unsupportedProvider],
        total: 3,
        limit: 1_000,
        offset: 0,
      }),
      getProvider: jest.fn(),
    };
    adapters = new Map<string, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      [
        'opencode',
        {
          providerName: 'opencode',
          buildLaunchArgs: ({ profileOptionArgs }) => ({ argv: profileOptionArgs }),
        },
      ],
    ]);
    const adapterFactory = {
      isSupported: jest.fn((name: string) => adapters.has(name.toLowerCase())),
      getAdapter: jest.fn((name: string) => adapters.get(name.toLowerCase())!),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderPluginsService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: ProviderAdapterFactory, useValue: adapterFactory },
        { provide: ProcessExecutor, useValue: executor },
        { provide: CodexAppServerClient, useValue: appServer },
      ],
    }).compile();

    service = module.get(ProviderPluginsService);
    mockResolveBinary.mockImplementation(async (candidate) => candidate);
  });

  afterEach(() => {
    if (savedAutoUpdater === undefined) delete process.env.DISABLE_AUTOUPDATER;
    else process.env.DISABLE_AUTOUPDATER = savedAutoUpdater;
    jest.clearAllMocks();
  });

  it('normalizes catalogs for capable providers and skips unsupported providers', async () => {
    executor.enqueueResponse({ type: 'success', stdout: CLAUDE_CATALOG });

    const result = await service.listCatalog();

    expect(executor.calls[0].env).toMatchObject({ DISABLE_AUTOUPDATER: '1' });
    expect(result.total).toBe(3);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'provider-claude',
          providerName: 'claude',
          pluginId: 'installed@claude-market',
          installed: true,
          available: false,
          providerEnabled: true,
          marketplaceName: 'claude-market',
        }),
        expect.objectContaining({
          providerId: 'provider-codex',
          providerName: 'codex',
          pluginId: 'available@codex-market',
          name: 'Available',
          description: 'Codex plugin',
          installed: false,
          available: true,
          providerEnabled: false,
          marketplaceName: 'codex-market',
        }),
      ]),
    );
    expect(executor.calls.map((call) => call.argv)).toEqual([
      ['/usr/local/bin/claude', 'plugin', 'list', '--available', '--json'],
    ]);
    expect(appServer.request).toHaveBeenCalledWith({
      argv: ['/usr/local/bin/codex', '-c', 'check_for_update_on_startup=false', 'app-server'],
      env: expect.any(Object),
      method: 'plugin/list',
      params: {},
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
  });

  it('logs Codex marketplace load errors as warnings and still serves the catalog', async () => {
    storage.listProviders.mockResolvedValue({
      items: [codexProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    const loadError = { marketplacePath: '/broken', message: 'invalid manifest' };
    appServer.request.mockResolvedValue({
      ...CODEX_PLUGIN_LIST,
      marketplaceLoadErrors: [loadError],
    });

    const result = await service.listCatalog();

    expect(result.total).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith(
      { providerId: 'provider-codex', warnings: [loadError] },
      'codex plugin catalog loaded with warnings',
    );
  });

  it('loads a Claude catalog larger than 2 MB', async () => {
    storage.listProviders.mockResolvedValue({
      items: [claudeProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    const available = Array.from({ length: 3_000 }, (_, index) => ({
      pluginId: `plugin-${index}@anthropic-plugin-directory`,
      name: `plugin-${index}`,
      description: 'd'.repeat(800),
      marketplaceName: 'anthropic-plugin-directory',
    }));
    const stdout = JSON.stringify({ installed: [], available });
    expect(stdout.length).toBeGreaterThan(2 * 1024 * 1024);
    executor.enqueueResponse({ type: 'success', stdout });

    const result = await service.listCatalog();

    expect(result.total).toBe(3_000);
  });

  it('serves repeated reads from the short TTL cache', async () => {
    storage.listProviders.mockResolvedValue({
      items: [claudeProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    executor.enqueueResponse({ type: 'success', stdout: CLAUDE_CATALOG });

    await service.listCatalog();
    await service.listCatalog();

    expect(executor.calls).toHaveLength(1);
  });

  it('reloads a provider catalog after the short TTL expires', async () => {
    storage.listProviders.mockResolvedValue({
      items: [claudeProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    executor.enqueueResponse(
      { type: 'success', stdout: CLAUDE_CATALOG },
      { type: 'success', stdout: CLAUDE_CATALOG },
    );
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      await service.listCatalog();
      now = 10_999;
      await service.listCatalog();
      now = 11_001;
      await service.listCatalog();
    } finally {
      nowSpy.mockRestore();
    }

    expect(executor.calls).toHaveLength(2);
  });

  it('refresh bypasses and replaces cached catalog entries', async () => {
    storage.listProviders.mockResolvedValue({
      items: [claudeProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    executor.enqueueResponse(
      { type: 'success', stdout: CLAUDE_CATALOG },
      { type: 'success', stdout: CLAUDE_CATALOG },
    );

    await service.listCatalog();
    await service.refreshCatalog();

    expect(executor.calls).toHaveLength(2);
  });

  it('installs Claude plugins in normal user scope and invalidates that provider cache', async () => {
    storage.listProviders.mockResolvedValue({
      items: [claudeProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    storage.getProvider.mockResolvedValue(claudeProvider);
    executor.enqueueResponse(
      { type: 'success', stdout: CLAUDE_CATALOG },
      { type: 'success' },
      { type: 'success', stdout: CLAUDE_CATALOG },
    );

    await service.listCatalog();
    await expect(service.install(claudeProvider.id, ' sample@claude-market ')).resolves.toEqual({
      success: true,
      providerId: claudeProvider.id,
      providerName: 'claude',
      pluginId: 'sample@claude-market',
    });
    await service.listCatalog();

    expect(executor.calls[1].env).toMatchObject({ DISABLE_AUTOUPDATER: '1' });
    expect(executor.calls[1].argv).toEqual([
      '/usr/local/bin/claude',
      'plugin',
      'install',
      'sample@claude-market',
      '--scope',
      'user',
    ]);
    expect(executor.calls).toHaveLength(3);
  });

  it('uses native Codex plugin add without enable or disable mutations', async () => {
    storage.getProvider.mockResolvedValue(codexProvider);
    executor.enqueueResponse({ type: 'success', stdout: '{}' });

    await service.install(codexProvider.id, 'sample@codex-market');

    expect(executor.calls[0].argv).toEqual([
      '/usr/local/bin/codex',
      '-c',
      'check_for_update_on_startup=false',
      'plugin',
      'add',
      'sample@codex-market',
      '--json',
    ]);
  });

  it('preserves the cached catalog when installation fails', async () => {
    storage.listProviders.mockResolvedValue({
      items: [claudeProvider],
      total: 1,
      limit: 1_000,
      offset: 0,
    });
    storage.getProvider.mockResolvedValue(claudeProvider);
    executor.enqueueResponse(
      { type: 'success', stdout: CLAUDE_CATALOG },
      { type: 'failure', exitCode: 2, stderr: 'provider failure' },
    );

    await service.listCatalog();
    await expect(service.install(claudeProvider.id, 'sample@claude-market')).rejects.toThrow(
      'claude plugin installation failed',
    );
    await service.listCatalog();

    expect(executor.calls).toHaveLength(2);
  });

  it('rejects install when the configured provider lacks the plugin capability', async () => {
    storage.getProvider.mockResolvedValue(unsupportedProvider);

    await expect(service.install(unsupportedProvider.id, 'sample@market')).rejects.toThrow(
      'Provider opencode does not support plugin installation',
    );
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects invalid opaque plugin selectors before invoking the provider', async () => {
    await expect(service.install(claudeProvider.id, 'bad\nselector')).rejects.toThrow(
      'Plugin ID must contain 1 to 512 characters',
    );
    expect(storage.getProvider).not.toHaveBeenCalled();
  });
});
