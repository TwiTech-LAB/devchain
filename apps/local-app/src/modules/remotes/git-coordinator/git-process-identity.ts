import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

@Injectable()
export class GitProcessIdentity {
  /** false proves exit; null means unknown and keeps admission closed. */
  async read(pid: number): Promise<string | false | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (process.platform === 'darwin') return readDarwin(pid);
    if (process.platform !== 'linux') return null;
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ESRCH' ? false : null;
    }
    try {
      const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      if (fields[0] === 'Z' || fields[0] === 'X') return false;
      return fields[19] && boot.trim() ? `${boot.trim()}:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
}

/** `<boot seconds>:<lstart>`; lstart has one-second resolution, enough against PID reuse. */
async function readDarwin(pid: number): Promise<string | false | null> {
  const env = { PATH: '/bin:/usr/bin:/usr/sbin:/sbin', LC_ALL: 'C' };
  let line: string;
  try {
    line = (await run('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { env })).stdout.trim();
  } catch (error) {
    // ps exits 1 with no output when the PID does not exist.
    const failure = error as { code?: unknown; stdout?: string };
    return failure.code === 1 && !failure.stdout?.trim() ? false : null;
  }
  try {
    const [state, ...start] = line.split(/\s+/);
    if (state?.startsWith('Z')) return false;
    const boot = /sec = (\d+)/.exec(
      (await run('sysctl', ['-n', 'kern.boottime'], { env })).stdout,
    )?.[1];
    return boot && start.length ? `${boot}:${start.join(' ')}` : null;
  } catch {
    return null;
  }
}
