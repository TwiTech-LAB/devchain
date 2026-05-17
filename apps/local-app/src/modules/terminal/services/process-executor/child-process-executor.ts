import { ChildProcess, spawn } from 'child_process';
import { open } from 'fs/promises';
import { StringDecoder } from 'string_decoder';
import { Injectable } from '@nestjs/common';
import {
  ProcessExecutor,
  ProcessExecutorOptions,
  ExecutorResult,
  DaemonSpawnOptions,
  DaemonSpawnResult,
  validateEnv,
} from './process-executor.port';

@Injectable()
export class ChildProcessExecutor extends ProcessExecutor {
  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    if (options.env) validateEnv(options.env);

    const [command, ...args] = options.argv;
    if (!command) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    }

    return new Promise<ExecutorResult>((resolve) => {
      const maxBytes = options.outputLimits?.maxBytes;
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      // StringDecoder buffers incomplete multi-byte UTF-8 sequences across
      // chunk boundaries so multi-byte chars (⎿, —, Cyrillic, etc.) survive
      // pipe-chunked output from tmux capture-pane and similar long captures.
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...options.env } : undefined,
        stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
      });

      child.stdout!.on('data', (data: Buffer) => {
        const chunk = stdoutDecoder.write(data);
        if (maxBytes !== undefined) {
          const remaining = maxBytes - stdoutBytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          if (chunk.length > remaining) {
            stdout += chunk.slice(0, remaining);
            stdoutBytes = maxBytes;
            truncated = true;
            return;
          }
        }
        stdout += chunk;
        stdoutBytes += chunk.length;
      });

      child.stderr!.on('data', (data: Buffer) => {
        const chunk = stderrDecoder.write(data);
        if (maxBytes !== undefined) {
          const remaining = maxBytes - stderrBytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          if (chunk.length > remaining) {
            stderr += chunk.slice(0, remaining);
            stderrBytes = maxBytes;
            truncated = true;
            return;
          }
        }
        stderr += chunk;
        stderrBytes += chunk.length;
      });

      const flushDecoders = () => {
        const outTail = stdoutDecoder.end();
        if (outTail) stdout += outTail;
        const errTail = stderrDecoder.end();
        if (errTail) stderr += errTail;
      };

      if (options.input && child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }

      if (options.timeout && options.timeout > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {}
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, 2000);
        }, options.timeout);
      }

      child.on('error', () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        flushDecoders();
        resolve({
          success: false,
          exitCode: null,
          stdout,
          stderr,
          timedOut: false,
          truncated,
        });
      });

      child.on('close', (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        flushDecoders();
        resolve({
          success: !timedOut && code === 0,
          exitCode: timedOut ? null : code,
          stdout,
          stderr,
          timedOut,
          truncated,
        });
      });
    });
  }

  async spawnDaemon(options: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
    const [command, ...args] = options.argv;
    if (!command) {
      throw new Error('spawnDaemon: argv must not be empty');
    }

    const logFile = await open(options.logPath, 'a');
    try {
      const child = spawn(command, args, {
        cwd: options.cwd,
        detached: true,
        stdio: ['ignore', logFile.fd, logFile.fd],
        env: options.env as NodeJS.ProcessEnv | undefined,
        shell: false,
      });

      const pid = await awaitDaemonPid(child);
      child.unref();
      return { pid };
    } finally {
      await logFile.close().catch(() => undefined);
    }
  }
}

function awaitDaemonPid(child: ChildProcess): Promise<number> {
  if (typeof child.pid === 'number') {
    return Promise.resolve(child.pid);
  }
  return new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = () => {
      cleanup();
      if (typeof child.pid !== 'number') {
        reject(new Error('Daemon process started without a PID'));
        return;
      }
      resolve(child.pid);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
