import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type RuntimeProtection = 'memory' | 'disk';

export interface ResolvedRuntimeDirectory {
  readonly path: string;
  readonly protection: RuntimeProtection;
  /** The user can get `memory` protection by enabling systemd linger. */
  readonly lingerHint: boolean;
}

export interface RuntimeDirectoryEnv {
  readonly RUNTIME_DIRECTORY?: string;
  readonly XDG_RUNTIME_DIR?: string;
  readonly TMPDIR?: string;
}

/** Host facts the resolver reads; tests replace them at this seam. */
export interface RuntimeDirectoryHost {
  readonly platform: NodeJS.Platform;
  readonly dbPath: string;
  env(): RuntimeDirectoryEnv;
  isLingering(): boolean;
  /** `statfs` f_type of the path, or null when the path cannot be checked. */
  fileSystemType(path: string): Promise<number | null>;
}

export const RUNTIME_DIRECTORY_HOST = Symbol('RUNTIME_DIRECTORY_HOST');

const TMPFS_MAGIC = 0x01021994;
const LINGER_DIRECTORY = '/var/lib/systemd/linger';

export function runtimeInstanceId(dbPath: string): string {
  return createHash('sha256').update(resolve(dbPath)).digest('hex').slice(0, 12);
}

/**
 * Order: `<$RUNTIME_DIRECTORY>/<instance>` (systemd), then `$XDG_RUNTIME_DIR` on Linux only when the user
 * lingers (pam_systemd deletes it at the last logout, while tmux sessions keep running), then
 * macOS `$TMPDIR`, then `<db dir>/runtime-context/<instance>`. `/dev/shm` is never used: logind
 * `RemoveIPC=yes` empties it at the last logout too.
 */
export async function resolveRuntimeDirectory(
  host: RuntimeDirectoryHost,
): Promise<ResolvedRuntimeDirectory> {
  const env = host.env();
  const roots = instanceRoots(host, env);

  if (roots.systemd && roots.systemdRoot) {
    return {
      path: roots.systemd,
      protection: (await isTmpfs(host, roots.systemdRoot)) ? 'memory' : 'disk',
      lingerHint: false,
    };
  }
  if (roots.xdg) {
    if (!host.isLingering()) {
      return { path: roots.fallback, protection: 'disk', lingerHint: true };
    }
    if (await isTmpfs(host, dirname(roots.xdg))) {
      return { path: roots.xdg, protection: 'memory', lingerHint: false };
    }
  }
  if (roots.macTmp) {
    return { path: roots.macTmp, protection: 'disk', lingerHint: false };
  }
  return { path: roots.fallback, protection: 'disk', lingerHint: false };
}

/**
 * The bare systemd `$RUNTIME_DIRECTORY` (one per unit user, not per instance), never a
 * fallback: the VM Vault cache must stay in memory, so a caller refuses when this is null
 * or not tmpfs.
 */
export async function resolveSystemdRuntimeDirectory(
  host: RuntimeDirectoryHost,
): Promise<{ path: string; tmpfs: boolean } | null> {
  const path = instanceRoots(host, host.env()).systemdRoot;
  return path ? { path, tmpfs: await isTmpfs(host, path) } : null;
}

/**
 * Every root this instance can resolve to, so a startup sweep also finds older locations. The
 * bare systemd root and the shared pre-instance root `<db dir>/runtime-context` are in the list:
 * sweeping their `launch/` and `session-files/` only removes leftovers from before per-instance
 * roots, because no current instance writes there.
 */
export function runtimeDirectoryCandidates(host: RuntimeDirectoryHost): string[] {
  const roots = instanceRoots(host, host.env());
  const candidates = [
    roots.systemd,
    roots.systemdRoot,
    roots.xdg,
    roots.macTmp,
    roots.fallback,
    roots.legacy,
  ];
  return [...new Set(candidates.filter((root): root is string => root !== null))];
}

export function systemRuntimeDirectoryHost(dbPath: string): RuntimeDirectoryHost {
  return {
    platform: process.platform,
    dbPath,
    env: () => ({
      RUNTIME_DIRECTORY: process.env.RUNTIME_DIRECTORY,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      TMPDIR: process.env.TMPDIR,
    }),
    isLingering: () => existsSync(join(LINGER_DIRECTORY, userInfo().username)),
    fileSystemType: async (path) => {
      try {
        return (await statfs(path)).type;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The DB file of the open connection names the instance. An in-memory DB has no durable
 * instance, so it gets a directory of its own for this process.
 */
export function runtimeDirectoryDbPath(sqliteFileName: string): string {
  if (sqliteFileName && sqliteFileName !== ':memory:') return sqliteFileName;
  return join(tmpdir(), `devchain-memory-${process.pid}`, 'devchain.db');
}

interface InstanceRoots {
  /** `<systemdRoot>/<instance>`: several DevChain processes can inherit one `$RUNTIME_DIRECTORY`. */
  readonly systemd: string | null;
  readonly systemdRoot: string | null;
  readonly xdg: string | null;
  readonly macTmp: string | null;
  readonly fallback: string;
  readonly legacy: string;
}

function instanceRoots(host: RuntimeDirectoryHost, env: RuntimeDirectoryEnv): InstanceRoots {
  const instanceDirectory = `devchain-${runtimeInstanceId(host.dbPath)}`;
  // systemd joins several RuntimeDirectory= entries with ':'; the first one is ours.
  const systemdRoot = absoluteOrNull(env.RUNTIME_DIRECTORY?.split(':')[0]);
  const xdg = host.platform === 'linux' ? absoluteOrNull(env.XDG_RUNTIME_DIR) : null;
  const macTmp = host.platform === 'darwin' ? absoluteOrNull(env.TMPDIR) : null;
  // Several DB files can share one directory (`DB_FILENAME`), so the fallback is per instance.
  const legacy = join(dirname(host.dbPath), 'runtime-context');
  return {
    systemd: systemdRoot && join(systemdRoot, instanceDirectory),
    systemdRoot,
    xdg: xdg && join(xdg, instanceDirectory),
    macTmp: macTmp && join(macTmp, instanceDirectory),
    fallback: join(legacy, instanceDirectory),
    legacy,
  };
}

function absoluteOrNull(path: string | undefined): string | null {
  return path && isAbsolute(path) ? path : null;
}

async function isTmpfs(host: RuntimeDirectoryHost, path: string): Promise<boolean> {
  return host.platform === 'linux' && (await host.fileSystemType(path)) === TMPFS_MAGIC;
}
