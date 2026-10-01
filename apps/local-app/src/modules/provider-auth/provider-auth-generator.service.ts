import { applyProviderCliNoUpdate } from '../providers/adapters/provider-cli-policy';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { STORAGE_SERVICE, type ProviderStorage } from '../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import {
  StandaloneTerminalService,
  isProcessAlive,
} from '../terminal/services/standalone-terminal.service';
import {
  PROVIDER_AUTH_ADAPTERS,
  PROVIDER_AUTH_ENV_KEY_PATTERN,
  PROVIDER_AUTH_LOGIN_ADAPTERS,
  type ProviderAuthBinResolver,
  type ProviderAuthGeneratedEntry,
  type ProviderAuthLoginAdapter,
  type ProviderAuthLoginEnv,
} from './provider-auth-adapters';
import type { ProviderAuthEntryDto } from './provider-auth.dto';
import { ProviderAuthVaultService } from './provider-auth-vault.service';

const logger = createLogger('ProviderAuthGeneratorService');

export const PROVIDER_AUTH_GENERATOR_OPTIONS = Symbol('PROVIDER_AUTH_GENERATOR_OPTIONS');

export interface ProviderAuthGeneratorOptions {
  /** Parent of the isolated dirs. */
  baseDir?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  commandTimeoutMs?: number;
}

export type ProviderAuthGenerationState =
  | 'waiting'
  | 'verifying'
  | 'stored'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface ProviderAuthGeneration {
  id: string;
  provider: string;
  /** The terminal the UI attaches to; it ends when the generation does. */
  sessionId: string;
  state: ProviderAuthGenerationState;
  startedAt: string;
  finishedAt: string | null;
  entries: ProviderAuthEntryDto[];
  error: string | null;
}

interface RunningGeneration {
  view: ProviderAuthGeneration;
  adapter: ProviderAuthLoginAdapter;
  dir: string;
  label: string;
  bin: ProviderAuthBinResolver;
  deadline: number;
  lastSnapshot: string | null;
  timer: NodeJS.Timeout | null;
  /** Set when the generation starts to finish; the view flips once cleanup is done. */
  finishing: Promise<void> | null;
}

interface CommandResult {
  code: number | null;
  output: string;
  stdout: string;
}

const OUTPUT_LIMIT = 64 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const FINISHED_KEPT = 50;

/** Generic credential shapes, redacted even when not among the captured values. */
const SECRET_PATTERNS = [
  /\bgh[opsur]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
];

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * DevChain's environment with the isolation applied. Entries the process
 * executor refuses (odd names, multi-line values) are dropped.
 */
export function buildLoginEnv(
  base: NodeJS.ProcessEnv,
  change: ProviderAuthLoginEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      PROVIDER_AUTH_ENV_KEY_PATTERN.test(key) &&
      !CONTROL_CHARS.test(value)
    )
      env[key] = value;
  }
  for (const key of change.unset) delete env[key];
  return { ...env, ...change.set };
}

/**
 * The pane's argv. tmux gives a new pane the server's environment, not
 * DevChain's, so every isolation variable is set through `env`.
 */
export function loginArgv(argv: string[], change: ProviderAuthLoginEnv): string[] {
  return [
    '/usr/bin/env',
    ...change.unset.flatMap((key) => ['-u', key]),
    ...Object.entries(change.set).map(([key, value]) => `${key}=${value}`),
    ...argv,
  ];
}

/** The absolute path `command` runs as, from PATH unless it is a path already. */
export async function resolveExecutable(
  command: string,
  path: string | undefined,
): Promise<string | null> {
  const candidates = command.includes('/')
    ? [command]
    : (path ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    const ok = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return candidate;
  }
  return null;
}

/**
 * Produces a vault entry from a fresh login made in an isolated config
 * directory on this PC. The login runs in a DevChain terminal the user
 * attaches to, so the browser flow happens here as usual. The PC's own
 * provider directories and keyring are never used.
 */
@Injectable()
export class ProviderAuthGeneratorService implements OnModuleInit, OnModuleDestroy {
  private readonly generations = new Map<string, RunningGeneration>();
  /** Providers between the running-login check and registration. */
  private readonly starting = new Set<string>();
  private readonly baseDir: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly vault: ProviderAuthVaultService,
    private readonly terminals: StandaloneTerminalService,
    private readonly adapters: ProviderAdapterFactory,
    private readonly executor: ProcessExecutor,
    @Inject(STORAGE_SERVICE) private readonly storage: Pick<ProviderStorage, 'listProviders'>,
    @Optional()
    @Inject(PROVIDER_AUTH_GENERATOR_OPTIONS)
    options: ProviderAuthGeneratorOptions | null = null,
  ) {
    // Not under a dot-directory: the snap-packaged gh cannot write there.
    this.baseDir = options?.baseDir ?? join(homedir(), 'devchain-auth-gen');
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.timeoutMs = options?.timeoutMs ?? 10 * 60_000;
    this.commandTimeoutMs = options?.commandTimeoutMs ?? 120_000;
  }

  /**
   * Isolated dirs of a process that no longer runs hold logins nobody can
   * complete. Dir names start with the owning pid: other DevChain instances of
   * this OS user share the base dir.
   */
  async onModuleInit(): Promise<void> {
    const names = await readdir(this.baseDir).catch(() => [] as string[]);
    for (const name of names) {
      const pid = Number(name.split('-')[0]);
      if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
      await rm(join(this.baseDir, name), { recursive: true, force: true }).catch((error: unknown) =>
        logger.warn({ error: String(error) }, 'Could not remove a leftover isolated login dir'),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const running of this.generations.values()) {
      await this.finish(running, 'cancelled', null);
    }
  }

  async start(provider: string, label?: string): Promise<ProviderAuthGeneration> {
    const name = provider.trim().toLowerCase();
    if (!this.adapters.isSupported(name)) {
      throw new ValidationError(`Provider "${provider}" is not supported.`, {
        reason: 'provider_not_supported',
        supported: this.adapters.getSupportedProviders(),
      });
    }
    const adapter = PROVIDER_AUTH_LOGIN_ADAPTERS[name];
    if (!adapter) {
      const storage = PROVIDER_AUTH_ADAPTERS[name];
      throw new ValidationError(
        storage?.payloadKind === 'env'
          ? `Provider "${name}" has no isolated login; paste its token instead.`
          : `Provider "${name}" has no isolated login.`,
        { reason: 'provider_auth_paste_only' },
      );
    }
    const running = [...this.generations.values()].find(
      (generation) => generation.view.provider === name && !generation.finishing,
    );
    if (running || this.starting.has(name)) {
      throw new ConflictError(`A ${name} login is already running.`, {
        code: 'PROVIDER_AUTH_GENERATION_RUNNING',
        generationId: running?.view.id,
      });
    }
    this.starting.add(name);
    try {
      return await this.launch(name, adapter, label);
    } finally {
      this.starting.delete(name);
    }
  }

  private async launch(
    name: string,
    adapter: ProviderAuthLoginAdapter,
    label: string | undefined,
  ): Promise<ProviderAuthGeneration> {
    const bin = await this.binResolver(adapter);
    const id = randomUUID();
    const dir = join(this.baseDir, `${process.pid}-${id}`);
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    for (const sub of adapter.prepareDirs) await mkdir(join(dir, sub), { mode: 0o700 });

    try {
      const command = applyProviderCliNoUpdate(name, adapter.loginCommand(bin));
      const isolation = adapter.isolationEnv(dir);
      const argv = loginArgv(command.argv, {
        ...isolation,
        set: { ...isolation.set, ...command.env },
      });
      const terminal = await this.terminals.start(argv, { cwd: dir });
      const now = new Date();
      const running: RunningGeneration = {
        view: {
          id,
          provider: name,
          sessionId: terminal.sessionId,
          state: 'waiting',
          startedAt: now.toISOString(),
          finishedAt: null,
          entries: [],
          error: null,
        },
        adapter,
        dir,
        label: label?.trim() || `${name} login ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
        bin,
        deadline: now.getTime() + this.timeoutMs,
        lastSnapshot: null,
        timer: null,
        finishing: null,
      };
      this.generations.set(id, running);
      this.pruneFinished();
      logger.info(
        { generationId: id, provider: name, sessionId: terminal.sessionId },
        'Login started',
      );
      this.schedule(running);
      return { ...running.view };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  get(id: string): ProviderAuthGeneration {
    const running = this.generations.get(id);
    if (!running) throw new NotFoundError('Provider auth generation', id);
    return { ...running.view, entries: [...running.view.entries] };
  }

  async cancel(id: string): Promise<ProviderAuthGeneration> {
    const running = this.generations.get(id);
    if (!running) throw new NotFoundError('Provider auth generation', id);
    await this.finish(running, 'cancelled', null);
    return this.get(id);
  }

  private schedule(running: RunningGeneration): void {
    running.timer = setTimeout(() => {
      running.timer = null;
      void this.tick(running).catch(async (error: unknown) => {
        logger.error({ generationId: running.view.id, error: String(error) }, 'Login failed');
        await this.finish(running, 'failed', 'The login could not be stored.');
      });
    }, this.pollIntervalMs);
    running.timer.unref?.();
  }

  private async tick(running: RunningGeneration): Promise<void> {
    if (running.finishing) return;
    if (Date.now() > running.deadline) {
      await this.finish(running, 'timed_out', 'No login was captured within the time limit.');
      return;
    }
    const terminalRunning = await this.terminals.isRunning(running.view.sessionId);
    const entries = await this.capture(running, terminalRunning);
    if (running.finishing) return;
    if (!entries) {
      if (!terminalRunning) {
        await this.finish(
          running,
          'failed',
          'The login terminal closed before a login was captured.',
        );
        return;
      }
      this.schedule(running);
      return;
    }

    running.view.state = 'verifying';
    const verify = running.adapter.verifyCommand(running.dir, entries, running.bin);
    const result = await this.runCommand(
      running.view.provider,
      verify.argv,
      verify.env,
      running.dir,
    );
    if (running.finishing) return;
    const secrets = entries.flatMap((entry) => entry.secrets);
    if (result.code !== 0 || !verify.accepts(result.output)) {
      const output = redactSecrets(result.output.trim(), secrets).slice(-4000);
      await this.finish(
        running,
        'failed',
        `The login did not verify (${[basename(verify.argv[0]), ...verify.argv.slice(1)].join(' ')} exited ${result.code ?? 'on a signal'}):\n${output}`,
      );
      return;
    }
    running.view.entries = await this.vault.createGenerated(
      running.view.provider,
      running.label,
      entries,
      new Date().toISOString(),
    );
    await this.finish(running, 'stored', null);
  }

  /**
   * The parsed login once it is complete: it parses and did not change since
   * the previous poll, or the login command has exited.
   */
  private async capture(
    running: RunningGeneration,
    terminalRunning: boolean,
  ): Promise<ProviderAuthGeneratedEntry[] | null> {
    const { adapter, dir } = running;
    let captured: Record<string, string> | string;
    if (adapter.capture.kind === 'files') {
      const files: Record<string, string> = {};
      for (const file of adapter.capture.files) {
        const content = await readFile(join(dir, file), 'utf8').catch(() => null);
        if (content === null) return null;
        files[file] = content;
      }
      captured = files;
    } else {
      const ready = await stat(join(dir, adapter.capture.whenFile)).catch(() => null);
      if (!ready) return null;
      const result = await this.runCommand(
        running.view.provider,
        adapter.capture.command(running.bin),
        adapter.isolationEnv(dir),
        dir,
      );
      if (result.code !== 0) return null;
      captured = result.stdout;
    }

    let entries: ProviderAuthGeneratedEntry[];
    try {
      entries = adapter.parse(captured);
    } catch {
      return null;
    }
    const snapshot = JSON.stringify(captured);
    const stable = snapshot === running.lastSnapshot;
    running.lastSnapshot = snapshot;
    return stable || !terminalRunning ? entries : null;
  }

  /** Ends the terminal and removes the isolated dir; the first caller decides the outcome. */
  private finish(
    running: RunningGeneration,
    state: ProviderAuthGenerationState,
    error: string | null,
  ): Promise<void> {
    running.finishing ??= (async () => {
      if (running.timer) clearTimeout(running.timer);
      running.timer = null;
      const message =
        state === 'stored' ? 'Login stored in the provider auth vault.' : `Login ${state}.`;
      await this.terminals
        .end(running.view.sessionId, message)
        .catch((cause: unknown) =>
          logger.warn(
            { generationId: running.view.id, error: String(cause) },
            'Could not end terminal',
          ),
        );
      await rm(running.dir, { recursive: true, force: true });
      running.view.state = state;
      running.view.error = error;
      running.view.finishedAt = new Date().toISOString();
      logger.info({ generationId: running.view.id, state }, 'Login finished');
    })();
    return running.finishing;
  }

  private pruneFinished(): void {
    const finished = [...this.generations.values()].filter((running) => running.view.finishedAt);
    for (const running of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) {
      this.generations.delete(running.view.id);
    }
  }

  /**
   * Resolves every CLI the adapter runs to an absolute path before the login
   * starts: a provider's configured binary, as agent sessions use, else PATH.
   * A missing CLI is refused here, since a pane that exits at once shows nothing.
   */
  private async binResolver(adapter: ProviderAuthLoginAdapter): Promise<ProviderAuthBinResolver> {
    const { items } = await this.storage.listProviders();
    const configured = new Map(
      items.filter((row) => row.binPath).map((row) => [row.name.toLowerCase(), row.binPath!]),
    );
    const wanted = new Set<string>();
    const record: ProviderAuthBinResolver = (cli) => {
      wanted.add(cli);
      return cli;
    };
    adapter.loginCommand(record);
    adapter.verifyCommand('', [], record);
    if (adapter.capture.kind === 'command') adapter.capture.command(record);

    const resolved = new Map<string, string>();
    for (const cli of wanted) {
      const path = await resolveExecutable(configured.get(cli) ?? cli, process.env.PATH);
      if (!path) {
        throw new ValidationError(
          `"${configured.get(cli) ?? cli}" was not found. Install it, or set the provider's binary path.`,
          { reason: 'provider_cli_missing', cli },
        );
      }
      resolved.set(cli, path);
    }
    return (cli) => resolved.get(cli) ?? cli;
  }

  /** No input, so stdin is /dev/null: several CLIs wait on stdin when it is not a terminal. */
  private async runCommand(
    providerName: string,
    argv: string[],
    change: ProviderAuthLoginEnv,
    cwd: string,
  ): Promise<CommandResult> {
    const command = applyProviderCliNoUpdate(providerName, argv);
    const result = await this.executor.run({
      argv: command.argv,
      mode: 'pipe',
      cwd,
      env: buildLoginEnv(process.env, { ...change, set: { ...change.set, ...command.env } }),
      timeout: this.commandTimeoutMs,
      outputLimits: { maxBytes: OUTPUT_LIMIT },
    });
    const output = [result.stdout, result.stderr, result.timedOut ? '(timed out)' : '']
      .filter(Boolean)
      .join('\n');
    return { code: result.exitCode, output, stdout: result.stdout };
  }
}
