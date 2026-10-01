import { readFileSync } from 'fs';
import { access, constants, readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { Injectable } from '@nestjs/common';
import { getEnvConfig } from '../../common/config/env.config';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';

const EXIT_POLL_MS = 250;

export const SYNCTHING_REQUIRED_MAJOR = 2;

export const SYNCTHING_INSTALL_GUIDANCE =
  'Install Syncthing v2 from https://syncthing.net/downloads/ and put it on PATH, set ' +
  'SYNCTHING_BIN to the binary, or copy it to ~/.devchain/bin/syncthing; then restart DevChain.';

export type SyncthingBinaryLookup =
  | { found: true; path: string; version: string }
  | { found: false; version: string | null; error: string };

export interface SyncthingProcess {
  readonly pid: number;
  /** Resolves once the process has exited. */
  readonly exited: Promise<void>;
  hasExited(): boolean;
}

/** Everything the manager does to the operating system to find and run Syncthing. */
export abstract class SyncthingLauncher {
  abstract findBinary(): Promise<SyncthingBinaryLookup>;
  /** Starts Syncthing detached, with stdout and stderr appended to `outputPath`. */
  abstract spawn(
    binaryPath: string,
    args: string[],
    env: Record<string, string>,
    outputPath: string,
  ): Promise<SyncthingProcess>;
  /** The process `pid` started, or null when it has none. */
  abstract findChildPid(pid: number): Promise<number | null>;
  abstract isAlive(pid: number): boolean;
  /** SIGKILL; a process that is already gone is not an error. */
  abstract kill(pid: number): void;
}

export interface BinaryLookupDeps {
  /** `SYNCTHING_BIN`; when set it is the only candidate. */
  explicitPath: string | undefined;
  pathEnv: string | undefined;
  homeDir: string;
  platform: NodeJS.Platform;
  isExecutable(path: string): Promise<boolean>;
  readVersionOutput(path: string): Promise<string>;
}

export function parseSyncthingVersion(output: string): { version: string; major: number } | null {
  const match = /\bv(\d+)\.(\d+)\.(\d+)\S*/.exec(output);
  return match ? { version: match[0], major: Number(match[1]) } : null;
}

/**
 * Looks in `SYNCTHING_BIN`, then PATH, then `~/.devchain/bin`, and returns the
 * first v2 binary. Without one, the error names the first binary found (if any)
 * and carries the install guidance.
 */
export async function findSyncthingBinary(deps: BinaryLookupDeps): Promise<SyncthingBinaryLookup> {
  const name = deps.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
  const explicit = deps.explicitPath?.trim();
  const candidates = explicit
    ? [explicit]
    : [
        ...(deps.pathEnv ?? '')
          .split(delimiter)
          .filter((dir) => dir.length > 0)
          .map((dir) => join(dir, name)),
        join(deps.homeDir, '.devchain', 'bin', name),
      ];

  let rejected: { path: string; version: string | null; reason: string } | null = null;
  for (const candidate of candidates) {
    if (!(await deps.isExecutable(candidate))) continue;
    let parsed: { version: string; major: number } | null = null;
    try {
      parsed = parseSyncthingVersion(await deps.readVersionOutput(candidate));
    } catch {
      parsed = null;
    }
    if (parsed?.major === SYNCTHING_REQUIRED_MAJOR) {
      return { found: true, path: candidate, version: parsed.version };
    }
    rejected ??= {
      path: candidate,
      version: parsed?.version ?? null,
      reason: parsed
        ? `Syncthing ${parsed.version} at ${candidate} is not supported; DevChain needs v${SYNCTHING_REQUIRED_MAJOR}.x.`
        : `${candidate} did not report a Syncthing version.`,
    };
  }

  if (rejected) {
    return {
      found: false,
      version: rejected.version,
      error: `${rejected.reason} ${SYNCTHING_INSTALL_GUIDANCE}`,
    };
  }
  const missing = explicit
    ? `SYNCTHING_BIN points at ${explicit}, which is not an executable file.`
    : 'Syncthing was not found on PATH or in ~/.devchain/bin.';
  return { found: false, version: null, error: `${missing} ${SYNCTHING_INSTALL_GUIDANCE}` };
}

@Injectable()
export class NodeSyncthingLauncher extends SyncthingLauncher {
  constructor(private readonly executor: ProcessExecutor) {
    super();
  }

  findBinary(): Promise<SyncthingBinaryLookup> {
    return findSyncthingBinary({
      explicitPath: getEnvConfig().SYNCTHING_BIN,
      pathEnv: process.env.PATH,
      homeDir: homedir(),
      platform: process.platform,
      isExecutable: async (path) => {
        try {
          await access(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      readVersionOutput: async (path) => {
        const result = await this.executor.run({
          argv: [path, '--version'],
          mode: 'pipe',
          timeout: 5_000,
        });
        if (!result.success) throw new Error(`exit code ${result.exitCode}`);
        return result.stdout;
      },
    });
  }

  async spawn(
    binaryPath: string,
    args: string[],
    env: Record<string, string>,
    outputPath: string,
  ): Promise<SyncthingProcess> {
    const { pid } = await this.executor.spawnDaemon({
      argv: [binaryPath, ...args],
      env,
      logPath: outputPath,
    });
    let exited = false;
    const hasExited = () => {
      if (!exited && !this.isAlive(pid)) exited = true;
      return exited;
    };
    // A daemon's exit is not observable as an event, so it is polled.
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!hasExited()) return;
        clearInterval(timer);
        resolve();
      }, EXIT_POLL_MS);
      timer.unref();
    });
    return { pid, exited: done, hasExited };
  }

  async findChildPid(pid: number): Promise<number | null> {
    if (process.platform === 'linux') {
      try {
        const tasks = await readdir(`/proc/${pid}/task`);
        for (const tid of tasks) {
          const children = (await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')).trim();
          if (children) return Number(children.split(/\s+/)[0]);
        }
        return null;
      } catch {
        return null;
      }
    }
    const result = await this.executor.run({
      argv: ['pgrep', '-P', String(pid)],
      mode: 'pipe',
      timeout: 5_000,
    });
    const first = result.success ? result.stdout.trim().split(/\s+/)[0] : '';
    return first ? Number(first) : null;
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (process.platform !== 'linux') return true;
    try {
      // A zombie still answers signal 0; its parent has not reaped it yet.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch {
      return false;
    }
  }

  kill(pid: number): void {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
