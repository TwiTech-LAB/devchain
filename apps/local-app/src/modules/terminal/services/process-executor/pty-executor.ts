import * as pty from 'node-pty';
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
export class PtyExecutor extends ProcessExecutor {
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
      let buffer = '';
      let bufferBytes = 0;
      let truncated = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const disposables: pty.IDisposable[] = [];

      const cleanup = () => {
        for (const d of disposables) d.dispose();
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      let ptyProcess: pty.IPty;
      try {
        ptyProcess = pty.spawn(command, [...args], {
          name: 'xterm-256color',
          cols: 200,
          rows: 30,
          cwd: options.cwd,
          env: options.env ? { ...options.env } : (process.env as Record<string, string>),
        });
      } catch (error) {
        resolve({
          success: false,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
        });
        return;
      }

      disposables.push(
        ptyProcess.onData((data: string) => {
          if (maxBytes !== undefined) {
            const remaining = maxBytes - bufferBytes;
            if (remaining <= 0) {
              truncated = true;
              return;
            }
            if (data.length > remaining) {
              buffer += data.slice(0, remaining);
              bufferBytes = maxBytes;
              truncated = true;
              return;
            }
          }
          buffer += data;
          bufferBytes += data.length;
        }),
      );

      if (options.input) {
        ptyProcess.write(options.input);
      }

      disposables.push(
        ptyProcess.onExit(({ exitCode }) => {
          setImmediate(() => {
            cleanup();
            resolve({
              success: !timedOut && exitCode === 0,
              exitCode: timedOut ? null : exitCode,
              stdout: buffer,
              stderr: '',
              timedOut,
              truncated,
            });
          });
        }),
      );

      if (options.timeout && options.timeout > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          try {
            ptyProcess.kill('SIGTERM');
          } catch {}
          killTimer = setTimeout(() => {
            try {
              ptyProcess.kill('SIGKILL');
            } catch {}
          }, 2000);
        }, options.timeout);
      }
    });
  }

  async spawnDaemon(_options: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
    throw new Error('spawnDaemon is not supported by PtyExecutor');
  }
}
