import { TerminalIOService } from './terminal-io.service';
import { FakeProcessExecutor } from '../process-executor/fake-process-executor';
import { TypeCommandFailedError } from './delivery';

describe('TerminalIOService', () => {
  let fake: FakeProcessExecutor;
  let svc: TerminalIOService;

  beforeEach(() => {
    fake = new FakeProcessExecutor();
    svc = new TerminalIOService(fake);
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  describe('createSession', () => {
    it('sends correct tmux argv for new-session, set-option status, and set-clipboard', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      const target = await svc.createSession('my-session', ['bash'], { cwd: '/tmp' });

      expect(target).toEqual({ name: 'my-session' });
      expect(fake.calls).toHaveLength(3);
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'new-session',
        '-d',
        '-s',
        'my-session',
        '-c',
        '/tmp',
        'bash',
      ]);
      expect(fake.calls[0].mode).toBe('pipe');
      expect(fake.calls[1].argv).toEqual([
        'tmux',
        'set-option',
        '-t',
        'my-session',
        'status',
        'off',
      ]);
      expect(fake.calls[2].argv).toEqual(['tmux', 'set-option', '-s', 'set-clipboard', 'on']);
    });

    it('throws on create failure', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'duplicate session' });

      await expect(svc.createSession('dup', ['bash'], { cwd: '/tmp' })).rejects.toThrow(
        /Failed to create tmux session/,
      );
    });

    it('passes env to ProcessExecutor', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.createSession('s', ['cmd'], { cwd: '/w', env: { FOO: 'bar' } });

      expect(fake.calls[0].env).toEqual({ FOO: 'bar' });
    });
  });

  describe('destroySession', () => {
    it('sends kill-session with exact-match prefix', async () => {
      fake.enqueueResponse({ type: 'success' });

      await svc.destroySession({ name: 'my-session' });

      expect(fake.calls[0].argv).toEqual(['tmux', 'kill-session', '-t', '=my-session']);
    });

    it('throws on destroy failure', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'no such session' });

      await expect(svc.destroySession({ name: 'gone' })).rejects.toThrow(
        /Failed to destroy tmux session/,
      );
    });
  });

  describe('listSessions', () => {
    it('returns devchain_ prefixed sessions', async () => {
      fake.enqueueResponse({
        type: 'success',
        stdout: 'devchain_proj_abc\nother_session\ndevchain_proj_def\n',
      });

      const sessions = await svc.listSessions();

      expect(sessions).toEqual([{ name: 'devchain_proj_abc' }, { name: 'devchain_proj_def' }]);
      expect(fake.calls[0].argv).toEqual(['tmux', 'list-sessions', '-F', '#{session_name}']);
    });

    it('returns empty array on tmux failure (no server)', async () => {
      fake.enqueueResponse({ type: 'failure' });

      const sessions = await svc.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('sessionExists', () => {
    it('returns true when has-session succeeds', async () => {
      fake.enqueueResponse({ type: 'success' });

      const exists = await svc.sessionExists({ name: 'my-session' });

      expect(exists).toBe(true);
      expect(fake.calls[0].argv).toEqual(['tmux', 'has-session', '-t', '=my-session']);
    });

    it('returns false when has-session fails', async () => {
      fake.enqueueResponse({ type: 'failure' });

      const exists = await svc.sessionExists({ name: 'gone' });
      expect(exists).toBe(false);
    });
  });

  // ── Capture ─────────────────────────────────────────────────────────────

  describe('captureHistory', () => {
    it('sends correct argv with escape flag', async () => {
      fake.enqueueResponse({ type: 'success', stdout: 'line1\nline2\n' });

      const result = await svc.captureHistory({ name: 'sess' }, 500);

      expect(result).toEqual({ ok: true, output: 'line1\nline2\n' });
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'capture-pane',
        '-p',
        '-S',
        '-500',
        '-t',
        '=sess:',
        '-e',
      ]);
    });

    it('sends argv without -e when includeEscapes is false', async () => {
      fake.enqueueResponse({ type: 'success', stdout: 'text' });

      await svc.captureHistory({ name: 'sess' }, 100, false);

      expect(fake.calls[0].argv).not.toContain('-e');
    });

    it('retries without -e when option is unknown', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'unknown option -- e' });
      fake.enqueueResponse({ type: 'success', stdout: 'fallback text' });

      const result = await svc.captureHistory({ name: 'sess' }, 100);

      expect(result.ok).toBe(true);
      expect(result.output).toBe('fallback text');
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1].argv).not.toContain('-e');
    });

    it('returns error on capture failure', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'session not found' });

      const result = await svc.captureHistory({ name: 'gone' }, 100);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('session not found');
    });
  });

  describe('captureStrict', () => {
    it('captures without escape sequences', async () => {
      fake.enqueueResponse({ type: 'success', stdout: 'strict output' });

      const result = await svc.captureStrict({ name: 'sess' }, 10);

      expect(result).toEqual({ ok: true, output: 'strict output' });
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'capture-pane',
        '-p',
        '-S',
        '-10',
        '-t',
        '=sess:',
      ]);
    });

    it('returns error result on failure', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'no pane' });

      const result = await svc.captureStrict({ name: 'bad' }, 5);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('no pane');
    });
  });

  describe('getCursorPosition', () => {
    it('parses cursor x y from tmux output', async () => {
      fake.enqueueResponse({ type: 'success', stdout: '12 5\n' });

      const pos = await svc.getCursorPosition({ name: 'sess' });

      expect(pos).toEqual({ x: 12, y: 5 });
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'display-message',
        '-p',
        '-t',
        '=sess:',
        '#{cursor_x} #{cursor_y}',
      ]);
    });

    it('returns null when command fails', async () => {
      fake.enqueueResponse({ type: 'failure' });

      const pos = await svc.getCursorPosition({ name: 'gone' });
      expect(pos).toBeNull();
    });

    it('returns null when output is unparseable', async () => {
      fake.enqueueResponse({ type: 'success', stdout: 'garbage' });

      const pos = await svc.getCursorPosition({ name: 'sess' });
      expect(pos).toBeNull();
    });
  });

  describe('getSessionCwd', () => {
    it('resolves pane id then queries cwd', async () => {
      fake.enqueueResponse({ type: 'success', stdout: '%0\n' });
      fake.enqueueResponse({ type: 'success', stdout: '/home/user/project\n' });

      const cwd = await svc.getSessionCwd({ name: 'sess' });

      expect(cwd).toBe('/home/user/project');
      expect(fake.calls[0].argv).toEqual(['tmux', 'list-panes', '-t', '=sess', '-F', '#{pane_id}']);
      expect(fake.calls[1].argv).toEqual([
        'tmux',
        'display-message',
        '-t',
        '%0',
        '-p',
        '#{pane_current_path}',
      ]);
    });

    it('returns null when list-panes fails', async () => {
      fake.enqueueResponse({ type: 'failure' });

      const cwd = await svc.getSessionCwd({ name: 'gone' });
      expect(cwd).toBeNull();
    });

    it('returns null when pane id format is unexpected', async () => {
      fake.enqueueResponse({ type: 'success', stdout: 'badformat\n' });

      const cwd = await svc.getSessionCwd({ name: 'sess' });
      expect(cwd).toBeNull();
      expect(fake.calls).toHaveLength(1);
    });

    it('returns null when cwd is empty', async () => {
      fake.enqueueResponse({ type: 'success', stdout: '%0\n' });
      fake.enqueueResponse({ type: 'success', stdout: '\n' });

      const cwd = await svc.getSessionCwd({ name: 'sess' });
      expect(cwd).toBeNull();
    });
  });

  // ── Monitoring ──────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns alive true when session exists', async () => {
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.healthCheck({ name: 'sess' });

      expect(result).toEqual({ alive: true });
      expect(fake.calls[0].argv).toEqual(['tmux', 'has-session', '-t', '=sess']);
    });

    it('returns alive false when session is gone', async () => {
      fake.enqueueResponse({ type: 'failure' });

      const result = await svc.healthCheck({ name: 'gone' });
      expect(result).toEqual({ alive: false });
    });
  });

  describe('waitForOutput', () => {
    it('returns true when predicate matches', async () => {
      // baseline capture
      fake.enqueueResponse({ type: 'success', stdout: 'initial' });
      // first poll
      fake.enqueueResponse({ type: 'success', stdout: 'initial with READY marker' });

      const matched = await svc.waitForOutput(
        { name: 'sess' },
        (output) => output.includes('READY'),
        { pollIntervalMs: 10, timeoutMs: 2000 },
      );

      expect(matched).toBe(true);
    });

    it('returns false on timeout when predicate never matches', async () => {
      fake.setDefaultResponse({ type: 'success', stdout: 'nothing here' });

      const matched = await svc.waitForOutput(
        { name: 'sess' },
        (output) => output.includes('NEVER'),
        { pollIntervalMs: 10, timeoutMs: 50 },
      );

      expect(matched).toBe(false);
    }, 5000);

    it('returns false when output settles without predicate match', async () => {
      // baseline
      fake.enqueueResponse({ type: 'success', stdout: '' });
      // poll 1 — changed (outputDetected)
      fake.enqueueResponse({ type: 'success', stdout: 'some output' });
      // poll 2 — skip first
      fake.enqueueResponse({ type: 'success', stdout: 'some output changed' });
      // poll 3+ — settled (same output)
      fake.setDefaultResponse({ type: 'success', stdout: 'some output changed' });

      const matched = await svc.waitForOutput(
        { name: 'sess' },
        (output) => output.includes('NEVER'),
        { pollIntervalMs: 10, timeoutMs: 5000, settleMs: 30 },
      );

      expect(matched).toBe(false);
    }, 10000);
  });

  // ── New surface (T2) ──────────────────────────────────────────────────

  describe('createEmptySession', () => {
    it('sends new-session with no command argv', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      const target = await svc.createEmptySession('sess-1', { cwd: '/tmp' });

      expect(target).toEqual({ name: 'sess-1' });
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'new-session',
        '-d',
        '-s',
        'sess-1',
        '-c',
        '/tmp',
      ]);
    });

    it('returns SessionTarget with name', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      const target = await svc.createEmptySession('my-session');

      expect(target.name).toBe('my-session');
    });

    it('honors env if passed', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.createEmptySession('sess', { cwd: '/home', env: { MY_VAR: 'val' } });

      expect(fake.calls[0].env).toEqual({ MY_VAR: 'val' });
    });

    it('defaults cwd to process.cwd() when omitted', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.createEmptySession('sess');

      expect(fake.calls[0].argv).toContain(process.cwd());
    });
  });

  describe('disableAlternateScreen', () => {
    it('sends correct tmux set-window-option argv', async () => {
      fake.enqueueResponse({ type: 'success' });

      await svc.disableAlternateScreen({ name: 'sess-1' });

      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'set-window-option',
        '-t',
        '=sess-1',
        'alternate-screen',
        'off',
      ]);
      expect(fake.calls[0].mode).toBe('pipe');
    });
  });

  describe('typeCommand', () => {
    it('sends quoted command via send-keys -l then Enter', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.typeCommand({ name: 'sess-1' }, ['claude', '--help']);

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'send-keys',
        '-t',
        '=sess-1:',
        '-l',
        '--',
        "'claude' '--help'",
      ]);
      expect(fake.calls[1].argv).toEqual(['tmux', 'send-keys', '-t', '=sess-1:', 'Enter']);
    });

    it('throws on empty argv', async () => {
      await expect(svc.typeCommand({ name: 'sess' }, [])).rejects.toThrow(/empty argv/);
    });

    it('handles realistic agent CLI invocation', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.typeCommand({ name: 'sess' }, [
        'claude',
        '--continue',
        '--mcp-config',
        '/path/to/config.json',
      ]);

      expect(fake.calls[0].argv[6]).toBe(
        "'claude' '--continue' '--mcp-config' '/path/to/config.json'",
      );
    });

    it('handles args with single quotes', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.typeCommand({ name: 'sess' }, ["it's", 'fine']);

      expect(fake.calls[0].argv[6]).toBe("'it'\\''s' 'fine'");
    });

    it('handles empty string args', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.typeCommand({ name: 'sess' }, ['cmd', '']);

      expect(fake.calls[0].argv[6]).toBe("'cmd' ''");
    });

    it('handles args with shell metachars', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.typeCommand({ name: 'sess' }, ['echo', '$(whoami)']);

      expect(fake.calls[0].argv[6]).toBe("'echo' '$(whoami)'");
    });

    it('honors per-agent gap (two consecutive calls)', async () => {
      fake.setDefaultResponse({ type: 'success' });

      const start = Date.now();
      await svc.typeCommand({ name: 'sess' }, ['cmd1']);
      await svc.typeCommand({ name: 'sess' }, ['cmd2']);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(450);
    }, 10_000);

    it('throws TypeCommandFailedError when literal send fails', async () => {
      fake.enqueueResponse({ type: 'failure', exitCode: 1, stderr: 'session not found' });

      await expect(svc.typeCommand({ name: 'sess' }, ['cmd'])).rejects.toThrow(
        TypeCommandFailedError,
      );

      try {
        fake.enqueueResponse({ type: 'failure', exitCode: 1, stderr: 'gone' });
        await svc.typeCommand({ name: 'sess' }, ['cmd']);
      } catch (e) {
        const err = e as TypeCommandFailedError;
        expect(err.phase).toBe('literal');
        expect(err.sessionName).toBe('sess');
        expect(err.cause).toContain('gone');
      }
    });

    it('throws TypeCommandFailedError when Enter send fails', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'failure', exitCode: 1, stderr: 'session vanished' });

      await expect(svc.typeCommand({ name: 'sess' }, ['cmd'])).rejects.toThrow(
        TypeCommandFailedError,
      );

      try {
        fake.enqueueResponse({ type: 'success' });
        fake.enqueueResponse({ type: 'failure', exitCode: 1, stderr: 'vanished' });
        await svc.typeCommand({ name: 'sess' }, ['cmd']);
      } catch (e) {
        const err = e as TypeCommandFailedError;
        expect(err.phase).toBe('enter');
        expect(err.sessionName).toBe('sess');
      }
    });

    it('throws TypeCommandFailedError on literal send timeout', async () => {
      fake.enqueueResponse({ type: 'timeout' });

      await expect(svc.typeCommand({ name: 'sess' }, ['cmd'])).rejects.toThrow(
        TypeCommandFailedError,
      );

      try {
        fake.enqueueResponse({ type: 'timeout' });
        await svc.typeCommand({ name: 'sess' }, ['cmd']);
      } catch (e) {
        const err = e as TypeCommandFailedError;
        expect(err.phase).toBe('literal');
        expect(err.cause).toBe('timed out');
      }
    });

    it('throws TypeCommandFailedError on Enter send timeout', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'timeout' });

      await expect(svc.typeCommand({ name: 'sess' }, ['cmd'])).rejects.toThrow(
        TypeCommandFailedError,
      );

      try {
        fake.enqueueResponse({ type: 'success' });
        fake.enqueueResponse({ type: 'timeout' });
        await svc.typeCommand({ name: 'sess' }, ['cmd']);
      } catch (e) {
        const err = e as TypeCommandFailedError;
        expect(err.phase).toBe('enter');
        expect(err.cause).toBe('timed out');
      }
    });
  });

  describe('listAllSessionNames', () => {
    it('returns Set of all session names', async () => {
      fake.enqueueResponse({
        type: 'success',
        stdout: 'session1\ndevchain_proj_abc\nmy-other\n',
      });

      const names = await svc.listAllSessionNames();

      expect(names).toEqual(new Set(['session1', 'devchain_proj_abc', 'my-other']));
      expect(fake.calls[0].argv).toEqual(['tmux', 'list-sessions', '-F', '#{session_name}']);
    });

    it('returns empty Set when tmux fails (no sessions)', async () => {
      fake.enqueueResponse({ type: 'failure' });

      const names = await svc.listAllSessionNames();

      expect(names).toEqual(new Set());
    });
  });

  // ── applyWindowTheme ──────────────────────────────────────────────────────

  describe('applyWindowTheme', () => {
    const target = { name: 'devchain_proj_abc' };
    const fg = '#c9d1d9';
    const bg = '#1a1a1a';

    // Layer: backend-unit — FakeProcessExecutor makes exact argv safety directly observable without a real tmux installation.

    it('sends exact set-window-option argv for window-style and window-active-style', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.applyWindowTheme(target, fg, bg);

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'set-window-option',
        '-t',
        `=${target.name}:`,
        'window-style',
        `fg=${fg},bg=${bg}`,
      ]);
      expect(fake.calls[0].mode).toBe('pipe');
      expect(fake.calls[1].argv).toEqual([
        'tmux',
        'set-window-option',
        '-t',
        `=${target.name}:`,
        'window-active-style',
        `fg=${fg},bg=${bg}`,
      ]);
      expect(fake.calls[1].mode).toBe('pipe');
    });

    it('uses per-window set-window-option, not global set-option or set-option -g', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.applyWindowTheme(target, fg, bg);

      for (const call of fake.calls) {
        expect(call.argv[1]).toBe('set-window-option');
        expect(call.argv).not.toContain('-g');
        expect(call.argv).not.toContain('-s');
      }
    });

    it('rejects foreground that is not strict #RRGGBB before making any executor call', async () => {
      await expect(svc.applyWindowTheme(target, 'red', bg)).rejects.toThrow(/foreground/);
      expect(fake.calls).toHaveLength(0);
    });

    it('rejects background that is not strict #RRGGBB before making any executor call', async () => {
      await expect(svc.applyWindowTheme(target, fg, 'rgb(0,0,0)')).rejects.toThrow(/background/);
      expect(fake.calls).toHaveLength(0);
    });

    it('rejects 3-digit shorthand hex', async () => {
      await expect(svc.applyWindowTheme(target, '#fff', bg)).rejects.toThrow(/foreground/);
      expect(fake.calls).toHaveLength(0);
    });

    it('rejects hex without leading #', async () => {
      await expect(svc.applyWindowTheme(target, '1a1a1a', bg)).rejects.toThrow(/foreground/);
      expect(fake.calls).toHaveLength(0);
    });

    it('accepts valid lowercase hex colors', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await expect(svc.applyWindowTheme(target, '#1d2b3a', '#eaeff5')).resolves.toBeUndefined();
    });

    it('accepts valid uppercase hex colors', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await expect(svc.applyWindowTheme(target, '#C9D1D9', '#1A1A1A')).resolves.toBeUndefined();
    });

    it('throws when applying window-style fails and skips active style', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'no such session' });

      await expect(svc.applyWindowTheme(target, fg, bg)).rejects.toThrow(
        /window-style.*no such session/,
      );
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].argv).toContain('window-style');
    });

    it('throws when applying window-active-style fails after window-style succeeds', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'failure', stderr: 'session vanished' });

      await expect(svc.applyWindowTheme(target, fg, bg)).rejects.toThrow(
        /window-active-style.*session vanished/,
      );
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0].argv).toContain('window-style');
      expect(fake.calls[1].argv).toContain('window-active-style');
    });

    it('throws when tmux style command times out', async () => {
      fake.enqueueResponse({ type: 'timeout' });

      await expect(svc.applyWindowTheme(target, fg, bg)).rejects.toThrow(/window-style.*timed out/);
      expect(fake.calls).toHaveLength(1);
    });
  });
});
