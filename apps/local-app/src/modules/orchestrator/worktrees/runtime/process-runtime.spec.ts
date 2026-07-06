import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeProcessExecutor } from '../../../terminal/services/process-executor/fake-process-executor';
import { ProcessRuntime } from './process-runtime';

// Edge assertions migrated verbatim from the worktrees.service.spec process
// blocks (Phase 1 Task 1 safety net): the ProcessRuntime adapter now owns these
// mechanics, so the locks live here.
describe('ProcessRuntime', () => {
  const originalFetch = global.fetch;
  let tempRoot: string;
  let executor: FakeProcessExecutor;
  let runtime: ProcessRuntime;

  const edgeOf = (rt: ProcessRuntime) =>
    rt as unknown as {
      isProcessAlive: (pid: number) => boolean;
      terminateProcess: (pid?: number | null) => Promise<void>;
      signalProcessAndAwaitExit: (
        pid: number,
        signal: NodeJS.Signals,
        timeoutMs: number,
      ) => Promise<boolean>;
      spawnProcessRuntime: (input: {
        worktreePath: string;
        dataPath: string;
        projectId: string;
        runtimeToken: string;
      }) => Promise<number>;
      waitForRuntimePortFile: (
        filePath: string,
        timeoutMs: number,
        pid?: number,
      ) => Promise<{ port: number; runtimeToken: string | null } | null>;
      waitForRuntimeHealthy: (
        hostPort: number,
        timeoutMs: number,
        pid?: number,
      ) => Promise<boolean>;
      startProcessRuntime: (input: {
        worktreePath: string;
        dataPath: string;
        projectId: string;
      }) => Promise<{ processId: number; hostPort: number; runtimeToken: string; startedAt: Date }>;
    };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'process-runtime-'));
    executor = new FakeProcessExecutor();
    runtime = new ProcessRuntime(executor);
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('startProcessRuntime — port file discovery and token verification', () => {
    let spawnSpy: jest.SpyInstance;
    let portFileSpy: jest.SpyInstance;
    let healthySpy: jest.SpyInstance;
    let terminateSpy: jest.SpyInstance;

    beforeEach(() => {
      spawnSpy = jest.spyOn(edgeOf(runtime), 'spawnProcessRuntime');
      portFileSpy = jest.spyOn(edgeOf(runtime), 'waitForRuntimePortFile');
      healthySpy = jest.spyOn(edgeOf(runtime), 'waitForRuntimeHealthy');
      terminateSpy = jest.spyOn(edgeOf(runtime), 'terminateProcess').mockResolvedValue(undefined);
    });

    it('proceeds when port file token matches and health check passes', async () => {
      spawnSpy.mockImplementation(async (input: { runtimeToken: string }) => {
        portFileSpy.mockResolvedValue({ port: 43000, runtimeToken: input.runtimeToken });
        return 8888;
      });
      healthySpy.mockResolvedValue(true);

      const result = await runtime.startProcessRuntime({
        worktreePath: tempRoot,
        dataPath: join(tempRoot, 'data'),
        projectId: 'project-1',
      });

      expect(result.processId).toBe(8888);
      expect(result.hostPort).toBe(43000);
      expect(result.runtimeToken).toBeDefined();
      expect(terminateSpy).not.toHaveBeenCalled();
      expect(healthySpy).toHaveBeenCalledWith(43000, expect.any(Number), 8888);
    });

    it('terminates PID and throws on port file token mismatch', async () => {
      spawnSpy.mockResolvedValue(8888);
      portFileSpy.mockResolvedValue({ port: 43000, runtimeToken: 'wrong-token' });

      await expect(
        runtime.startProcessRuntime({
          worktreePath: tempRoot,
          dataPath: join(tempRoot, 'data'),
          projectId: 'project-1',
        }),
      ).rejects.toThrow(/Runtime port file token mismatch/);

      expect(terminateSpy).toHaveBeenCalledTimes(1);
      expect(terminateSpy).toHaveBeenCalledWith(8888);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });

    it('terminates PID and throws when port file is not written before timeout', async () => {
      spawnSpy.mockResolvedValue(8888);
      portFileSpy.mockResolvedValue(null);

      await expect(
        runtime.startProcessRuntime({
          worktreePath: tempRoot,
          dataPath: join(tempRoot, 'data'),
          projectId: 'project-1',
        }),
      ).rejects.toThrow(/Process runtime did not report its port before timeout/);

      expect(terminateSpy).toHaveBeenCalledTimes(1);
      expect(terminateSpy).toHaveBeenCalledWith(8888);
    });

    it('fails fast when child process exits during health polling (PID dead)', async () => {
      const checkReadySpy = jest.spyOn(runtime, 'checkRuntimeReady').mockResolvedValue(false);
      const isAliveSpy = jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(false);
      healthySpy.mockRestore();

      const result = await edgeOf(runtime).waitForRuntimeHealthy(43000, 60_000, 8888);

      expect(result).toBe(false);
      // PID-alive check fails first in the loop — the HTTP probe is never called.
      expect(checkReadySpy).not.toHaveBeenCalled();
      expect(isAliveSpy).toHaveBeenCalledWith(8888);
    });
  });

  describe('spawnProcessRuntime', () => {
    it('passes --port 0 and RUNTIME_PORT_FILE when spawning process runtime', async () => {
      const dataPath = join(tempRoot, 'data');
      await mkdir(dataPath, { recursive: true });
      executor.enqueueDaemonPid(7777);

      const pid = await edgeOf(runtime).spawnProcessRuntime({
        worktreePath: tempRoot,
        dataPath,
        projectId: '11111111-1111-4111-8111-111111111111',
        runtimeToken: 'runtime-token-test',
      });

      expect(pid).toBe(7777);
      expect(executor.daemonCalls).toHaveLength(1);
      const call = executor.daemonCalls[0]!;
      expect(call.argv).toEqual(
        expect.arrayContaining(['--worktree-runtime', 'process', '--port', '0']),
      );
      expect(call.env?.PORT).toBe('0');
      expect(call.env?.RUNTIME_TOKEN).toBe('runtime-token-test');
      expect(call.env?.RUNTIME_PORT_FILE).toContain('runtime-port.json');
    });
  });

  describe('probeHealth', () => {
    it('returns "dead" when pid is missing or not alive', async () => {
      jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(false);
      await expect(
        runtime.probeHealth({ pid: null, hostPort: 42000, runtimeToken: 'tok' }),
      ).resolves.toBe('dead');
      await expect(
        runtime.probeHealth({ pid: 3333, hostPort: 42000, runtimeToken: 'tok' }),
      ).resolves.toBe('dead');
    });

    it('returns "unreachable" when hostPort or token is missing', async () => {
      jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(true);
      await expect(
        runtime.probeHealth({ pid: 3333, hostPort: null, runtimeToken: 'tok' }),
      ).resolves.toBe('unreachable');
      await expect(
        runtime.probeHealth({ pid: 3333, hostPort: 42000, runtimeToken: null }),
      ).resolves.toBe('unreachable');
    });

    it('returns "unreachable" when the readiness probe fails', async () => {
      jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(true);
      global.fetch = jest.fn(
        async () => ({ ok: false, json: async () => ({}) }) as Response,
      ) as unknown as typeof fetch;
      await expect(
        runtime.probeHealth({ pid: 3333, hostPort: 42000, runtimeToken: 'tok' }),
      ).resolves.toBe('unreachable');
    });

    it('returns "token-mismatch" when the runtime token no longer matches', async () => {
      jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(true);
      global.fetch = jest.fn(async (url: string) => {
        if (url.endsWith('/health/ready')) {
          return { ok: true, json: async () => ({}) } as Response;
        }
        return { ok: true, json: async () => ({ runtimeToken: 'other' }) } as Response;
      }) as unknown as typeof fetch;
      await expect(
        runtime.probeHealth({ pid: 3333, hostPort: 42000, runtimeToken: 'expected' }),
      ).resolves.toBe('token-mismatch');
    });

    it('returns "healthy" when pid alive, ready, and token matches', async () => {
      jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(true);
      global.fetch = jest.fn(async (url: string) => {
        if (url.endsWith('/health/ready')) {
          return { ok: true, json: async () => ({}) } as Response;
        }
        return { ok: true, json: async () => ({ runtimeToken: 'expected' }) } as Response;
      }) as unknown as typeof fetch;
      await expect(
        runtime.probeHealth({ pid: 3333, hostPort: 42000, runtimeToken: 'expected' }),
      ).resolves.toBe('healthy');
    });
  });

  describe('fetchRuntimeMetadata', () => {
    it('returns the parsed runtime token payload', async () => {
      global.fetch = jest.fn(
        async () => ({ ok: true, json: async () => ({ runtimeToken: 'tok-1' }) }) as Response,
      ) as unknown as typeof fetch;
      await expect(runtime.fetchRuntimeMetadata(42000)).resolves.toEqual({ runtimeToken: 'tok-1' });
    });

    it('returns null on a non-OK response', async () => {
      global.fetch = jest.fn(
        async () => ({ ok: false, json: async () => ({}) }) as Response,
      ) as unknown as typeof fetch;
      await expect(runtime.fetchRuntimeMetadata(42000)).resolves.toBeNull();
    });
  });

  describe('readLogs', () => {
    it('tails the process log file and terminates with a newline', async () => {
      const dataPath = join(tempRoot, 'data');
      await mkdir(dataPath, { recursive: true });
      await writeFile(join(dataPath, 'devchain.log'), 'line1\nline2\nline3\n');

      await expect(runtime.readLogs(dataPath, 2)).resolves.toBe('line2\nline3\n');
    });

    it('returns empty string when the log file is absent', async () => {
      await expect(runtime.readLogs(join(tempRoot, 'missing'), 50)).resolves.toBe('');
    });
  });

  describe('readRecentLog', () => {
    it('returns the tail of the log for crash diagnostics', async () => {
      const dataPath = join(tempRoot, 'data');
      await mkdir(dataPath, { recursive: true });
      await writeFile(join(dataPath, 'devchain.log'), 'boom\n');
      await expect(runtime.readRecentLog(dataPath)).resolves.toBe('boom\n');
    });

    it('returns empty string when the log is absent', async () => {
      await expect(runtime.readRecentLog(join(tempRoot, 'missing'))).resolves.toBe('');
    });
  });

  describe('isProcessAlive', () => {
    let killSpy: jest.SpyInstance;

    afterEach(() => killSpy.mockRestore());

    it('returns true when signal 0 succeeds (process exists)', () => {
      killSpy = jest.spyOn(process, 'kill').mockImplementation(() => undefined as never);
      expect(edgeOf(runtime).isProcessAlive(99990)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(99990, 0);
    });

    it('returns true on EPERM (process exists but is not killable by us)', () => {
      killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      });
      expect(edgeOf(runtime).isProcessAlive(99991)).toBe(true);
    });

    it('returns false on ESRCH (no such process)', () => {
      killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      expect(edgeOf(runtime).isProcessAlive(99992)).toBe(false);
    });

    it('returns false on any other errno code (conservative default)', () => {
      killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('unknown'), { code: 'EINVAL' });
      });
      expect(edgeOf(runtime).isProcessAlive(99993)).toBe(false);
    });
  });

  describe('signalProcessAndAwaitExit', () => {
    let killSpy: jest.SpyInstance;

    afterEach(() => killSpy.mockRestore());

    it('signals the detached process group with a negative pid (non-win32)', async () => {
      killSpy = jest.spyOn(process, 'kill').mockReturnValue(true as never);
      jest.spyOn(runtime, 'isProcessAlive').mockReturnValue(false);

      const stillRunning = await edgeOf(runtime).signalProcessAndAwaitExit(7777, 'SIGTERM', 0);

      expect(stillRunning).toBe(false);
      const expectedSignalPid = process.platform === 'win32' ? 7777 : -7777;
      expect(killSpy).toHaveBeenCalledWith(expectedSignalPid, 'SIGTERM');
    });

    it('returns false immediately when process.kill throws ESRCH (signal not delivered)', async () => {
      killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      const isAliveSpy = jest.spyOn(runtime, 'isProcessAlive');

      const result = await edgeOf(runtime).signalProcessAndAwaitExit(99994, 'SIGTERM', 5000);

      expect(result).toBe(false);
      expect(isAliveSpy).not.toHaveBeenCalled();
      const expectedSignalPid = process.platform === 'win32' ? 99994 : -99994;
      expect(killSpy).toHaveBeenCalledWith(expectedSignalPid, 'SIGTERM');
    });

    it('rethrows non-ESRCH errors from process.kill', async () => {
      killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('perm-denied-unexpected');
      });

      await expect(
        edgeOf(runtime).signalProcessAndAwaitExit(99995, 'SIGTERM', 5000),
      ).rejects.toThrow('perm-denied-unexpected');
    });
  });

  describe('terminateProcess', () => {
    it('escalates from SIGTERM to SIGKILL when the process survives SIGTERM', async () => {
      const signalSpy = jest
        .spyOn(edgeOf(runtime), 'signalProcessAndAwaitExit')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await edgeOf(runtime).terminateProcess(99996);

      expect(signalSpy).toHaveBeenCalledTimes(2);
      expect(signalSpy.mock.calls[0]).toEqual([99996, 'SIGTERM', 30000]);
      expect(signalSpy.mock.calls[1]).toEqual([99996, 'SIGKILL', 5000]);
    });

    it('does NOT escalate to SIGKILL when SIGTERM already reaped the process', async () => {
      const signalSpy = jest
        .spyOn(edgeOf(runtime), 'signalProcessAndAwaitExit')
        .mockResolvedValueOnce(false);

      await edgeOf(runtime).terminateProcess(99997);

      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(signalSpy.mock.calls[0]).toEqual([99997, 'SIGTERM', 30000]);
    });

    it('no-ops on null/undefined pid without sending any signal', async () => {
      const signalSpy = jest.spyOn(edgeOf(runtime), 'signalProcessAndAwaitExit');
      const killSpy = jest.spyOn(process, 'kill');

      await edgeOf(runtime).terminateProcess(null);
      await edgeOf(runtime).terminateProcess(undefined);

      expect(signalSpy).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });
  });
});
