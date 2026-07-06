import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { createLogger } from '../../../../common/logging/logger';
import { ProcessExecutor } from '../../../terminal/services/process-executor/process-executor.port';

const logger = createLogger('WorktreeProcessRuntime');

// Readiness ceiling for a freshly spawned process runtime (port-file wait +
// HTTP readiness). Matches the container health timeout so both runtime kinds
// give a new instance the same grace period before giving up.
const PROCESS_READINESS_TIMEOUT_MS = 60_000;
const PROCESS_SHUTDOWN_TIMEOUT_MS = 30_000;
const PROCESS_KILL_TIMEOUT_MS = 5_000;
const PROCESS_LOG_FILE_NAME = 'devchain.log';
const PROCESS_DB_FILE_NAME = 'devchain.db';
const PROCESS_RUNTIME_PORT_FILE = 'runtime-port.json';
const PROCESS_HEALTH_POLL_INTERVAL_MS = 1_000;
const PROCESS_RUNTIME_TIMEOUT_MS = 1_500;

export interface StartedProcessRuntime {
  processId: number;
  hostPort: number;
  runtimeToken: string;
  startedAt: Date;
}

export interface RuntimeMetadataResponse {
  runtimeToken?: string;
}

/**
 * Monitor verdict for a running process runtime. The service maps each verdict
 * to a status transition; the counting/3-strike policy stays in the service.
 * - `dead`: pid missing or no longer alive → the service stops the worktree.
 * - `unreachable`: alive but port/token missing or readiness probe failed →
 *   the service counts it toward the 3-strike health failure.
 * - `token-mismatch`: alive and ready but `/api/runtime` no longer returns our
 *   token (port reused by a different process) → the service stops it, NOT an
 *   error (see docs/worktree-runtime-matrix.md).
 * - `healthy`: alive, ready, token matches.
 */
export type ProcessHealthVerdict = 'dead' | 'unreachable' | 'token-mismatch' | 'healthy';

/**
 * Module-private runtime adapter owning all PROCESS-kind mechanics extracted
 * from WorktreesService: spawn (via {@link ProcessExecutor}), port-file
 * discovery, runtime-token verification, HTTP readiness/metadata probes,
 * SIGTERM→SIGKILL termination, liveness, and file-based logs.
 *
 * Pure TRANSPORT: it decides nothing about worktree status. The service keeps
 * runtime selection, the monitor/reconcile policy loops, status transitions,
 * and the health-failure counter — it consumes this adapter's verdicts.
 */
@Injectable()
export class ProcessRuntime {
  constructor(private readonly executor: ProcessExecutor) {}

  /**
   * Spawn the child runtime, wait for it to publish its OS-assigned port,
   * verify the port file was written by our child (token match), and confirm
   * HTTP readiness. Terminates the child and throws on any failure.
   */
  async startProcessRuntime(input: {
    worktreePath: string;
    dataPath: string;
    projectId: string;
  }): Promise<StartedProcessRuntime> {
    const runtimeToken = randomUUID();
    const portFilePath = join(input.dataPath, PROCESS_RUNTIME_PORT_FILE);

    // Clean up stale port file from a previous attempt
    await rm(portFilePath, { force: true }).catch(() => undefined);

    const processId = await this.spawnProcessRuntime({
      worktreePath: input.worktreePath,
      dataPath: input.dataPath,
      projectId: input.projectId,
      runtimeToken,
    });

    // Wait for child to report its OS-assigned port via the port file
    const portInfo = await this.waitForRuntimePortFile(
      portFilePath,
      PROCESS_READINESS_TIMEOUT_MS,
      processId,
    );

    if (!portInfo) {
      await this.terminateProcess(processId).catch(() => undefined);
      throw new Error('Process runtime did not report its port before timeout');
    }

    // Verify the port file was written by our child (token match)
    if (portInfo.runtimeToken !== runtimeToken) {
      await this.terminateProcess(processId).catch(() => undefined);
      throw new Error(
        `Runtime port file token mismatch: expected ${runtimeToken}, ` +
          `got ${portInfo.runtimeToken ?? 'none'}`,
      );
    }

    const hostPort = portInfo.port;

    // Confirm the server is ready to accept requests
    const healthy = await this.waitForRuntimeHealthy(
      hostPort,
      PROCESS_READINESS_TIMEOUT_MS,
      processId,
    );
    if (!healthy) {
      await this.terminateProcess(processId).catch(() => undefined);
      throw new Error('Process runtime did not become healthy before timeout');
    }

    return { processId, hostPort, runtimeToken, startedAt: new Date() };
  }

  /**
   * Liveness + readiness + token verdict for the monitor loop. The service
   * translates the verdict into a status transition and applies the 3-strike
   * counting policy.
   */
  async probeHealth(input: {
    pid: number | null;
    hostPort: number | null;
    runtimeToken: string | null;
  }): Promise<ProcessHealthVerdict> {
    const { pid, hostPort, runtimeToken } = input;
    if (!pid || !this.isProcessAlive(pid)) {
      return 'dead';
    }
    if (!hostPort || !runtimeToken) {
      return 'unreachable';
    }
    const ready = await this.checkRuntimeReady(hostPort);
    if (!ready) {
      return 'unreachable';
    }
    const metadata = await this.fetchRuntimeMetadata(hostPort);
    if (metadata?.runtimeToken !== runtimeToken) {
      return 'token-mismatch';
    }
    return 'healthy';
  }

  /** Tail the process runtime's file log (`devchain.log`) under the data dir. */
  async readLogs(dataPath: string, tail: number): Promise<string> {
    const logPath = this.resolveProcessLogPath(dataPath);
    const content = await readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    const lines = content.split(/\r?\n/).filter((line, index, all) => {
      if (line.length > 0) {
        return true;
      }
      return index < all.length - 1;
    });
    const tailed = lines.slice(-tail).join('\n');
    return tailed ? `${tailed}\n` : '';
  }

  /**
   * Best-effort read of the tail of the process log for crash diagnostics
   * during create-failure cleanup. Returns '' when the log is absent or empty.
   */
  async readRecentLog(dataPath: string, maxChars = 2000): Promise<string> {
    const logPath = this.resolveProcessLogPath(dataPath);
    try {
      const content = await readFile(logPath, 'utf-8');
      return content.trim() ? content.slice(-maxChars) : '';
    } catch {
      return '';
    }
  }

  private async spawnProcessRuntime(input: {
    worktreePath: string;
    dataPath: string;
    projectId: string;
    runtimeToken: string;
  }): Promise<number> {
    const cliPath = this.resolveCliPath();
    const logPath = this.resolveProcessLogPath(input.dataPath);
    const portFilePath = join(input.dataPath, PROCESS_RUNTIME_PORT_FILE);
    await mkdir(input.dataPath, { recursive: true });

    const result = await this.executor.spawnDaemon({
      argv: [
        process.execPath,
        cliPath,
        'start',
        '--foreground',
        '--worktree-runtime',
        'process',
        '--port',
        '0',
      ],
      cwd: input.worktreePath,
      logPath,
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        DB_PATH: input.dataPath,
        DB_FILENAME: PROCESS_DB_FILE_NAME,
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: input.projectId,
        RUNTIME_TOKEN: input.runtimeToken,
        RUNTIME_PORT_FILE: portFilePath,
      },
    });

    return result.pid;
  }

  private async waitForRuntimeHealthy(
    hostPort: number,
    timeoutMs: number,
    pid?: number,
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Early exit if child process died (e.g., EADDRINUSE with strict port binding)
      if (pid && !this.isProcessAlive(pid)) {
        logger.warn({ pid, hostPort }, 'Child process exited during health polling');
        return false;
      }

      const isReady = await this.checkRuntimeReady(hostPort);
      if (isReady) {
        return true;
      }
      await this.sleep(PROCESS_HEALTH_POLL_INTERVAL_MS);
    }

    return false;
  }

  private async waitForRuntimePortFile(
    filePath: string,
    timeoutMs: number,
    pid?: number,
  ): Promise<{ port: number; runtimeToken: string | null } | null> {
    if (timeoutMs <= 0) {
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Early exit if child process died before writing the port file
      if (pid && !this.isProcessAlive(pid)) {
        logger.warn({ pid, filePath }, 'Child process exited before writing port file');
        return null;
      }

      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as { port?: number; runtimeToken?: string | null };
        if (typeof parsed.port === 'number' && parsed.port > 0) {
          return { port: parsed.port, runtimeToken: parsed.runtimeToken ?? null };
        }
      } catch {
        // File doesn't exist yet or is being written — keep polling
      }

      await this.sleep(PROCESS_HEALTH_POLL_INTERVAL_MS);
    }

    return null;
  }

  async checkRuntimeReady(hostPort: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROCESS_RUNTIME_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health/ready`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchRuntimeMetadata(hostPort: number): Promise<RuntimeMetadataResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROCESS_RUNTIME_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/api/runtime`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as RuntimeMetadataResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveCliPath(): string {
    const candidates = [
      // Dev mode: scripts/cli.js in repo root
      resolve(process.cwd(), 'scripts', 'cli.js'),
      resolve(__dirname, '../../../../../../../../scripts/cli.js'),
      resolve(__dirname, '../../../../../../../scripts/cli.js'),
      // Installed CLI: dist/cli.js relative to compiled service location
      resolve(__dirname, '../../../../../cli.js'),
    ];

    // Also try the entry point of the currently running process
    if (process.argv[1] && !candidates.includes(resolve(process.argv[1]))) {
      candidates.push(resolve(process.argv[1]));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      'Unable to locate CLI entry point for process runtime start. ' +
        `Searched: ${candidates.join(', ')}`,
    );
  }

  private resolveProcessLogPath(dataPath: string): string {
    return join(dataPath, PROCESS_LOG_FILE_NAME);
  }

  async terminateProcess(pid?: number | null): Promise<void> {
    if (!pid) {
      return;
    }

    const stillRunningAfterSigterm = await this.signalProcessAndAwaitExit(
      pid,
      'SIGTERM',
      PROCESS_SHUTDOWN_TIMEOUT_MS,
    );
    if (!stillRunningAfterSigterm) {
      return;
    }

    await this.signalProcessAndAwaitExit(pid, 'SIGKILL', PROCESS_KILL_TIMEOUT_MS).catch((error) => {
      logger.warn({ error, pid }, 'Failed sending SIGKILL to worktree process');
    });
  }

  private async signalProcessAndAwaitExit(
    pid: number,
    signal: NodeJS.Signals,
    timeoutMs: number,
  ): Promise<boolean> {
    const signalPid = process.platform === 'win32' ? pid : -pid;
    try {
      process.kill(signalPid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return false;
      }
      throw error;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) {
        return false;
      }
      await this.sleep(200);
    }
    return this.isProcessAlive(pid);
  }

  isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return false;
      }
      if (code === 'EPERM') {
        return true;
      }
      return false;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }
}
