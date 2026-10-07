import { processIdsEnv } from '../../../../common/process-ids-env';
import { TerminalIOService } from './terminal-io.service';
import { FakeProcessExecutor } from '../process-executor/fake-process-executor';
import { TypeCommandFailedError } from './delivery';
import type { EventsService } from '../../../events/services/events.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import { HumanPromptStateService } from '../human-prompt-state.service';

describe('TerminalIOService', () => {
  let fake: FakeProcessExecutor;
  let svc: TerminalIOService;
  let humanPromptState: HumanPromptStateService;

  beforeEach(() => {
    fake = new FakeProcessExecutor();
    const events = { publish: jest.fn() } as unknown as EventsService;
    humanPromptState = new HumanPromptStateService();
    const settings = { getFollowNoteEnabled: () => true } as unknown as SettingsService;
    svc = new TerminalIOService(fake, events, humanPromptState, settings);
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  describe('createSession', () => {
    // The executor boundary is the cheapest layer that verifies both tmux and child env.
    it('uses process ids over inherited and supplied ids for a new session', async () => {
      const uid = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      const gid = jest.spyOn(process, 'getgid').mockReturnValue(1002);
      try {
        await svc.createSession('ids', ['bash'], {
          cwd: '/tmp',
          env: { DEVCHAIN_UID: '1000', DEVCHAIN_GID: '1000', KEEP: 'yes' },
        });
        expect(fake.calls[0].env).toEqual({
          DEVCHAIN_UID: '1001',
          DEVCHAIN_GID: '1002',
          KEEP: 'yes',
        });
        expect(fake.calls[0].argv.slice(-5)).toEqual([
          '-e',
          'DEVCHAIN_UID=1001',
          '-e',
          'DEVCHAIN_GID=1002',
          'bash',
        ]);
      } finally {
        uid.mockRestore();
        gid.mockRestore();
      }
    });

    it('adds no ids or tmux env arguments when process ids are unavailable', async () => {
      const uid = process.getuid;
      const gid = process.getgid;
      Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
      Object.defineProperty(process, 'getgid', { value: undefined, configurable: true });
      try {
        await svc.createSession('windows', ['bash'], { cwd: '/tmp', env: { KEEP: 'yes' } });
        expect(fake.calls[0].env).toEqual({ KEEP: 'yes' });
        expect(fake.calls[0].argv).toEqual([
          'tmux',
          'new-session',
          '-d',
          '-s',
          'windows',
          '-c',
          '/tmp',
          'bash',
        ]);
      } finally {
        Object.defineProperty(process, 'getuid', { value: uid, configurable: true });
        Object.defineProperty(process, 'getgid', { value: gid, configurable: true });
      }
    });
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
        ...Object.entries(processIdsEnv()).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        'bash',
      ]);
      expect(fake.calls[0].mode).toBe('pipe');
      // No caller env: tmux inherits ours unvalidated, so an exported shell function cannot block it.
      expect(fake.calls[0].env).toBeUndefined();
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

    it('retries without -e when a tmux older than 3.2 refuses the flag', async () => {
      const uid = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      const gid = jest.spyOn(process, 'getgid').mockReturnValue(1002);
      try {
        fake.enqueueResponse({
          type: 'failure',
          stderr: 'usage: new-session [-AdDEPX] [-c start-directory] [-F format]',
        });
        await expect(svc.createSession('old', ['bash'], { cwd: '/tmp' })).resolves.toEqual({
          name: 'old',
        });
        expect(fake.calls[1].argv).toEqual([
          'tmux',
          'new-session',
          '-d',
          '-s',
          'old',
          '-c',
          '/tmp',
          'bash',
        ]);
      } finally {
        uid.mockRestore();
        gid.mockRestore();
      }
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

      expect(fake.calls[0].env).toEqual({ FOO: 'bar', ...processIdsEnv() });
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

    it('clears prompt state after successful destruction', async () => {
      humanPromptState.recordPromptText('my-session');
      fake.enqueueResponse({ type: 'success' });

      await svc.destroySession({ name: 'my-session' });

      expect(humanPromptState.getState('my-session').phase).toBe('inactive');
      expect(humanPromptState.getState('my-session').generation).toBe(0);
    });

    it('keeps prompt state when destruction fails', async () => {
      humanPromptState.recordPromptText('still-running');
      fake.enqueueResponse({ type: 'failure', stderr: 'permission denied' });

      await expect(svc.destroySession({ name: 'still-running' })).rejects.toThrow();

      expect(humanPromptState.getState('still-running').phase).toBe('draft_active');
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
      expect(fake.calls[0].outputLimits).toEqual({ maxBytes: 256 * 1024 });
    });

    it('returns error result on failure', async () => {
      fake.enqueueResponse({ type: 'failure', stderr: 'no pane' });

      const result = await svc.captureStrict({ name: 'bad' }, 5);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('no pane');
    });
  });

  describe('send-gap lifecycle', () => {
    it('drops settled queue tails and clears retained timestamps on module teardown', async () => {
      const gap = (
        svc as unknown as {
          gap: {
            ensureGap(agentId: string, minMs?: number): Promise<void>;
            lastByAgent: Map<string, number>;
            tailByAgent: Map<string, Promise<void>>;
          };
        }
      ).gap;

      await gap.ensureGap('agent-cleanup', 0);
      await Promise.resolve();
      expect(gap.tailByAgent.size).toBe(0);
      expect(gap.lastByAgent.size).toBe(1);

      svc.beforeApplicationShutdown();
      expect(gap.tailByAgent.size).toBe(0);
      expect(gap.lastByAgent.size).toBe(0);
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
        ...Object.entries(processIdsEnv()).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      ]);
    });

    it('honors env if passed', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.createEmptySession('sess', { cwd: '/home', env: { MY_VAR: 'val' } });

      expect(fake.calls[0].env).toEqual({ MY_VAR: 'val', ...processIdsEnv() });
    });

    it('defaults cwd to process.cwd() when omitted', async () => {
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.createEmptySession('sess');

      expect(fake.calls[0].argv).toContain(process.cwd());
    });
  });

  describe('setAlternateScreen', () => {
    it.each([false, true])('sets alternate-screen enabled=%s', async (enabled) => {
      fake.enqueueResponse({ type: 'success' });

      await svc.setAlternateScreen({ name: 'sess-1' }, enabled);

      expect(fake.calls[0].argv).toEqual([
        'tmux',
        'set-window-option',
        '-t',
        '=sess-1',
        'alternate-screen',
        enabled ? 'on' : 'off',
      ]);
      expect(fake.calls[0].mode).toBe('pipe');
    });
  });

  describe('typeCommand', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
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

    it('waits 500 ms before typing the next command in the same pane', async () => {
      fake.setDefaultResponse({ type: 'success' });
      await svc.typeCommand({ name: 'sess' }, ['cmd1']);
      let settled = false;
      const second = svc.typeCommand({ name: 'sess' }, ['cmd2']).then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      expect(fake.calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      await second;
      expect(fake.calls).toHaveLength(4);
      expect(fake.calls[2].argv[6]).toBe("'cmd2'");
    });

    it.each([
      { phase: 'literal', timeout: false, cause: 'gone' },
      { phase: 'enter', timeout: false, cause: 'vanished' },
      { phase: 'literal', timeout: true, cause: 'timed out' },
      { phase: 'enter', timeout: true, cause: 'timed out' },
    ])('reports $phase failure with cause $cause', async ({ phase, timeout, cause }) => {
      if (phase === 'enter') fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse(
        timeout ? { type: 'timeout' } : { type: 'failure', exitCode: 1, stderr: cause },
      );
      const pending = svc.typeCommand({ name: 'sess' }, ['cmd']).catch((e) => e);
      await jest.advanceTimersByTimeAsync(10000);
      const error = await pending;
      expect(error).toBeInstanceOf(TypeCommandFailedError);
      expect(error).toMatchObject({ phase, sessionName: 'sess', cause });
      expect(fake.calls).toHaveLength(phase === 'enter' ? 2 : 1);
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

    it.each([
      { foreground: 'red', background: bg, invalid: 'foreground' },
      { foreground: fg, background: 'rgb(0,0,0)', invalid: 'background' },
      { foreground: '#fff', background: bg, invalid: 'foreground' },
      { foreground: '1a1a1a', background: bg, invalid: 'foreground' },
      { foreground: '#C9D1D9', background: '#1A1A1A', invalid: undefined },
    ])(
      'validates window theme $foreground / $background',
      async ({ foreground, background, invalid }) => {
        if (invalid) {
          await expect(svc.applyWindowTheme(target, foreground, background)).rejects.toThrow(
            new RegExp(invalid),
          );
          expect(fake.calls).toHaveLength(0);
        } else {
          fake.enqueueResponse({ type: 'success' });
          fake.enqueueResponse({ type: 'success' });
          await svc.applyWindowTheme(target, foreground, background);
          expect(fake.calls).toHaveLength(2);
          expect(fake.calls[0].argv).toContain(`fg=${foreground},bg=${background}`);
          expect(fake.calls[1].argv).toContain(`fg=${foreground},bg=${background}`);
        }
      },
    );

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
