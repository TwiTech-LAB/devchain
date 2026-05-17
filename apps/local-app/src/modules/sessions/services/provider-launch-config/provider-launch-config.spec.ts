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
    it('returns empty argv from null profile options', () => {
      const result = resolve(makeInput());
      expect(result.argv).toEqual([]);
    });

    it('parses profile options into argv tokens', () => {
      const result = resolve(makeInput({ profileOptions: '--model opus --verbose' }));
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
