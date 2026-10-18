import { CodexAdapter } from './codex.adapter';
import { ensureCodexProjectTrusted } from '../utils/codex-config';

jest.mock('../utils/codex-config', () => ({
  ensureCodexProjectTrusted: jest.fn(),
}));

const mockEnsureCodexProjectTrusted = ensureCodexProjectTrusted as jest.MockedFunction<
  typeof ensureCodexProjectTrusted
>;

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
    mockEnsureCodexProjectTrusted.mockReset();
  });

  describe('ProjectProvisioningCapability (project trust)', () => {
    it('delegates project trust with the launch environment', async () => {
      const context = { env: { CODEX_HOME: '/custom/codex-home' } };
      mockEnsureCodexProjectTrusted.mockResolvedValue({ success: true });

      await expect(adapter.provisionProjectPath('/workspace/project', context)).resolves.toEqual({
        success: true,
        warnings: [],
      });

      expect(mockEnsureCodexProjectTrusted).toHaveBeenCalledWith('/workspace/project', context);
    });

    it('returns fixed-code warnings when trust could not be written', async () => {
      mockEnsureCodexProjectTrusted.mockResolvedValue({
        success: false,
        code: 'CODEX_TRUST_CONFIG_INVALID',
        message: 'Codex config contains invalid TOML.',
      });

      await expect(adapter.provisionProjectPath('/workspace/project')).resolves.toEqual({
        success: false,
        warnings: [
          {
            source: 'codex_project_trust',
            level: 'warn',
            code: 'CODEX_TRUST_CONFIG_INVALID',
            message: 'Codex config contains invalid TOML.',
          },
        ],
      });
    });
  });

  describe('launchInitialPromptBehavior', () => {
    it('exposes preKeys with Enter and preDelayMs of 2000', () => {
      expect(adapter.launchInitialPromptBehavior).toBeDefined();
      expect(adapter.launchInitialPromptBehavior.preKeys).toEqual(['Enter']);
      expect(adapter.launchInitialPromptBehavior.preDelayMs).toBe(2000);
    });
  });

  describe('ProviderPluginCapability', () => {
    const plugin = (fields: Record<string, unknown>) => ({
      name: 'plugin',
      version: '1.0.0',
      installed: false,
      enabled: false,
      installPolicy: 'AVAILABLE',
      authPolicy: 'ON_INSTALL',
      availability: 'AVAILABLE',
      interface: null,
      ...fields,
    });

    function parsePluginList(result: unknown) {
      const source = adapter.providerPluginCatalog();
      if (source.transport !== 'app-server') throw new Error('expected the app-server transport');
      return source.parse(result);
    }

    it('reads the catalog through app-server plugin/list and installs with native add', () => {
      expect(adapter.providerPluginCatalog()).toMatchObject({
        transport: 'app-server',
        args: ['app-server'],
        method: 'plugin/list',
        params: {},
      });
      expect(adapter.installProviderPlugin('sample@market')).toEqual([
        'plugin',
        'add',
        'sample@market',
        '--json',
      ]);
    });

    it('maps plugins from every marketplace into the shared plugin contract', () => {
      const { entries } = parsePluginList({
        marketplaces: [
          {
            name: 'openai-curated-remote',
            plugins: [
              plugin({
                id: 'app-6a05@openai-curated-remote',
                name: 'app-6a05',
                installed: true,
                enabled: true,
                interface: {
                  displayName: 'Remote Desktop Commander',
                  shortDescription: 'Control a remote desktop',
                },
              }),
              plugin({ id: 'blocked@openai-curated-remote', availability: 'DISABLED_BY_ADMIN' }),
            ],
          },
          {
            name: 'local',
            plugins: [
              plugin({ id: 'tools@local', name: 'tools', interface: { displayName: null } }),
            ],
          },
        ],
        marketplaceLoadErrors: [],
      });

      expect(entries).toEqual([
        {
          pluginId: 'app-6a05@openai-curated-remote',
          name: 'Remote Desktop Commander',
          description: 'Control a remote desktop',
          marketplaceName: 'openai-curated-remote',
          version: '1.0.0',
          installed: true,
          available: true,
          providerEnabled: true,
          installationScopes: [],
          installCount: null,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
        },
        expect.objectContaining({
          pluginId: 'blocked@openai-curated-remote',
          name: 'plugin',
          available: false,
        }),
        expect.objectContaining({
          pluginId: 'tools@local',
          name: 'tools',
          description: null,
          marketplaceName: 'local',
          available: true,
        }),
      ]);
    });

    it('keeps one entry per plugin ID: the installed one, else the first', () => {
      const { entries } = parsePluginList({
        marketplaces: [
          {
            name: 'market',
            plugins: [
              plugin({ id: 'twice@market', version: '1.0.0' }),
              plugin({ id: 'twice@market', version: '2.0.0' }),
              plugin({ id: 'installed-later@market', version: '1.0.0' }),
              plugin({ id: 'installed-later@market', version: '2.0.0', installed: true }),
            ],
          },
        ],
      });

      expect(entries.map(({ pluginId, version }) => ({ pluginId, version }))).toEqual([
        { pluginId: 'twice@market', version: '1.0.0' },
        { pluginId: 'installed-later@market', version: '2.0.0' },
      ]);
    });

    it('returns marketplace load errors as warnings next to the loaded entries', () => {
      const loadError = { marketplacePath: '/broken', message: 'invalid manifest' };

      const result = parsePluginList({
        marketplaces: [{ name: 'market', plugins: [plugin({ id: 'ok@market' })] }],
        marketplaceLoadErrors: [loadError],
      });

      expect(result.entries).toHaveLength(1);
      expect(result.warnings).toEqual([loadError]);
    });

    it('rejects a result without a marketplace list', () => {
      expect(() => parsePluginList({})).toThrow('codex plugin/list is missing marketplaces');
    });
  });

  describe('addMcpServer', () => {
    it('builds command with default alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(args).toEqual(['mcp', 'add', '--url', 'http://127.0.0.1:3000/mcp', 'codex']);
    });

    it('builds command with custom alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(args).toEqual(['mcp', 'add', '--url', 'http://127.0.0.1:3000/mcp', 'devchain']);
    });

    it('includes extra args when provided', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
        extraArgs: ['--force', '--verbose'],
      });

      expect(args).toEqual([
        'mcp',
        'add',
        '--url',
        'http://127.0.0.1:3000/mcp',
        'devchain',
        '--force',
        '--verbose',
      ]);
    });
  });

  describe('listMcpServers', () => {
    it('builds list command', () => {
      const args = adapter.listMcpServers();
      expect(args).toEqual(['mcp', 'list']);
    });
  });

  describe('removeMcpServer', () => {
    it('builds remove command with alias', () => {
      const args = adapter.removeMcpServer('devchain');
      expect(args).toEqual(['mcp', 'remove', 'devchain']);
    });
  });

  describe('buildLaunchArgs', () => {
    const LAUNCH_OVERRIDES = [
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'tui.alternate_screen="never"',
    ];

    it.each(['new', 'restore'] as const)(
      'puts the update and inline-screen overrides after profile args for %s',
      (mode) => {
        const result = adapter.buildLaunchArgs({
          mode,
          providerSessionId: 'abc',
          profileOptionArgs: ['-m', 'o3', '-c', 'check_for_update_on_startup=true'],
        });
        expect(result.argv).toEqual([
          ...(mode === 'restore' ? ['resume'] : []),
          '-m',
          'o3',
          '-c',
          'check_for_update_on_startup=true',
          ...LAUNCH_OVERRIDES,
          ...(mode === 'restore' ? ['abc'] : []),
        ]);
      },
    );
  });

  describe('EffortCapability', () => {
    it('injects `-c model_reasoning_effort=<value>` into the args', () => {
      const { argv } = adapter.applyEffort(['-m', 'o3'], {}, 'high');
      expect(argv).toEqual(['-c', 'model_reasoning_effort=high', '-m', 'o3']);
    });

    it('strips a conflicting raw `-c model_reasoning_effort=...` before injecting (deterministic)', () => {
      const { argv } = adapter.applyEffort(
        ['-c', 'model_reasoning_effort=low', '-m', 'o3'],
        {},
        'high',
      );
      expect(argv).toEqual(['-c', 'model_reasoning_effort=high', '-m', 'o3']);
      // exactly one occurrence of the key survives
      expect(argv.filter((t) => t.startsWith('model_reasoning_effort='))).toEqual([
        'model_reasoning_effort=high',
      ]);
    });

    it('KEY-TARGETED strip preserves the update-check prelude and unrelated user `-c` keys', () => {
      // Simulate profileOptionArgs that already carry the forced prelude key AND
      // an unrelated user `-c`; only the effort key may be rewritten.
      const { argv } = adapter.applyEffort(
        [
          '-c',
          'check_for_update_on_startup=false',
          '-c',
          'sandbox_mode=danger-full-access',
          '-c',
          'model_reasoning_effort=low',
        ],
        {},
        'high',
      );
      expect(argv).toContain('check_for_update_on_startup=false');
      expect(argv).toContain('sandbox_mode=danger-full-access');
      expect(argv.filter((t) => t.startsWith('model_reasoning_effort='))).toEqual([
        'model_reasoning_effort=high',
      ]);
    });

    it('returns env unchanged', () => {
      const env = { FOO: 'bar' };
      expect(adapter.applyEffort([], env, 'low').env).toBe(env);
    });

    it('places update policy after effort args for new sessions', () => {
      // Launch policy remains authoritative after effort injection.
      const withEffort = adapter.applyEffort(['-m', 'o3'], {}, 'high').argv;
      const { argv } = adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: withEffort });
      expect(argv).toEqual([
        '-c',
        'model_reasoning_effort=high',
        '-m',
        'o3',
        '-c',
        'check_for_update_on_startup=false',
        '-c',
        'tui.alternate_screen="never"',
      ]);
    });

    it('places update policy after effort args and before the resume ID', () => {
      const withEffort = adapter.applyEffort(['-m', 'o3'], {}, 'high').argv;
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'sess-1',
        profileOptionArgs: withEffort,
      });
      expect(argv).toEqual([
        'resume',
        '-c',
        'model_reasoning_effort=high',
        '-m',
        'o3',
        '-c',
        'check_for_update_on_startup=false',
        '-c',
        'tui.alternate_screen="never"',
        'sess-1',
      ]);
    });
  });

  describe('parseListOutput', () => {
    it('parses output with multiple entries', () => {
      const stdout = `devchain  http://127.0.0.1:3000/mcp
server2  http://127.0.0.1:4000/mcp`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
      });
      expect(entries[1]).toEqual({
        alias: 'server2',
        endpoint: 'http://127.0.0.1:4000/mcp',
      });
    });

    it('skips header lines', () => {
      const stdout = `Alias     Endpoint
devchain  http://127.0.0.1:3000/mcp`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0].alias).toBe('devchain');
    });

    it('handles empty output', () => {
      const stdout = '';
      const entries = adapter.parseListOutput(stdout);
      expect(entries).toEqual([]);
    });

    it('handles output with empty lines', () => {
      const stdout = `
devchain  http://127.0.0.1:3000/mcp

server2  http://127.0.0.1:4000/mcp
`;
      const entries = adapter.parseListOutput(stdout);
      expect(entries).toHaveLength(2);
    });
  });
});
