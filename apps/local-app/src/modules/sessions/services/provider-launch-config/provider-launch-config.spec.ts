import { resolve, type LaunchConfigInput } from './provider-launch-config.service';
import { ClaudeAdapter } from '../../../providers/adapters/claude.adapter';
import { CodexAdapter } from '../../../providers/adapters/codex.adapter';
import { OpencodeAdapter } from '../../../providers/adapters/opencode.adapter';

function makeInput(overrides: Partial<LaunchConfigInput> = {}): LaunchConfigInput {
  return {
    mode: 'new',
    adapter: new CodexAdapter(),
    profileOptions: null,
    modelOverride: null,
    providerBinPath: '/usr/bin/codex',
    providerEnv: null,
    configEnv: null,
    provider: {},
    ...overrides,
  };
}

describe('ProviderLaunchConfig.resolve', () => {
  describe('option parsing', () => {
    // Use a pass-through adapter (OpenCode new-mode) so these assert parsing in
    // isolation, without an adapter's own launch-arg injection (e.g. Codex's
    // update-check override, covered in codex.adapter.spec.ts).
    it('returns empty argv from null profile options', () => {
      const result = resolve(makeInput({ adapter: new OpencodeAdapter() }));
      expect(result.argv).toEqual([]);
    });

    it('parses profile options into argv tokens', () => {
      const result = resolve(
        makeInput({ adapter: new OpencodeAdapter(), profileOptions: '--model opus --verbose' }),
      );
      expect(result.argv).toEqual(['--model', 'opus', '--verbose']);
    });

    it('throws ProfileOptionsError for unterminated quotes', () => {
      expect(() => resolve(makeInput({ profileOptions: '"unterminated' }))).toThrow(
        'unterminated quote',
      );
    });
  });

  describe('DevChain-owned launch overlays', () => {
    it('places provider options before profile options for new and restore Claude launches', () => {
      const common = {
        adapter: new ClaudeAdapter(),
        providerBinPath: '/usr/bin/claude',
        profileOptions: '--model opus --verbose',
        providerOptionArgs: ['--settings', '/private/revision.json'],
      };

      expect(resolve(makeInput(common)).argv).toEqual([
        '--settings',
        '/private/revision.json',
        '--model',
        'opus',
        '--verbose',
      ]);
      expect(
        resolve(
          makeInput({
            ...common,
            mode: 'restore',
            providerSessionId: 'claude-session',
          }),
        ).argv,
      ).toEqual([
        '--resume',
        'claude-session',
        '--settings',
        '/private/revision.json',
        '--model',
        'opus',
        '--verbose',
      ]);
    });

    it('gives runtime env precedence without changing configurable env', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerEnv: { DEVCHAIN_STATUSLINE_LOCATOR: 'user', KEEP: 'provider' },
          configEnv: { KEEP: 'config' },
          runtimeEnv: { DEVCHAIN_STATUSLINE_LOCATOR: '/private/locator.json' },
        }),
      );

      expect(result.env).toEqual({
        DEVCHAIN_STATUSLINE_LOCATOR: '/private/locator.json',
        KEEP: 'config',
      });
    });
  });

  describe('model override injection', () => {
    it('injects model override replacing existing model flag', () => {
      const result = resolve(
        makeInput({ profileOptions: '--model opus', modelOverride: 'sonnet' }),
      );
      expect(result.argv).toContain('sonnet');
      expect(result.argv).not.toContain('opus');
    });

    it('skips model override when null', () => {
      const result = resolve(makeInput({ profileOptions: '--model opus', modelOverride: null }));
      expect(result.argv).toContain('opus');
    });
  });

  describe('effort injection (EffortCapability)', () => {
    it('injects the adapter native effort form when effortOverride is set', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerBinPath: '/usr/bin/claude',
          effortOverride: 'high',
        }),
      );
      expect(result.argv).toEqual(expect.arrayContaining(['--effort', 'high']));
    });

    it('strips a conflicting raw effort flag then injects the structured value (UI never lies)', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerBinPath: '/usr/bin/claude',
          profileOptions: '--effort low',
          effortOverride: 'high',
        }),
      );
      expect(result.argv).toContain('high');
      expect(result.argv).not.toContain('low');
    });

    it('passes raw effort options through byte-identical when effortOverride is null (escape hatch)', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerBinPath: '/usr/bin/claude',
          profileOptions: '--effort low --verbose',
          effortOverride: null,
        }),
      );
      // applyEffort never runs → raw options are untouched.
      expect(result.argv).toEqual(['--effort', 'low', '--verbose']);
    });

    it('ignores effortOverride for a non-effort-capable adapter (no applyEffort)', () => {
      // A bare adapter without applyEffort (e.g. agy) — effort must pass through.
      const bareAdapter = {
        providerName: 'agy',
        buildLaunchArgs: ({ profileOptionArgs }: { profileOptionArgs: string[] }) => ({
          argv: [...profileOptionArgs],
        }),
      } as unknown as LaunchConfigInput['adapter'];
      const result = resolve(
        makeInput({
          adapter: bareAdapter,
          profileOptions: '--effort low',
          effortOverride: 'high',
        }),
      );
      expect(result.argv).toEqual(['--effort', 'low']);
    });

    it('applies effort without changing the effective model', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerBinPath: '/usr/bin/claude',
          profileOptions: '--model opus',
          effortOverride: 'high',
          provider: {},
        }),
      );
      expect(result.argv).toEqual(expect.arrayContaining(['--effort', 'high']));
      expect(result.argv).toEqual(expect.arrayContaining(['--model', 'opus']));
    });
  });

  describe('effort as env overlay (OpenCode)', () => {
    const OVERLAY = 'OPENCODE_CONFIG_CONTENT';

    it('LAUNCH: model + effort produce the OPENCODE_CONFIG_CONTENT overlay in child env', () => {
      const result = resolve(
        makeInput({
          adapter: new OpencodeAdapter(),
          modelOverride: 'anthropic/claude-x',
          effortOverride: 'high',
        }),
      );
      expect(JSON.parse(result.env![OVERLAY])).toEqual({
        provider: {
          anthropic: { models: { 'claude-x': { options: { reasoningEffort: 'high' } } } },
        },
      });
    });

    it('RESTORE parity: the overlay is carried on the restore launch too', () => {
      const result = resolve(
        makeInput({
          mode: 'restore',
          providerSessionId: 'ses_abc',
          adapter: new OpencodeAdapter(),
          modelOverride: 'anthropic/claude-x',
          effortOverride: 'high',
        }),
      );
      expect(result.argv).toEqual(expect.arrayContaining(['--session', 'ses_abc']));
      expect(JSON.parse(result.env![OVERLAY])).toEqual({
        provider: {
          anthropic: { models: { 'claude-x': { options: { reasoningEffort: 'high' } } } },
        },
      });
    });

    it('deep-merges onto configEnv OPENCODE_CONFIG_CONTENT (configEnv wins over providerEnv)', () => {
      const result = resolve(
        makeInput({
          adapter: new OpencodeAdapter(),
          modelOverride: 'anthropic/claude-x',
          effortOverride: 'high',
          providerEnv: { [OVERLAY]: JSON.stringify({ fromProvider: true }) },
          configEnv: { [OVERLAY]: JSON.stringify({ fromConfig: true }) },
        }),
      );
      const parsed = JSON.parse(result.env![OVERLAY]);
      // configEnv's OPENCODE_CONFIG_CONTENT shadows providerEnv's (config precedence),
      // then the effort overlay deep-merges onto it.
      expect(parsed.fromConfig).toBe(true);
      expect(parsed.fromProvider).toBeUndefined();
      expect(parsed.provider.anthropic.models['claude-x'].options.reasoningEffort).toBe('high');
    });

    it('fail-fast: effort active with no resolvable model → throws (ValidationError)', () => {
      expect(() =>
        resolve(
          makeInput({
            adapter: new OpencodeAdapter(),
            modelOverride: null,
            profileOptions: null,
            effortOverride: 'high',
          }),
        ),
      ).toThrow(/requires a model/);
    });
  });

  describe('initialPrompt threading (opt-in seeding)', () => {
    function spyAdapter() {
      const buildLaunchArgs = jest.fn().mockReturnValue({ argv: [] });
      return {
        adapter: { providerName: 'spy', buildLaunchArgs },
        buildLaunchArgs,
      };
    }

    it('threads initialPrompt into buildLaunchArgs', () => {
      const { adapter, buildLaunchArgs } = spyAdapter();
      resolve(
        makeInput({
          adapter: adapter as unknown as LaunchConfigInput['adapter'],
          initialPrompt: 'do the thing',
        }),
      );
      expect(buildLaunchArgs).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'new', initialPrompt: 'do the thing' }),
      );
    });

    it('passes initialPrompt undefined when not supplied (default paste path)', () => {
      const { adapter, buildLaunchArgs } = spyAdapter();
      resolve(makeInput({ adapter: adapter as unknown as LaunchConfigInput['adapter'] }));
      expect(buildLaunchArgs).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: undefined }),
      );
    });
  });

  describe('sessionId threading (deterministic launch binding)', () => {
    function spyAdapter() {
      const buildLaunchArgs = jest.fn().mockReturnValue({ argv: [] });
      return {
        adapter: { providerName: 'spy', buildLaunchArgs },
        buildLaunchArgs,
      };
    }

    it('threads sessionId into buildLaunchArgs for a new launch', () => {
      const { adapter, buildLaunchArgs } = spyAdapter();
      resolve(
        makeInput({
          adapter: adapter as unknown as LaunchConfigInput['adapter'],
          sessionId: 'sess-uuid-123',
        }),
      );
      expect(buildLaunchArgs).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'new', sessionId: 'sess-uuid-123' }),
      );
    });

    it('passes sessionId undefined when not supplied', () => {
      const { adapter, buildLaunchArgs } = spyAdapter();
      resolve(makeInput({ adapter: adapter as unknown as LaunchConfigInput['adapter'] }));
      expect(buildLaunchArgs).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: undefined }),
      );
    });
  });

  describe('COPILOT_HOME guard — strip ambient + reject explicit (R4, two mechanisms)', () => {
    // Mirrors CopilotAdapter: BOTH surfaces declared.
    function copilotAdapter() {
      return {
        providerName: 'copilot',
        launchUnsetEnv: ['COPILOT_HOME'],
        launchRejectEnv: ['COPILOT_HOME'],
        buildLaunchArgs: jest.fn().mockReturnValue({ argv: [] }),
      } as unknown as LaunchConfigInput['adapter'];
    }

    it('strips ambient/inherited COPILOT_HOME via `env -u` even with NO explicit env', () => {
      const result = resolve(
        makeInput({ adapter: copilotAdapter(), providerBinPath: '/usr/bin/copilot' }),
      );
      // The spawned child env never inherits an ambient COPILOT_HOME.
      expect(result.commandArgs.slice(0, 3)).toEqual(['env', '-u', 'COPILOT_HOME']);
      expect(result.commandArgs).toContain('/usr/bin/copilot');
    });

    it('throws when an EXPLICIT COPILOT_HOME is present in provider env (before process start)', () => {
      expect(() =>
        resolve(makeInput({ adapter: copilotAdapter(), providerEnv: { COPILOT_HOME: '/tmp/x' } })),
      ).toThrow(/COPILOT_HOME is not supported/);
    });

    it('throws when an EXPLICIT COPILOT_HOME is present in config env', () => {
      expect(() =>
        resolve(makeInput({ adapter: copilotAdapter(), configEnv: { COPILOT_HOME: '/tmp/x' } })),
      ).toThrow(/COPILOT_HOME is not supported/);
    });

    it('does not throw when no rejected key is present (still strips ambient)', () => {
      expect(() =>
        resolve(makeInput({ adapter: copilotAdapter(), providerEnv: { OTHER: 'ok' } })),
      ).not.toThrow();
    });

    it('ignores rejected keys for adapters that do not declare launchRejectEnv', () => {
      expect(() => resolve(makeInput({ providerEnv: { COPILOT_HOME: '/tmp/x' } }))).not.toThrow();
    });
  });

  describe('env composition — non-capability provider', () => {
    it('returns null env when no env vars', () => {
      const result = resolve(makeInput());
      expect(result.env).toBeNull();
    });

    it('merges provider env and config env (config wins)', () => {
      const result = resolve(
        makeInput({
          providerEnv: { KEY1: 'provider', KEY2: 'provider' },
          configEnv: { KEY2: 'config' },
        }),
      );
      expect(result.env).toEqual({ KEY1: 'provider', KEY2: 'config' });
    });
  });

  describe('DevChain context-window policy', () => {
    const contextWindowKey = 'DEVCHAIN_CONTEXT_WINDOW_TOKENS';

    function passThroughAdapter(providerName: string): LaunchConfigInput['adapter'] {
      return {
        providerName,
        buildLaunchArgs: ({ profileOptionArgs }) => ({ argv: profileOptionArgs }),
      } as LaunchConfigInput['adapter'];
    }

    it.each(['claude', 'opencode', 'codex', 'copilot', 'agy'])(
      'binds a config-level override to the effective model for %s without forwarding it',
      (providerName) => {
        const result = resolve(
          makeInput({
            adapter: passThroughAdapter(providerName),
            profileOptions: `--model ${providerName}/model`,
            providerEnv: { KEEP_PROVIDER: 'provider' },
            configEnv: {
              KEEP_CONFIG: 'config',
              [contextWindowKey]: '750000',
            },
          }),
        );

        expect(result.contextWindowOverride).toEqual({
          modelId: `${providerName}/model`,
          contextWindowTokens: 750_000,
        });
        expect(result.env).toEqual({
          KEEP_PROVIDER: 'provider',
          KEEP_CONFIG: 'config',
        });
        expect(result.commandArgs).toEqual(expect.arrayContaining(['-u', contextWindowKey]));
        expect(result.commandArgs.some((arg) => arg.startsWith(`${contextWindowKey}=`))).toBe(
          false,
        );
      },
    );

    it('ignores the key from provider-level env even when it is valid', () => {
      const result = resolve(
        makeInput({
          profileOptions: '--model known-model',
          providerEnv: { [contextWindowKey]: '1000000', KEEP: 'value' },
        }),
      );

      expect(result.contextWindowOverride).toBeNull();
      expect(result.env).toEqual({ KEEP: 'value' });
    });

    it('binds to the structured effective model after it replaces raw options', () => {
      const result = resolve(
        makeInput({
          profileOptions: '--model raw-model',
          modelOverride: 'resolved-model',
          configEnv: { [contextWindowKey]: '1000000' },
        }),
      );

      expect(result.contextWindowOverride).toEqual({
        modelId: 'resolved-model',
        contextWindowTokens: 1_000_000,
      });
    });

    it.each(['', '0', '-1', '1.5', '10000001', '9007199254740992'])(
      'ignores invalid config value %j without blocking launch',
      (value) => {
        expect(() =>
          resolve(
            makeInput({
              profileOptions: '--model known-model',
              configEnv: { [contextWindowKey]: value, KEEP: 'value' },
            }),
          ),
        ).not.toThrow();

        const result = resolve(
          makeInput({
            profileOptions: '--model known-model',
            configEnv: { [contextWindowKey]: value, KEEP: 'value' },
          }),
        );
        expect(result.contextWindowOverride).toBeNull();
        expect(result.env).toEqual({ KEEP: 'value' });
      },
    );

    it('does not bind a valid value when no effective model is resolved', () => {
      const result = resolve(makeInput({ configEnv: { [contextWindowKey]: '1000000' } }));

      expect(result.contextWindowOverride).toBeNull();
    });
  });

  describe('env composition — HookCapability (Claude)', () => {
    it('merges hook env with provider/config env (hookEnv < providerEnv < configEnv)', () => {
      const adapter = new ClaudeAdapter();
      const result = resolve(
        makeInput({
          adapter,
          providerBinPath: '/usr/bin/claude',
          providerEnv: { MY_KEY: 'fromProvider' },
          configEnv: null,
          hookContext: {
            apiUrl: 'http://127.0.0.1:3000',
            projectId: 'p1',
            agentId: 'a1',
            sessionId: 's1',
            tmuxSessionName: 'tmux1',
          },
        }),
      );
      expect(result.env).toMatchObject({
        DEVCHAIN_API_URL: 'http://127.0.0.1:3000',
        DEVCHAIN_PROJECT_ID: 'p1',
        DEVCHAIN_SESSION_ID: 's1',
        MY_KEY: 'fromProvider',
      });
    });
  });

  describe('env composition — AutoCompactCapability (Claude)', () => {
    it('injects only the standard auto-compact threshold', () => {
      const adapter = new ClaudeAdapter();
      const result = resolve(
        makeInput({
          adapter,
          providerBinPath: '/usr/bin/claude',
          profileOptions: '--model opus',
          provider: { autoCompactThreshold: 95 },
        }),
      );
      expect(result.argv).toEqual(['--model', 'opus']);
      expect(result.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('95');
    });

    it('preserves explicit Claude env values', () => {
      const adapter = new ClaudeAdapter();
      const result = resolve(
        makeInput({
          adapter,
          providerBinPath: '/usr/bin/claude',
          providerEnv: {
            CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '72',
          },
          provider: { autoCompactThreshold: 95 },
        }),
      );
      expect(result.env).toMatchObject({
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '72',
      });
    });

    it('does not inject a model when none is configured', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerBinPath: '/usr/bin/claude',
          provider: { autoCompactThreshold: 95 },
        }),
      );

      expect(result.argv).toEqual([]);
    });

    it('passes an explicit [1m] model through unchanged', () => {
      const result = resolve(
        makeInput({
          adapter: new ClaudeAdapter(),
          providerBinPath: '/usr/bin/claude',
          profileOptions: '--model claude-opus-4-6[1m]',
          provider: {},
        }),
      );

      expect(result.argv).toEqual(['--model', 'claude-opus-4-6[1m]']);
    });
  });

  describe('command building', () => {
    it('builds command with env prefix when env vars present', () => {
      const result = resolve(makeInput({ providerEnv: { KEY: 'val' } }));
      expect(result.commandArgs[0]).toBe('env');
      expect(result.commandArgs).toContain('KEY=val');
      expect(result.commandArgs).toContain('/usr/bin/codex');
    });

    it('unsets the reserved DevChain key even when no explicit env vars exist', () => {
      const result = resolve(makeInput());
      expect(result.commandArgs).toEqual([
        'env',
        '-u',
        'DEVCHAIN_CONTEXT_WINDOW_TOKENS',
        '/usr/bin/codex',
        ...result.argv,
      ]);
    });
  });

  describe('launch mode', () => {
    it('builds restore argv with provider session ID', () => {
      const result = resolve(
        makeInput({
          mode: 'restore',
          providerSessionId: 'prov-sess-123',
        }),
      );
      expect(result.argv).toContain('resume');
      expect(result.argv).toContain('prov-sess-123');
    });
  });

  describe('prompt handshake', () => {
    it('returns prompt handshake from adapter', () => {
      const adapter = new ClaudeAdapter();
      const result = resolve(makeInput({ adapter, providerBinPath: '/usr/bin/claude' }));
      expect(result.promptHandshake).toEqual({ preKeys: ['Enter'], preDelayMs: 2000 });
    });

    it('returns undefined for adapters without handshake', () => {
      const result = resolve(makeInput({ adapter: new OpencodeAdapter() }));
      expect(result.promptHandshake).toBeUndefined();
    });
  });

  describe('no Claude-specific names in module', () => {
    it('module source does not contain Claude-specific strings', async () => {
      const fs = await import('fs/promises');
      const source = await fs.readFile(
        require.resolve('./provider-launch-config.service'),
        'utf-8',
      );
      expect(source).not.toContain("'claude'");
      expect(source).not.toContain("'opus'");
      expect(source).not.toContain("'1m'");
      expect(source).not.toContain('DEVCHAIN_');
    });
  });
});
