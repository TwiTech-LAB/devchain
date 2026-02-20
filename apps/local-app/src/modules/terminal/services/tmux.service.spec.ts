import { TmuxService } from './tmux.service';
import { EventsService } from '../../events/services/events.service';

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

    it('skips sendKeys when submitKeys is empty', async () => {
      const promise = tmuxService.pasteAndSubmit('sess-1', 'hello', { submitKeys: [] });
      await jest.runAllTimersAsync();
      await promise;

      expect(pasteTextSpy).toHaveBeenCalledTimes(1);
      expect(sendKeysSpy).not.toHaveBeenCalled();
    });
  });
});
