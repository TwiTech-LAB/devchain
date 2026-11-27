import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'path';
import { CodexAdapter } from './codex.adapter';
import type { CodexAppServerRequest } from '../services/codex-app-server.client';
import { ensureCodexProjectTrusted } from '../utils/codex-config';
import { parseProfileOptions } from '../utils/profile-options';

jest.mock('../utils/codex-config', () => ({
  ensureCodexProjectTrusted: jest.fn(),
}));

const mockEnsureCodexProjectTrusted = ensureCodexProjectTrusted as jest.MockedFunction<
  typeof ensureCodexProjectTrusted
>;

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;
  const requestFork = jest.fn<Promise<unknown>, [CodexAppServerRequest]>();

  beforeEach(() => {
    requestFork.mockReset();
    adapter = new CodexAdapter({ request: requestFork });
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

  describe('SessionForkCapability', () => {
    const source = {
      providerSessionId: 'parent-thread',
      transcriptPath: resolve('parent.jsonl'),
      projectId: 'project-id',
      projectPath: resolve('project'),
      providerBinPath: resolve('bin', 'codex'),
      sessionId: 'save-point-row-id',
      env: { DEVCHAIN_SESSION_ID: 'session-id' },
      helperEnv: { CODEX_HOME: resolve('profile', 'codex-home') },
    };

    // Unit coverage verifies the JSON-RPC and launch contracts with a fake app-server reply.
    it('makes a silent save with the configured binary and returns the forked thread and path', async () => {
      const path = resolve('saved.jsonl');
      requestFork.mockResolvedValue({ thread: { id: 'save-point-thread', path } });

      await expect(adapter.createSavePoint(source)).resolves.toEqual({
        providerSessionId: 'save-point-thread',
        transcriptPath: path,
        discardUnboundTranscript: expect.any(Function),
      });
      expect(requestFork).toHaveBeenCalledWith({
        argv: [source.providerBinPath, '-c', 'check_for_update_on_startup=false', 'app-server'],
        env: source.helperEnv,
        method: 'thread/fork',
        params: { threadId: source.providerSessionId, excludeTurns: true },
        timeoutMs: expect.any(Number),
        maxOutputBytes: expect.any(Number),
      });
    });

    it.each([
      '--image one.png two.png -- "read the project notes"',
      '"read the project notes" -i one.png',
      '--image=one.png,two.png',
    ])('forks with the child thread ID last and drops %s', async (prompt) => {
      const path = resolve('child.jsonl');
      requestFork.mockResolvedValue({ thread: { id: 'child-thread', path } });

      await expect(
        adapter.prepareForkLaunch({
          ...source,
          providerSessionId: 'save-point-thread',
          transcriptPath: resolve('saved.jsonl'),
          sessionId: 'devchain-row-id',
          profileOptionArgs: parseProfileOptions(
            `--profile work --sandbox=read-only -c model_reasoning_effort=high -m o3 ${prompt}`,
          ),
        }),
      ).resolves.toEqual({
        argv: [
          'resume',
          '--profile',
          'work',
          '--sandbox=read-only',
          '-c',
          'model_reasoning_effort=high',
          '-m',
          'o3',
          '-c',
          'check_for_update_on_startup=false',
          '-c',
          'tui.alternate_screen="never"',
          'child-thread',
        ],
        providerSessionId: 'child-thread',
        transcriptPath: path,
        discardUnboundTranscript: expect.any(Function),
      });
      expect(requestFork).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'thread/fork',
          params: { threadId: 'save-point-thread', excludeTurns: true },
        }),
      );
    });

    it.each([
      { label: 'no thread', reply: {}, error: 'returned no thread' },
      {
        label: 'no persisted path',
        reply: { thread: { id: 'child-thread', path: null } },
        error: 'returned an invalid ID or rollout path',
      },
      {
        label: 'the source ID',
        reply: { thread: { id: source.providerSessionId, path: source.transcriptPath } },
        error: 'returned an invalid ID or rollout path',
      },
    ])('rejects a reply with $label', async ({ reply, error }) => {
      requestFork.mockResolvedValue(reply);
      await expect(adapter.createSavePoint(source)).rejects.toThrow(error);
    });

    // Real files under a temporary home show which rollouts a discard may remove.
    describe('discarding a forked rollout that DevChain did not store', () => {
      const threadId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
      const sourceThread = '0199a213-81c0-7800-8aa1-bbab2a035a52';
      const rolloutName = (id: string) => `rollout-2026-11-26T10-00-00-${id}.jsonl`;
      const rollout = (id: string) =>
        JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/project' } }) + '\n';
      let home: string;
      let day: string;
      let sourceRollout: string;

      beforeEach(async () => {
        home = await mkdtemp(join(os.tmpdir(), 'codex-discard-'));
        jest.spyOn(os, 'homedir').mockReturnValue(home);
        day = join(home, '.codex', 'sessions', '2026', '11', '26');
        await mkdir(day, { recursive: true });
        sourceRollout = join(day, rolloutName(sourceThread));
        await writeFile(sourceRollout, rollout(sourceThread));
      });

      afterEach(async () => {
        jest.restoreAllMocks();
        await rm(home, { recursive: true, force: true });
      });

      async function fork(path: string, id = threadId) {
        requestFork.mockResolvedValue({ thread: { id, path } });
        return adapter.createSavePoint({
          ...source,
          providerSessionId: sourceThread,
          transcriptPath: sourceRollout,
        });
      }
      const exists = (path: string) =>
        readFile(path).then(
          () => true,
          () => false,
        );

      it('removes the forked rollout of the save point and of the fork launch, and keeps the source', async () => {
        const saved = join(day, rolloutName(threadId));
        await writeFile(saved, rollout(threadId));

        await (
          await fork(saved)
        ).discardUnboundTranscript!();
        expect(await exists(saved)).toBe(false);

        await writeFile(saved, rollout(threadId));
        requestFork.mockResolvedValue({ thread: { id: threadId, path: saved } });
        const launch = await adapter.prepareForkLaunch({
          ...source,
          providerSessionId: sourceThread,
          transcriptPath: sourceRollout,
          profileOptionArgs: [],
        });
        await launch.discardUnboundTranscript!();
        expect(await exists(saved)).toBe(false);
        expect(await readFile(sourceRollout, 'utf8')).toBe(rollout(sourceThread));
        // A copy that is already gone needs no removal.
        await expect(launch.discardUnboundTranscript!()).resolves.toBeUndefined();
      });

      it.each([
        {
          label: 'a rollout outside the Codex root',
          place: async () => {
            const outside = join(home, 'elsewhere', rolloutName(threadId));
            await mkdir(dirname(outside), { recursive: true });
            await writeFile(outside, rollout(threadId));
            return outside;
          },
        },
        {
          label: 'a link inside the root to a file outside it',
          place: async () => {
            const outside = join(home, 'secret.jsonl');
            await writeFile(outside, rollout(threadId));
            const link = join(day, rolloutName(threadId));
            await symlink(outside, link);
            return outside;
          },
          returned: () => join(day, rolloutName(threadId)),
        },
        {
          label: 'a rollout whose header names another thread',
          place: async () => {
            const path = join(day, rolloutName(threadId));
            await writeFile(path, rollout(sourceThread));
            return path;
          },
        },
        {
          label: 'a rollout whose file name names another thread',
          place: async () => {
            const path = join(day, rolloutName('0199a213-81c0-7800-8aa1-bbab2a035a59'));
            await writeFile(path, rollout(threadId));
            return path;
          },
        },
        { label: 'the source rollout', place: async () => sourceRollout },
      ])('refuses to remove $label', async ({ place, returned }) => {
        const kept = await place();
        const copy = await fork(returned?.() ?? kept);

        await expect(copy.discardUnboundTranscript!()).rejects.toThrow(
          'Codex rollout was not discarded',
        );
        expect(await exists(kept)).toBe(true);
        expect(await readFile(sourceRollout, 'utf8')).toBe(rollout(sourceThread));
      });
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
