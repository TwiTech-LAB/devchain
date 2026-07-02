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
    provider: { oneMillionContextEnabled: false },
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

  describe('env composition — ContextWindowCapability (Claude 1M)', () => {
    it('rewrites model to 1m when oneMillionContextEnabled', () => {
      const adapter = new ClaudeAdapter();
      const result = resolve(
        makeInput({
          adapter,
          providerBinPath: '/usr/bin/claude',
          profileOptions: '--model opus',
          provider: { oneMillionContextEnabled: true },
          hookContext: {
            apiUrl: 'http://127.0.0.1:3000',
            projectId: 'p1',
            agentId: 'a1',
            sessionId: 's1',
            tmuxSessionName: 'tmux1',
          },
        }),
      );
      expect(result.argv.join(' ')).toContain('opus[1m]');
    });

    it('scrubs CLAUDE_CODE_DISABLE_1M_CONTEXT from env', () => {
      const adapter = new ClaudeAdapter();
      const result = resolve(
        makeInput({
          adapter,
          providerBinPath: '/usr/bin/claude',
          providerEnv: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
          provider: { oneMillionContextEnabled: false },
          hookContext: {
            apiUrl: 'http://127.0.0.1:3000',
            projectId: 'p1',
            agentId: 'a1',
            sessionId: 's1',
            tmuxSessionName: 'tmux1',
          },
        }),
      );
      expect(result.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
    });
  });

  describe('command building', () => {
    it('builds command with env prefix when env vars present', () => {
      const result = resolve(makeInput({ providerEnv: { KEY: 'val' } }));
      expect(result.commandArgs[0]).toBe('env');
      expect(result.commandArgs).toContain('KEY=val');
      expect(result.commandArgs).toContain('/usr/bin/codex');
    });

    it('builds command without env prefix when no env vars', () => {
      const result = resolve(makeInput());
      expect(result.commandArgs[0]).toBe('/usr/bin/codex');
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
