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
});
