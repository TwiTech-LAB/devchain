import { CodexAdapter } from './codex.adapter';
import { ensureCodexProjectTrusted } from '../../sessions/utils/codex-config';

jest.mock('../../sessions/utils/codex-config', () => ({
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

  describe('providerName', () => {
    it('returns codex as provider name', () => {
      expect(adapter.providerName).toBe('codex');
    });
  });

  describe('ProjectProvisioningCapability (project trust)', () => {
    it('declares requiresProjectProvisioning', () => {
      expect(adapter.requiresProjectProvisioning).toBe(true);
    });

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
    it('uses the JSON catalog and native add commands', () => {
      expect(adapter.listProviderPlugins()).toEqual(['plugin', 'list', '--available', '--json']);
      expect(adapter.installProviderPlugin('sample@market')).toEqual([
        'plugin',
        'add',
        'sample@market',
        '--json',
      ]);
    });

    it('normalizes the Codex catalog fields into the shared plugin contract', () => {
      const entries = adapter.parseProviderPluginCatalog(
        JSON.stringify({
          installed: [
            {
              pluginId: 'installed@market',
              name: 'installed',
              marketplaceName: 'market',
              version: '2.0.0',
              installed: true,
              enabled: true,
              installPolicy: 'AVAILABLE',
              authPolicy: 'ON_INSTALL',
            },
          ],
          available: [
            {
              pluginId: 'available@market',
              name: 'available',
              marketplaceName: 'market',
              version: '1.0.0',
              installed: false,
              enabled: false,
              installPolicy: 'AVAILABLE',
              authPolicy: 'ON_INSTALL',
            },
          ],
        }),
      );

      expect(entries).toEqual([
        {
          pluginId: 'available@market',
          name: 'available',
          description: null,
          marketplaceName: 'market',
          version: '1.0.0',
          installed: false,
          available: true,
          providerEnabled: false,
          installationScopes: [],
          installCount: null,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
        },
        {
          pluginId: 'installed@market',
          name: 'installed',
          description: null,
          marketplaceName: 'market',
          version: '2.0.0',
          installed: true,
          available: false,
          providerEnabled: true,
          installationScopes: [],
          installCount: null,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
        },
      ]);
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

  describe('binaryCheck', () => {
    it('builds check command with alias', () => {
      const args = adapter.binaryCheck('devchain');
      expect(args).toEqual(['mcp', 'check', 'devchain']);
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

    it.each(['new', 'restore'] as const)(
      'adds the update and inline-screen overrides without profile args for %s',
      (mode) => {
        expect(
          adapter.buildLaunchArgs({ mode, providerSessionId: 'abc', profileOptionArgs: [] }).argv,
        ).toEqual([
          ...(mode === 'restore' ? ['resume'] : []),
          ...LAUNCH_OVERRIDES,
          ...(mode === 'restore' ? ['abc'] : []),
        ]);
      },
    );
  });

  describe('EffortCapability', () => {
    it('exposes the seeded default effort values (static metadata)', () => {
      expect(adapter.defaultEffortValues).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    });

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

    it('never blanket-strips `-c`: a lone unrelated `-c` pair survives untouched', () => {
      const { argv } = adapter.applyEffort(['-c', 'hide_agent_reasoning=true'], {}, 'medium');
      expect(argv).toEqual([
        '-c',
        'model_reasoning_effort=medium',
        '-c',
        'hide_agent_reasoning=true',
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
    it('parses output with single entry', () => {
      const stdout = 'devchain  http://127.0.0.1:3000/mcp';
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
      });
    });

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
