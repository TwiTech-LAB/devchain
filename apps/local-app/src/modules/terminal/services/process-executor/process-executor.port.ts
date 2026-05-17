const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export interface ProcessExecutorOptions {
  readonly argv: readonly string[];
  readonly mode: 'pipe' | 'pty';
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly input?: string;
  readonly outputLimits?: {
    readonly maxBytes?: number;
  };
}

export interface ExecutorResult {
  readonly success: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export function validateEnv(env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env key "${key}": must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
    }
    if (CONTROL_CHAR_RE.test(value)) {
      throw new Error(`Invalid env value for "${key}": must not contain control characters`);
    }
  }
}

export interface DaemonSpawnOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logPath: string;
}

export interface DaemonSpawnResult {
  readonly pid: number;
}

export abstract class ProcessExecutor {
  abstract run(options: ProcessExecutorOptions): Promise<ExecutorResult>;
  abstract spawnDaemon(options: DaemonSpawnOptions): Promise<DaemonSpawnResult>;
}
