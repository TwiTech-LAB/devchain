import { CodexAdapter } from './codex.adapter';

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  describe('providerName', () => {
    it('returns codex as provider name', () => {
      expect(adapter.providerName).toBe('codex');
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
    const UPDATE_OVERRIDE = ['-c', 'check_for_update_on_startup=false'];

    it('prepends the update-check override before profileOptionArgs for mode new', () => {
      const result = adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: ['-m', 'o3'] });
      expect(result.argv).toEqual([...UPDATE_OVERRIDE, '-m', 'o3']);
    });

    it('returns only the update-check override for mode new with no profileOptionArgs', () => {
      const result = adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: [] });
      expect(result.argv).toEqual([...UPDATE_OVERRIDE]);
    });

    it('leads with the override, then resume, with session ID LAST for mode restore', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'abc',
        profileOptionArgs: ['-m', 'o3', '-p', 'work'],
      });
      expect(result.argv).toEqual([...UPDATE_OVERRIDE, 'resume', '-m', 'o3', '-p', 'work', 'abc']);
    });

    it('restore with no profileOptionArgs yields [override, resume, sessionId]', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'xyz',
        profileOptionArgs: [],
      });
      expect(result.argv).toEqual([...UPDATE_OVERRIDE, 'resume', 'xyz']);
    });

    it('places the DevChain override before any profile-supplied -c so the profile can override (last-wins)', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'new',
        profileOptionArgs: ['-c', 'check_for_update_on_startup=true'],
      });
      // Our forced `false` leads; a profile that re-adds the key trails it.
      expect(result.argv).toEqual([
        '-c',
        'check_for_update_on_startup=false',
        '-c',
        'check_for_update_on_startup=true',
      ]);
      expect(result.argv.indexOf('check_for_update_on_startup=false')).toBeLessThan(
        result.argv.lastIndexOf('check_for_update_on_startup=true'),
      );
    });
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

    it('final three-layer argv ordering — new: [prelude, ...args-with-effort]', () => {
      // buildLaunchArgs prepends the prelude; applyEffort output is the middle.
      const withEffort = adapter.applyEffort(['-m', 'o3'], {}, 'high').argv;
      const { argv } = adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: withEffort });
      expect(argv).toEqual([
        '-c',
        'check_for_update_on_startup=false',
        '-c',
        'model_reasoning_effort=high',
        '-m',
        'o3',
      ]);
    });

    it('final three-layer argv ordering — restore: [prelude, resume, ...args-with-effort, sessionId]', () => {
      const withEffort = adapter.applyEffort(['-m', 'o3'], {}, 'high').argv;
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'sess-1',
        profileOptionArgs: withEffort,
      });
      expect(argv).toEqual([
        '-c',
        'check_for_update_on_startup=false',
        'resume',
        '-c',
        'model_reasoning_effort=high',
        '-m',
        'o3',
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
