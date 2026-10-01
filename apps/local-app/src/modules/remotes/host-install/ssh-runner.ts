import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Client, type AuthenticationType, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { AppError } from '../../../common/errors/error-types';

const KEEPALIVE_INTERVAL_MS = 10_000;
const READY_TIMEOUT_MS = 20_000;
export const SSH_COMMAND_TIMEOUT_MS = 30_000;
export const SSH_MAX_CAPTURE_BYTES = 1_000_000;

export interface SshCredentials {
  user: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface SshConnectionOptions {
  host: string;
  /** Production callers use 22; tests may bind an ephemeral loopback port. */
  port?: number;
  credentials: SshCredentials;
  expectedFingerprint?: string;
}

export interface SshCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshExecOptions {
  timeoutMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface SshSession {
  readonly fingerprint: string;
  exec(command: string, stdin?: string, options?: SshExecOptions): Promise<SshCommandResult>;
  uploadTemp(contents: string, options?: SshExecOptions): Promise<string>;
}

export class SshRunnerError extends AppError {
  constructor(code: string, message: string) {
    super(message, code, 502);
  }
}

@Injectable()
export class SshRunner {
  async connect(options: SshConnectionOptions): Promise<string> {
    return this.withSession(options, async (session) => session.fingerprint);
  }

  async withSession<T>(
    options: SshConnectionOptions,
    use: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    const client = new Client();
    const secrets = credentialValues(options.credentials);
    let fingerprint = '';
    let hostKeyChanged = false;
    let methodsLeft: AuthenticationType[] | null = null;
    const authMethod: AuthenticationType = options.credentials.privateKey
      ? 'publickey'
      : 'password';
    const config: ConnectConfig = {
      host: options.host,
      port: options.port ?? 22,
      username: options.credentials.user,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: 3,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        fingerprint = fingerprintFor(key);
        const accepted =
          options.expectedFingerprint === undefined || options.expectedFingerprint === fingerprint;
        hostKeyChanged = !accepted;
        return accepted;
      },
      ...(options.credentials.password ? { password: options.credentials.password } : {}),
      ...(options.credentials.privateKey ? { privateKey: options.credentials.privateKey } : {}),
      ...(options.credentials.passphrase ? { passphrase: options.credentials.passphrase } : {}),
      authHandler: ((offered: AuthenticationType[] | null) => {
        if (offered === null) return authMethod;
        methodsLeft = offered;
        return false;
      }) as NonNullable<ConnectConfig['authHandler']>,
    };

    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        client.end();
        reject(classifyConnectError(error, options, hostKeyChanged, methodsLeft, secrets));
      };
      client.once('ready', () => {
        client.removeListener('error', fail);
        client.on('error', () => undefined);
        resolve();
      });
      client.once('error', fail);
      try {
        client.connect(config);
      } catch (error) {
        client.removeListener('error', fail);
        const cause = error instanceof Error ? error : new Error(String(error));
        client.end();
        reject(
          isKeyParseError(cause)
            ? new SshRunnerError(
                'SSH_KEY_INVALID',
                `The SSH private key is invalid: ${scrub(cause.message, secrets)}`,
              )
            : new SshRunnerError(
                'SSH_CONNECT_FAILED',
                `SSH connection failed: ${scrub(cause.message, secrets)}`,
              ),
        );
      }
    });

    const session = new ClientSshSession(client, fingerprint, secrets);
    try {
      return await use(session);
    } catch (error) {
      throw sanitizeError(error, secrets);
    } finally {
      client.end();
    }
  }
}

function classifyConnectError(
  error: Error,
  options: SshConnectionOptions,
  hostKeyChanged: boolean,
  methodsLeft: AuthenticationType[] | null,
  secrets: readonly string[],
): SshRunnerError {
  if (hostKeyChanged) {
    return new SshRunnerError(
      'SSH_HOST_KEY_CHANGED',
      'The SSH host key changed since the first connection.',
    );
  }
  if ((error as Error & { level?: string }).level === 'client-authentication') {
    const chosen: AuthenticationType = options.credentials.privateKey ? 'publickey' : 'password';
    const offered = methodsLeft ?? [];
    if (!offered.includes(chosen)) {
      const names = offered.length > 0 ? offered.join(', ') : 'no supported methods';
      const guidance = offered.includes('publickey')
        ? 'Choose a private key.'
        : offered.includes('password')
          ? 'Choose a password.'
          : 'Check the SSH server authentication settings.';
      return new SshRunnerError('SSH_AUTH_FAILED', `The VM accepts only: ${names}. ${guidance}`);
    }
    const user = options.credentials.user;
    return new SshRunnerError(
      'SSH_AUTH_FAILED',
      options.credentials.privateKey
        ? `The VM refused the private key login for ${user}. Check the SSH user and the authorized key.`
        : `The VM refused the password login for ${user}. Check the SSH user and password.`,
    );
  }
  return new SshRunnerError(
    'SSH_CONNECT_FAILED',
    `SSH connection failed: ${scrub(error.message, secrets)}`,
  );
}

function isKeyParseError(error: Error): boolean {
  return /(?:Cannot parse privateKey|privateKey value does not contain)/i.test(error.message);
}

class ClientSshSession implements SshSession {
  constructor(
    private readonly client: Client,
    readonly fingerprint: string,
    private readonly secrets: readonly string[],
  ) {}

  exec(command: string, stdin = '', options: SshExecOptions = {}): Promise<SshCommandResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new SshRunnerError('SSH_COMMAND_CANCELLED', 'SSH command cancelled.'));
        return;
      }
      const timeoutMs = resolveSshCommandTimeoutMs(options);
      let settled = false;
      let channelToClose: { close(): void; destroy(): void } | null = null;
      const onClientError = (error: Error) => {
        fail(
          new SshRunnerError(
            'SSH_COMMAND_FAILED',
            `SSH connection failed during the command: ${scrub(error.message, this.secrets)}`,
          ),
        );
      };
      const timer = setTimeout(() => {
        fail(
          new SshRunnerError(
            'SSH_COMMAND_TIMEOUT',
            `SSH command did not finish within ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () =>
        fail(new SshRunnerError('SSH_COMMAND_CANCELLED', 'SSH command cancelled.'), false);
      const fail = (error: Error, closeClient = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.client.removeListener('error', onClientError);
        try {
          channelToClose?.close();
          channelToClose?.destroy();
        } catch {
          // The transport may already have removed the channel.
        }
        try {
          // Cancellation keeps the transport available for remote cleanup commands.
          if (closeClient) {
            this.client.end();
            this.client.destroy();
          }
        } catch {
          // Reject with the classified command error even if teardown raced the peer.
        }
        reject(error);
      };
      this.client.once('error', onClientError);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.client.exec(command, (error, channel) => {
        if (settled) {
          channel?.close();
          channel?.destroy();
          return;
        }
        if (error) {
          fail(
            new SshRunnerError(
              'SSH_COMMAND_FAILED',
              `Could not start the SSH command: ${scrub(error.message, this.secrets)}`,
            ),
          );
          return;
        }
        channelToClose = channel;
        const stdout = new StreamingCapture(this.secrets);
        const stderr = new StreamingCapture(this.secrets);
        channel.on('data', (chunk: Buffer | string) => stdout.push(chunk));
        channel.stderr.on('data', (chunk: Buffer | string) => stderr.push(chunk));
        channel.once('error', (streamError: Error) => {
          fail(
            new SshRunnerError(
              'SSH_COMMAND_FAILED',
              `SSH command stream failed: ${scrub(streamError.message, this.secrets)}`,
            ),
          );
        });
        channel.once('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          this.client.removeListener('error', onClientError);
          resolve({
            code: code ?? 1,
            stdout: stdout.finish(),
            stderr: stderr.finish(),
          });
        });
        if (stdin) channel.end(stdin);
        else channel.end();
      });
    });
  }

  async uploadTemp(contents: string, options: SshExecOptions = {}): Promise<string> {
    const made = await this.exec('mktemp /tmp/devchain-host-install.XXXXXX', '', options);
    const path = made.stdout.trim();
    if (made.code !== 0 || !/^\/tmp\/devchain-host-install\.[A-Za-z0-9]+$/.test(path)) {
      throw new SshRunnerError(
        'SSH_UPLOAD_FAILED',
        `Could not create a remote temporary file: ${made.stderr || 'invalid path returned'}`,
      );
    }
    const sftp = await openSftp(this.client, this.secrets, options);
    try {
      await writeRemoteFile(this.client, sftp, path, contents, this.secrets, options);
    } finally {
      sftp.end();
    }
    return path;
  }
}

function openSftp(
  client: Client,
  secrets: readonly string[],
  options: SshExecOptions,
): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new SshRunnerError('SSH_COMMAND_CANCELLED', 'SSH upload cancelled.'));
      return;
    }
    let settled = false;
    const timeoutMs = resolveSshCommandTimeoutMs(options);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      try {
        client.destroy();
      } catch {
        // The timeout remains authoritative when transport teardown races the peer.
      }
      reject(
        new SshRunnerError(
          'SSH_COMMAND_TIMEOUT',
          `SFTP session did not start within ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new SshRunnerError('SSH_COMMAND_CANCELLED', 'SSH upload cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    client.sftp((error, sftp) => {
      if (settled) {
        sftp?.end();
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(
          new SshRunnerError(
            'SSH_UPLOAD_FAILED',
            `Could not start SFTP: ${scrub(error.message, secrets)}`,
          ),
        );
      } else {
        resolve(sftp);
      }
    });
  });
}

function writeRemoteFile(
  client: Client,
  sftp: SFTPWrapper,
  path: string,
  contents: string,
  secrets: readonly string[],
  options: SshExecOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new SshRunnerError('SSH_COMMAND_CANCELLED', 'SSH upload cancelled.'));
      return;
    }
    let settled = false;
    const timeoutMs = resolveSshCommandTimeoutMs(options);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      try {
        sftp.end();
        client.destroy();
      } catch {
        // The timeout remains authoritative when transport teardown races the peer.
      }
      reject(
        new SshRunnerError(
          'SSH_COMMAND_TIMEOUT',
          `SFTP upload did not finish within ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new SshRunnerError('SSH_COMMAND_CANCELLED', 'SSH upload cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    sftp.writeFile(path, contents, { mode: 0o600 }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(
          new SshRunnerError(
            'SSH_UPLOAD_FAILED',
            `Could not upload the install block: ${scrub(error.message, secrets)}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

function credentialValues(credentials: SshCredentials): string[] {
  return [
    credentials.password,
    credentials.privateKey,
    credentials.passphrase,
    credentials.sudoPassword,
  ]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
}

export function fingerprintFor(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function scrub(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[REDACTED]') : safe),
    value,
  );
}

class StreamingCapture {
  private readonly decoder = new StringDecoder('utf8');
  private readonly redactor: StreamingRedactor;
  private retained = Buffer.alloc(0);

  constructor(secrets: readonly string[]) {
    this.redactor = new StreamingRedactor(secrets, (value) => this.retain(value));
  }

  push(chunk: Buffer | string): void {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.redactor.push(decoded);
  }

  finish(): string {
    this.redactor.push(this.decoder.end());
    this.redactor.finish();
    return this.retained.toString('utf8');
  }

  private retain(value: string): void {
    if (!value) return;
    const incoming = Buffer.from(value);
    if (incoming.length >= SSH_MAX_CAPTURE_BYTES) {
      this.retained = incoming.subarray(incoming.length - SSH_MAX_CAPTURE_BYTES);
      return;
    }
    const overflow = this.retained.length + incoming.length - SSH_MAX_CAPTURE_BYTES;
    if (overflow > 0) this.retained = this.retained.subarray(overflow);
    this.retained = Buffer.concat([this.retained, incoming]);
  }
}

class StreamingRedactor {
  private readonly secrets: readonly string[];
  private readonly holdback: number;
  private carry = '';

  constructor(
    secrets: readonly string[],
    private readonly emit: (value: string) => void,
  ) {
    this.secrets = [...secrets].sort((left, right) => right.length - left.length);
    this.holdback = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }

  push(value: string): void {
    if (!value) return;
    const combined = this.carry + value;
    const safeUntil = Math.max(0, combined.length - this.holdback);
    let cursor = 0;
    for (;;) {
      const match = this.nextMatch(combined, cursor);
      if (!match || match.index >= safeUntil) break;
      this.emit(combined.slice(cursor, match.index));
      this.emit('[REDACTED]');
      cursor = match.index + match.secret.length;
    }
    if (cursor < safeUntil) {
      this.emit(combined.slice(cursor, safeUntil));
      cursor = safeUntil;
    }
    this.carry = combined.slice(cursor);
  }

  finish(): void {
    this.emit(scrub(this.carry, this.secrets));
    this.carry = '';
  }

  private nextMatch(value: string, from: number): { index: number; secret: string } | null {
    let found: { index: number; secret: string } | null = null;
    for (const secret of this.secrets) {
      const index = value.indexOf(secret, from);
      if (index < 0) continue;
      if (
        !found ||
        index < found.index ||
        (index === found.index && secret.length > found.secret.length)
      ) {
        found = { index, secret };
      }
    }
    return found;
  }
}

export function resolveSshCommandTimeoutMs(options: SshExecOptions, now = Date.now()): number {
  const requested =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : SSH_COMMAND_TIMEOUT_MS;
  const remaining =
    options.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)
      ? options.deadlineAt - now
      : requested;
  return Math.max(1, Math.min(requested, remaining));
}

function sanitizeError(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof SshRunnerError) {
    return new SshRunnerError(error.code, scrub(error.message, secrets));
  }
  if (error instanceof AppError) {
    return new AppError(scrub(error.message, secrets), error.code, error.statusCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SshRunnerError('SSH_COMMAND_FAILED', scrub(message, secrets));
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
