import { TmuxService } from './tmux.service';
import { EventsService } from '../../events/services/events.service';
import { PasteNotConfirmedError } from '../../../common/errors/error-types';

// Mock child_process - need both exec (for listSessions/listAllSessionNames)
// and execFile (for getSessionCwd which uses execFileAsync for security)
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    exec: jest.fn(),
    execFile: jest.fn(),
  };
});

import * as childProcess from 'child_process';

describe('TmuxService', () => {
  let tmuxService: TmuxService;
  let eventsService: jest.Mocked<Partial<EventsService>>;
  let mockExec: jest.Mock;
  let mockExecFile: jest.Mock;

  beforeEach(() => {
    eventsService = {
      publish: jest.fn(),
    };

    mockExec = childProcess.exec as unknown as jest.Mock;
    mockExec.mockReset();

    mockExecFile = childProcess.execFile as unknown as jest.Mock;
    mockExecFile.mockReset();

    tmuxService = new TmuxService(eventsService as EventsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSessionCwd', () => {
    it('should return the current working directory of a tmux session', async () => {
      const sessionId = 'test-session';
      const paneId = '%0';
      const expectedCwd = '/home/user/project';

      // Mock list-panes to return pane ID (execFile is used for security)
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          expect(cmd).toBe('tmux');
          expect(args).toContain('list-panes');
          expect(args).toContain(`=${sessionId}`);
          callback(null, { stdout: `${paneId}\n` });
        },
      );

      // Mock display-message to return cwd
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          expect(cmd).toBe('tmux');
          expect(args).toContain('display-message');
          expect(args).toContain(paneId);
          callback(null, { stdout: `${expectedCwd}\n` });
        },
      );

      const result = await tmuxService.getSessionCwd(sessionId);

      expect(result).toBe(expectedCwd);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('should return null when session does not exist', async () => {
      const sessionId = 'nonexistent-session';

      // Mock list-panes to fail (session not found)
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(new Error('session not found: nonexistent-session'), { stdout: '' });
        },
      );

      const result = await tmuxService.getSessionCwd(sessionId);

      expect(result).toBeNull();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('should return null when no panes are found', async () => {
      const sessionId = 'empty-session';

      // Mock list-panes to return empty output
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(null, { stdout: '' });
        },
      );

      const result = await tmuxService.getSessionCwd(sessionId);

      expect(result).toBeNull();
    });

    it('should return null when pane_current_path is empty', async () => {
      const sessionId = 'test-session';
      const paneId = '%0';

      // Mock list-panes to return pane ID
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(null, { stdout: `${paneId}\n` });
        },
      );

      // Mock display-message to return empty path
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(null, { stdout: '' });
        },
      );

      const result = await tmuxService.getSessionCwd(sessionId);

      expect(result).toBeNull();
    });

    it('should use = prefix for exact session name matching', async () => {
      const sessionId = 'my-session-with-dashes';
      const paneId = '%0';
      const expectedCwd = '/home/user/project';

      // Mock list-panes - verify = prefix is passed in args
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          expect(cmd).toBe('tmux');
          // The -t argument should have = prefix for exact match
          expect(args).toContain(`=${sessionId}`);
          callback(null, { stdout: `${paneId}\n` });
        },
      );

      // Mock display-message
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(null, { stdout: `${expectedCwd}\n` });
        },
      );

      const result = await tmuxService.getSessionCwd(sessionId);

      expect(result).toBe(expectedCwd);
    });

    it('should return first pane when multiple panes exist', async () => {
      const sessionId = 'multi-pane-session';
      const firstPaneId = '%0';
      const expectedCwd = '/home/user/first-pane';

      // Mock list-panes to return multiple panes
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(null, { stdout: `${firstPaneId}\n%1\n%2\n` });
        },
      );

      // Mock display-message for first pane
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          expect(args).toContain(firstPaneId);
          callback(null, { stdout: `${expectedCwd}\n` });
        },
      );

      const result = await tmuxService.getSessionCwd(sessionId);

      expect(result).toBe(expectedCwd);
    });
  });

  describe('listAllSessionNames', () => {
    it('should return a Set of all tmux session names', async () => {
      mockExec.mockImplementationOnce(
        (cmd: string, callback: (error: Error | null, result: { stdout: string }) => void) => {
          expect(cmd).toContain('tmux list-sessions');
          expect(cmd).toContain('#{session_name}');
          callback(null, { stdout: 'session1\nsession2\ndevchain_project_abc\n' });
        },
      );

      const result = await tmuxService.listAllSessionNames();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has('session1')).toBe(true);
      expect(result.has('session2')).toBe(true);
      expect(result.has('devchain_project_abc')).toBe(true);
      expect(result.has('nonexistent')).toBe(false);
    });

    it('should return empty Set when no sessions exist', async () => {
      mockExec.mockImplementationOnce(
        (cmd: string, callback: (error: Error | null, result: { stdout: string }) => void) => {
          callback(new Error('no server running'), { stdout: '' });
        },
      );

      const result = await tmuxService.listAllSessionNames();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('should handle empty output gracefully', async () => {
      mockExec.mockImplementationOnce(
        (cmd: string, callback: (error: Error | null, result: { stdout: string }) => void) => {
          callback(null, { stdout: '' });
        },
      );

      const result = await tmuxService.listAllSessionNames();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });
  });

  describe('waitForOutput', () => {
    let capturePaneSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      capturePaneSpy = jest.spyOn(tmuxService, 'capturePane');
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function mockCaptureSequence(sequence: string[]): void {
      let index = 0;
      capturePaneSpy.mockImplementation(async () => {
        const value = sequence[Math.min(index, sequence.length - 1)] ?? '';
        index += 1;
        return value;
      });
    }

    it('returns ready after first output change settles', async () => {
      mockCaptureSequence(['baseline', 'baseline', 'new output', 'new output', 'new output']);

      const promise = tmuxService.waitForOutput('sess-1', {
        pollIntervalMs: 500,
        timeoutMs: 5_000,
        settleMs: 1_000,
        lines: 150,
      });

      await jest.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result).toEqual({ ready: true, elapsedMs: 2_000 });
      expect(capturePaneSpy).toHaveBeenNthCalledWith(1, 'sess-1', 150, false);
      expect(capturePaneSpy).toHaveBeenNthCalledWith(2, 'sess-1', 150, false);
    });

    it('returns timeout result when output never changes from baseline', async () => {
      mockCaptureSequence(['baseline', 'baseline', 'baseline', 'baseline', 'baseline']);

      const promise = tmuxService.waitForOutput('sess-1', {
        pollIntervalMs: 500,
        timeoutMs: 1_500,
        settleMs: 1_000,
      });

      await jest.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.ready).toBe(false);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(1_500);
    });

    it('ignores transient empty captures when baseline is non-empty', async () => {
      mockCaptureSequence(['baseline', 'baseline', 'new output', '', 'new output']);

      const promise = tmuxService.waitForOutput('sess-1', {
        pollIntervalMs: 500,
        timeoutMs: 2_200,
        settleMs: 1_000,
      });

      await jest.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result).toEqual({ ready: true, elapsedMs: 2_000 });
    });

    it('waits for settle duration when output changes multiple times', async () => {
      mockCaptureSequence(['baseline', 'baseline', 'output-1', 'output-2', 'output-2', 'output-2']);

      const promise = tmuxService.waitForOutput('sess-1', {
        pollIntervalMs: 500,
        timeoutMs: 5_000,
        settleMs: 1_000,
      });

      await jest.advanceTimersByTimeAsync(2_500);
      const result = await promise;

      expect(result).toEqual({ ready: true, elapsedMs: 2_500 });
    });
  });

  describe('pasteAndSubmit', () => {
    let pasteTextSpy: jest.SpyInstance;
    let sendKeysSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      pasteTextSpy = jest.spyOn(tmuxService, 'pasteText').mockResolvedValue(undefined);
      sendKeysSpy = jest.spyOn(tmuxService, 'sendKeys').mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('pastes text and sends Enter on success', async () => {
      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello world');
      await jest.runAllTimersAsync();
      await promise;

      expect(pasteTextSpy).toHaveBeenCalledWith('sess-1', 'hello world', { bracketed: true });
      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
    });

    it('retries sendKeys once on first failure then succeeds', async () => {
      sendKeysSpy
        .mockRejectedValueOnce(new Error('tmux sendKeys failed'))
        .mockResolvedValueOnce(undefined);

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello');
      await jest.runAllTimersAsync();
      await promise;

      expect(sendKeysSpy).toHaveBeenCalledTimes(2);
      expect(pasteTextSpy).toHaveBeenCalledTimes(1);
    });

    it('propagates error when sendKeys fails twice', async () => {
      sendKeysSpy.mockRejectedValue(new Error('sendKeys failed'));

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello');

      // Flush initial delay + retry delay timers with microtask draining
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(300);
        await Promise.resolve();
      }

      await expect(promise).rejects.toThrow('sendKeys failed');
    });

    it('sends preKeys before paste when preKeys are provided', async () => {
      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', {
        preKeys: ['Enter'],
        preDelayMs: 100,
      });
      await jest.runAllTimersAsync();
      await promise;

      // preKeys sent first, then paste, then submit
      const sendKeysOrder = sendKeysSpy.mock.invocationCallOrder;
      const pasteOrder = pasteTextSpy.mock.invocationCallOrder;
      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
      expect(sendKeysOrder[0]).toBeLessThan(pasteOrder[0]);
      expect(pasteTextSpy).toHaveBeenCalledWith('sess-1', 'hello', { bracketed: true });
      // Final submit keys call
      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
    });

    it('skips preKeys when not provided (backward-compatible)', async () => {
      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello');
      await jest.runAllTimersAsync();
      await promise;

      // sendKeys called only once (for submit), not for preKeys
      expect(sendKeysSpy).toHaveBeenCalledTimes(1);
      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
    });

    it('sends preKeys without delay when preDelayMs is omitted', async () => {
      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', {
        preKeys: ['Enter'],
      });
      await jest.runAllTimersAsync();
      await promise;

      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
      expect(pasteTextSpy).toHaveBeenCalledWith('sess-1', 'hello', { bracketed: true });
    });

    it('lets preKeys failure propagate without retry', async () => {
      sendKeysSpy.mockRejectedValueOnce(new Error('preKeys failed'));

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', {
        preKeys: ['Enter'],
      });

      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(300);
        await Promise.resolve();
      }

      await expect(promise).rejects.toThrow('preKeys failed');
      // paste should not have been called since preKeys failed
      expect(pasteTextSpy).not.toHaveBeenCalled();
    });

    it('skips sendKeys when submitKeys is empty', async () => {
      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', { submitKeys: [] });
      await jest.runAllTimersAsync();
      await promise;

      expect(pasteTextSpy).toHaveBeenCalledTimes(1);
      expect(sendKeysSpy).not.toHaveBeenCalled();
    });

    it('calls confirmPasteDelivery and sends Enter on confirmed', async () => {
      jest
        .spyOn(tmuxService, 'capturePaneStrict')
        .mockResolvedValue({ ok: true, output: 'baseline' });
      const confirmSpy = jest
        .spyOn(tmuxService, 'confirmPasteDelivery')
        .mockResolvedValue({ confirmed: true, elapsedMs: 50, method: 'nonce' });

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', {
        confirm: true,
        nonce: 'abc1234',
      });
      await jest.runAllTimersAsync();
      await promise;

      expect(pasteTextSpy).toHaveBeenCalledWith('sess-1', 'hello', { bracketed: true });
      expect(confirmSpy).toHaveBeenCalledWith(
        'sess-1',
        'abc1234',
        expect.objectContaining({ timeoutMs: 2000, baseline: 'baseline' }),
      );
      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
    });

    it('throws PasteNotConfirmedError when not confirmed and no captureError', async () => {
      jest.spyOn(tmuxService, 'capturePaneStrict').mockResolvedValue({ ok: true, output: '' });
      jest
        .spyOn(tmuxService, 'confirmPasteDelivery')
        .mockResolvedValue({ confirmed: false, elapsedMs: 2000 });

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', {
        confirm: true,
        nonce: 'abc1234',
      });

      const rejection = expect(promise).rejects.toBeInstanceOf(PasteNotConfirmedError);
      await jest.runAllTimersAsync();
      await rejection;
      expect(sendKeysSpy).not.toHaveBeenCalled();
    });

    it('falls back to fixed delay on captureError', async () => {
      jest.spyOn(tmuxService, 'capturePaneStrict').mockResolvedValue({ ok: true, output: '' });
      jest
        .spyOn(tmuxService, 'confirmPasteDelivery')
        .mockResolvedValue({ confirmed: false, elapsedMs: 10, captureError: true });

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', {
        confirm: true,
        nonce: 'abc1234',
        delayMs: 250,
      });
      await jest.runAllTimersAsync();
      await promise;

      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
    });

    it('uses legacy fixed delay when confirm is false', async () => {
      const confirmSpy = jest.spyOn(tmuxService, 'confirmPasteDelivery');

      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', { confirm: false });
      await jest.runAllTimersAsync();
      await promise;

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(pasteTextSpy).toHaveBeenCalledTimes(1);
      expect(sendKeysSpy).toHaveBeenCalledWith('sess-1', ['Enter']);
    });
  });

  describe('capturePaneStrict', () => {
    it('returns { ok: true, output } on success', async () => {
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          expect(cmd).toBe('tmux');
          expect(args).toEqual(['capture-pane', '-p', '-S', '-10', '-t', '=test-session:']);
          callback(null, { stdout: 'some pane output\n' });
        },
      );

      const result = await tmuxService.capturePaneStrict('test-session', 10);

      expect(result).toEqual({ ok: true, output: 'some pane output\n' });
    });

    it('returns { ok: false, error } on exec failure', async () => {
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(new Error('session not found'), { stdout: '' });
        },
      );

      const result = await tmuxService.capturePaneStrict('test-session', 10);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('session not found');
      }
    });

    it("returns { ok: true, output: '' } on empty pane", async () => {
      mockExecFile.mockImplementationOnce(
        (
          cmd: string,
          args: string[],
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          callback(null, { stdout: '' });
        },
      );

      const result = await tmuxService.capturePaneStrict('test-session', 10);

      expect(result).toEqual({ ok: true, output: '' });
    });
  });

  describe('confirmPasteDelivery', () => {
    let capturePaneStrictSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      capturePaneStrictSpy = jest.spyOn(tmuxService, 'capturePaneStrict');
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns confirmed when nonce found immediately', async () => {
      capturePaneStrictSpy.mockResolvedValue({ ok: true, output: 'some text abc1234 more text' });

      const result = await tmuxService.confirmPasteDelivery('sess-1', 'abc1234', {
        timeoutMs: 2000,
        pollIntervalMs: 150,
        tailLines: 10,
      });

      expect(result.confirmed).toBe(true);
      expect(result.captureError).toBeUndefined();
      expect(capturePaneStrictSpy).toHaveBeenCalledTimes(1);
    });

    it('returns not confirmed when nonce never found (timeout)', async () => {
      capturePaneStrictSpy.mockResolvedValue({ ok: true, output: 'no nonce here' });

      const promise = tmuxService.confirmPasteDelivery('sess-1', 'abc1234', {
        timeoutMs: 500,
        pollIntervalMs: 150,
        tailLines: 10,
      });

      // First capture runs synchronously before any timer advance.
      // Advance timers to let subsequent poll intervals fire.
      await jest.advanceTimersByTimeAsync(600);
      const result = await promise;

      expect(result.confirmed).toBe(false);
      expect(result.captureError).toBeUndefined();
      expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
    });

    it('returns captureError when capture fails', async () => {
      capturePaneStrictSpy.mockResolvedValue({ ok: false, error: 'tmux: session not found' });

      const result = await tmuxService.confirmPasteDelivery('sess-1', 'abc1234', {
        timeoutMs: 2000,
        pollIntervalMs: 150,
        tailLines: 10,
      });

      expect(result.confirmed).toBe(false);
      expect(result.captureError).toBe(true);
      // Should return immediately on first error without polling further
      expect(capturePaneStrictSpy).toHaveBeenCalledTimes(1);
    });

    it('stops polling early once nonce is found', async () => {
      capturePaneStrictSpy
        .mockResolvedValueOnce({ ok: true, output: 'no nonce yet' })
        .mockResolvedValueOnce({ ok: true, output: 'found abc1234 here' });

      const promise = tmuxService.confirmPasteDelivery('sess-1', 'abc1234', {
        timeoutMs: 2000,
        pollIntervalMs: 150,
        tailLines: 10,
      });

      // First capture happens before any timer advance (no nonce).
      // Advance to let the first sleep fire and trigger second capture.
      await jest.advanceTimersByTimeAsync(200);
      const result = await promise;

      expect(result.confirmed).toBe(true);
      expect(capturePaneStrictSpy).toHaveBeenCalledTimes(2);
    });

    it('confirms via paste indicator fallback when nonce is hidden in collapsed TUI output', async () => {
      const baseline = 'prompt> \nsome old output\n';
      capturePaneStrictSpy.mockResolvedValue({
        ok: true,
        output: 'prompt> \nsome old output\n[Pasted text #11 +5 lines]\n',
      });

      const result = await tmuxService.confirmPasteDelivery('sess-1', 'hidden-nonce', {
        timeoutMs: 2000,
        pollIntervalMs: 150,
        tailLines: 10,
        baseline,
      });

      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('paste_indicator');
    });

    it('does not false-positive on pre-existing paste indicators in baseline', async () => {
      const baseline = 'prompt> \n[Pasted text #10 +3 lines]\nold output\n';
      capturePaneStrictSpy.mockResolvedValue({
        ok: true,
        output: 'prompt> \n[Pasted text #10 +3 lines]\nold output\n',
      });

      const promise = tmuxService.confirmPasteDelivery('sess-1', 'hidden-nonce', {
        timeoutMs: 300,
        pollIntervalMs: 100,
        tailLines: 10,
        baseline,
      });

      await jest.advanceTimersByTimeAsync(400);
      const result = await promise;

      expect(result.confirmed).toBe(false);
    });

    it('returns method nonce when nonce is found directly', async () => {
      capturePaneStrictSpy.mockResolvedValue({
        ok: true,
        output: 'text with abc1234 nonce',
      });

      const result = await tmuxService.confirmPasteDelivery('sess-1', 'abc1234', {
        timeoutMs: 2000,
        baseline: 'old output',
      });

      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('nonce');
    });

    it('detects all known collapsed paste formats', async () => {
      const formats = [
        '[Pasted text #11 +5 lines]',
        '[Pasted Content 7952 chars]',
        '[Pasted Text: 33 lines]',
        '[Pasted ~33 lines]',
      ];

      for (const format of formats) {
        capturePaneStrictSpy.mockResolvedValue({
          ok: true,
          output: `prompt> \n${format}\n`,
        });

        const result = await tmuxService.confirmPasteDelivery('sess-1', 'no-match', {
          timeoutMs: 2000,
          baseline: 'prompt> \n',
        });

        expect(result.confirmed).toBe(true);
        expect(result.method).toBe('paste_indicator');
      }
    });

    it('Scenario A: detects paste when old indicator scrolled out and new one appeared (same count)', async () => {
      // Baseline has one paste indicator from a previous attempt
      const baseline = 'prompt> \n[Pasted text #10 +5 lines]\nold stuff\n';
      // After retry, old indicator scrolled out, new identical one appeared with shifted content
      capturePaneStrictSpy.mockResolvedValue({
        ok: true,
        output: 'old stuff\nnew line\n[Pasted text #10 +5 lines]\n',
      });

      const result = await tmuxService.confirmPasteDelivery('sess-1', 'hidden-nonce', {
        timeoutMs: 2000,
        baseline,
      });

      // Set comparison sees same string — Fallback A fails
      // But content changed AND has paste indicator → Fallback B fires
      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('paste_changed');
    });

    it('Scenario B: detects paste when identical collapsed text from multiple attempts', async () => {
      // Baseline has two identical paste indicators from previous failed deliveries
      const baseline = 'prompt> \n[Pasted text +5 lines]\nother output\n[Pasted text +5 lines]\n';
      // New paste also produces identical indicator, but shifts tail content
      capturePaneStrictSpy.mockResolvedValue({
        ok: true,
        output: 'other output\n[Pasted text +5 lines]\nnew output\n[Pasted text +5 lines]\n',
      });

      const result = await tmuxService.confirmPasteDelivery('sess-1', 'hidden-nonce', {
        timeoutMs: 2000,
        baseline,
      });

      // Set comparison sees same string "[Pasted text +5 lines]" — Fallback A fails
      // But content changed AND has paste indicator → Fallback B fires
      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('paste_changed');
    });
  });
});
