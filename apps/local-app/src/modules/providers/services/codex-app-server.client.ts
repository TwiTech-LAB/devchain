import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { getAppVersion } from '../../../common/app-version';
import { IOError, TimeoutError } from '../../../common/errors/error-types';
import { isRecord } from '../adapters/plugin-catalog.utils';
import { ensurePrivateCwd } from '../utils/private-cwd';

const KILL_GRACE_MS = 2_000;
const NEWLINE = 0x0a;
const INITIALIZE_ID = 1;
const REQUEST_ID = 2;

export interface CodexAppServerRequest {
  /** The full command: the binary, its policy args and `app-server`. */
  argv: readonly string[];
  env: Record<string, string>;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Sends one JSON-RPC request to `codex app-server` (one JSON object per line over stdio) and
 * resolves with its `result`. The server exits as soon as stdin reaches EOF, so stdin stays
 * open until the reply arrives; `ProcessExecutor.run()` closes stdin and cannot drive it.
 */
@Injectable()
export class CodexAppServerClient {
  async request(request: CodexAppServerRequest): Promise<unknown> {
    const cwd = await ensurePrivateCwd('provider-cli', 'codex-app-server');
    return runRequest(request, cwd);
  }
}

function runRequest(request: CodexAppServerRequest, cwd: string): Promise<unknown> {
  const { argv, env, method, params, timeoutMs, maxOutputBytes } = request;
  const label = `codex app-server ${method}`;

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // A reply can be one line of many MB, so only each new chunk is searched for a line end.
    let pending: Buffer[] = [];
    let bytes = 0;
    let done = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const stop = (): void => {
      clearTimeout(timer);
      if (exited) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const finish = (outcome: { value: unknown } | { error: Error }): void => {
      if (done) return;
      done = true;
      pending = [];
      stop();
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const timer = setTimeout(
      () => finish({ error: new TimeoutError(`${label} timed out`, { timeoutMs }) }),
      timeoutMs,
    );

    const handleLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      // Server notifications and server-to-client requests carry a method; replies do not.
      if (!isRecord(message) || 'method' in message) return;
      if (message.id === INITIALIZE_ID) {
        if (message.error !== undefined) {
          return finish({ error: new IOError(`${label}: initialize was rejected`) });
        }
        send({ method: 'initialized' });
        send({ id: REQUEST_ID, method, params });
      } else if (message.id === REQUEST_ID) {
        if (message.error !== undefined || !('result' in message)) {
          return finish({ error: new IOError(`${label} returned an error`) });
        }
        finish({ value: message.result });
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        return finish({
          error: new IOError(`${label} output exceeded the size limit`, { maxOutputBytes }),
        });
      }
      let start = 0;
      let newline = chunk.indexOf(NEWLINE);
      while (newline >= 0 && !done) {
        pending.push(chunk.subarray(start, newline));
        const line = Buffer.concat(pending).toString('utf8').trim();
        pending = [];
        if (line) handleLine(line);
        start = newline + 1;
        newline = chunk.indexOf(NEWLINE, start);
      }
      if (!done && start < chunk.length) pending.push(chunk.subarray(start));
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => finish({ error: new IOError(`${label} failed to start`) }));
    child.on('close', () => {
      exited = true;
      clearTimeout(killTimer);
      finish({ error: new IOError(`${label} exited before replying`) });
    });

    send({
      id: INITIALIZE_ID,
      method: 'initialize',
      params: { clientInfo: { name: 'devchain', version: getAppVersion() } },
    });
  });
}
