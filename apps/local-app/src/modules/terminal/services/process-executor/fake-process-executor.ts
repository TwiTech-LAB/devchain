import {
  ProcessExecutor,
  ProcessExecutorOptions,
  ExecutorResult,
  DaemonSpawnOptions,
  DaemonSpawnResult,
} from './process-executor.port';

export interface RecordedCall {
  readonly argv: readonly string[];
  readonly mode: 'pipe' | 'pty';
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface RecordedDaemonCall {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logPath: string;
}

export type CannedResponse =
  | { type: 'success'; stdout?: string; stderr?: string }
  | { type: 'failure'; exitCode?: number; stdout?: string; stderr?: string }
  | { type: 'timeout' }
  | { type: 'output-bytes'; stdout: string; stderr?: string };

export class FakeProcessExecutor extends ProcessExecutor {
  readonly calls: RecordedCall[] = [];
  readonly daemonCalls: RecordedDaemonCall[] = [];
  private responses: CannedResponse[] = [];
  private defaultResponse: CannedResponse = { type: 'success' };
  private daemonPids: number[] = [];
  private defaultDaemonPid = 1234;

  setDefaultResponse(response: CannedResponse): void {
    this.defaultResponse = response;
  }

  enqueueResponse(...responses: CannedResponse[]): void {
    this.responses.push(...responses);
  }

  enqueueDaemonPid(...pids: number[]): void {
    this.daemonPids.push(...pids);
  }

  reset(): void {
    this.calls.length = 0;
    this.daemonCalls.length = 0;
    this.responses.length = 0;
    this.daemonPids.length = 0;
    this.defaultResponse = { type: 'success' };
  }

  async spawnDaemon(options: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
    this.daemonCalls.push({
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
      logPath: options.logPath,
    });
    const pid = this.daemonPids.shift() ?? this.defaultDaemonPid;
    return { pid };
  }

  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    this.calls.push({
      argv: options.argv,
      mode: options.mode,
      cwd: options.cwd,
      env: options.env,
    });

    const response = this.responses.shift() ?? this.defaultResponse;
    const maxBytes = options.outputLimits?.maxBytes;

    switch (response.type) {
      case 'success': {
        const stdout = this.maybeTruncate(response.stdout ?? '', maxBytes);
        const stderr = this.maybeTruncate(response.stderr ?? '', maxBytes);
        return {
          success: true,
          exitCode: 0,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut: false,
          truncated: stdout.truncated || stderr.truncated,
        };
      }
      case 'failure': {
        const stdout = this.maybeTruncate(response.stdout ?? '', maxBytes);
        const stderr = this.maybeTruncate(response.stderr ?? '', maxBytes);
        return {
          success: false,
          exitCode: response.exitCode ?? 1,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut: false,
          truncated: stdout.truncated || stderr.truncated,
        };
      }
      case 'timeout':
        return {
          success: false,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          truncated: false,
        };
      case 'output-bytes': {
        const stdout = this.maybeTruncate(response.stdout, maxBytes);
        const stderr = this.maybeTruncate(response.stderr ?? '', maxBytes);
        return {
          success: true,
          exitCode: 0,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut: false,
          truncated: stdout.truncated || stderr.truncated,
        };
      }
    }
  }

  private maybeTruncate(text: string, maxBytes?: number): { text: string; truncated: boolean } {
    if (maxBytes === undefined || text.length <= maxBytes) {
      return { text, truncated: false };
    }
    return { text: text.slice(0, maxBytes), truncated: true };
  }
}
