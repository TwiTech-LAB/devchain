import { applyProviderCliNoUpdate } from '../../providers/adapters/provider-cli-policy';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  PROVIDER_AUTH_ENV_KEY_PATTERN,
  PROVIDER_AUTH_VERIFY,
  RESERVED_PROVIDER_AUTH_ENV_KEYS,
  type ProviderAuthClaimBundle,
} from '../../provider-auth/provider-auth-adapters';
import {
  buildLoginEnv,
  redactSecrets,
  resolveExecutable,
} from '../../provider-auth/provider-auth-generator.service';
import {
  familyFilePaths,
  ProviderAuthWatcherService,
  type ProviderAuthFamilyReport,
} from '../../provider-auth/provider-auth-watcher.service';
import { STORAGE_SERVICE, type ProviderStorage } from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { HostHelperService } from './host-helper.service';
import type { HostProviderApplyInput, HostProviderAuthRemoveSpec } from './host-provider-auth.dto';

const logger = createLogger('HostProviderAuthService');

const VERIFY_TIMEOUT_MS = 90_000;
const SUMMARY_LIMIT = 1_000;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_REMOVE_ENV_KEYS = 64;
/**
 * Stored Claude credentials win over `CLAUDE_CODE_OAUTH_TOKEN`, and the TLS
 * files are the VM identity home pins; the bootstrap refuses them too.
 */
export const REFUSED_FILES = [
  '.claude/.credentials.json',
  '.devchain/host.env',
  '.devchain/tls/key.pem',
  '.devchain/tls/cert.pem',
];

export interface HostProviderVerifyResult {
  ok: boolean;
  /** The command's output, with anything token-shaped redacted. */
  summary: string;
  hint: string | null;
}

export interface HostProviderApplyResult {
  envKeys: string[];
  files: string[];
  /** What the removal pass actually took away; missing keys and files are no-ops. */
  removed: HostProviderAuthRemoveSpec;
}

/**
 * `host.env` in the bootstrap's systemd `EnvironmentFile` form:
 * `KEY="value"`, with `\`, `"`, `` ` `` and `$` escaped by a backslash.
 */
export function parseHostEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/\\(.)/g, '$1');
  }
  return env;
}

/** `~/.devchain/host.env`; systemd sets `HOME` for devchain-host.service. */
export function hostEnvFilePath(): string {
  return join(process.env.HOME || homedir(), '.devchain', 'host.env');
}

/** The parsed `host.env`, or no keys when it is missing or unreadable. */
export async function readHostEnvFile(): Promise<Record<string, string>> {
  try {
    return parseHostEnvFile(await readFile(hostEnvFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

export function renderHostEnvFile(env: Record<string, string>): string {
  const lines = ['# Provider environment for devchain-host.service. Written at claim time.'];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}="${value.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Provider logins on a claimed host: checks one provider's login with the
 * same command and pass condition as home, and applies login material home
 * sends after the claim (a re-auth). Files are read by the CLIs at each run;
 * env values reach new sessions through this process and the tmux server.
 */
@Injectable()
export class HostProviderAuthService {
  constructor(
    private readonly helper: HostHelperService,
    private readonly executor: ProcessExecutor,
    private readonly familyWatcher: ProviderAuthWatcherService,
    @Inject(STORAGE_SERVICE) private readonly storage: Pick<ProviderStorage, 'listProviders'>,
  ) {}

  /** systemd sets `HOME` for devchain-host.service. */
  private get home(): string {
    return process.env.HOME || homedir();
  }

  private get envFile(): string {
    return hostEnvFilePath();
  }

  async verify(provider: string, opencodeProviderIds: string[]): Promise<HostProviderVerifyResult> {
    this.helper.assertClaimedHost();
    const check = PROVIDER_AUTH_VERIFY[provider];
    if (!check) {
      throw new ValidationError(`Provider "${provider}" has no login check.`, {
        reason: 'provider_not_supported',
      });
    }
    const hostEnv = await this.readHostEnv();
    const binPath = await this.binPath(provider);
    const argv = check.argv((cli) => (cli === provider ? binPath : cli));
    const command = applyProviderCliNoUpdate(provider, argv);
    const result = await this.executor.run({
      argv: command.argv,
      mode: 'pipe',
      cwd: this.home,
      env: buildLoginEnv(process.env, { set: { ...hostEnv, ...command.env }, unset: [] }),
      timeout: VERIFY_TIMEOUT_MS,
      outputLimits: { maxBytes: 64 * 1024 },
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const summary = redactSecrets(output.trim(), Object.values(hostEnv)).slice(-SUMMARY_LIMIT);
    if (result.timedOut) {
      return { ok: false, summary, hint: 'The check timed out.' };
    }
    const outcome = check.check(output, { opencodeProviderIds });
    const ok = result.exitCode === 0 && outcome.ok;
    logger.info({ provider, ok, exitCode: result.exitCode }, 'Checked provider login');
    return {
      ok,
      summary,
      hint: ok ? null : outcome.ok ? `The check exited ${result.exitCode}.` : outcome.hint,
    };
  }

  /**
   * The changed login files home pulls on its health poll. The answer carries
   * credentials, so — like apply — it exists only on a claimed host and logs
   * providers, never content.
   */
  async families(sinceMs: number): Promise<ProviderAuthFamilyReport[]> {
    this.helper.assertClaimedHost();
    return this.familyWatcher.getFamilies(sinceMs);
  }

  /** Writes the files and merges the env into `host.env`; returns what changed, never values. */
  async apply(bundle: HostProviderApplyInput): Promise<HostProviderApplyResult> {
    this.helper.assertClaimedHost();
    if (bundle.files.length > MAX_FILES) {
      throw new ValidationError(`At most ${MAX_FILES} files.`, {
        reason: 'provider_auth_too_many',
      });
    }
    const files = bundle.files.map((file) => this.validateFile(file));
    const envKeys = Object.keys(bundle.env);
    for (const [key, value] of Object.entries(bundle.env)) validateEnv(key, value);
    const remove = this.validateRemove(bundle.remove);

    // Removals run first so a login that is both removed and re-sent in one
    // request ends up present with the new value.
    const removed = await this.removeLogins(remove);

    for (const file of files) {
      await this.ensureDirs(dirname(file.path));
      await refuseSymlink(file.path);
      await writeAtomic(file.path, file.content);
    }
    if (envKeys.length > 0) {
      const env = { ...(await this.readHostEnv()), ...bundle.env };
      await this.ensureDirs(dirname(this.envFile));
      await writeAtomic(this.envFile, Buffer.from(renderHostEnvFile(env)));
      for (const key of envKeys) {
        process.env[key] = bundle.env[key];
        // A running tmux server gives new panes its own global environment.
        await this.executor.run({
          argv: ['tmux', 'set-environment', '-g', key, bundle.env[key]],
          mode: 'pipe',
        });
      }
    }
    logger.info(
      { envKeys, files: files.map((file) => file.path), removed },
      'Applied provider logins',
    );
    return { envKeys, files: files.map((file) => file.path), removed };
  }

  private readHostEnv(): Promise<Record<string, string>> {
    return readHostEnvFile();
  }

  private async binPath(provider: string): Promise<string> {
    const { items } = await this.storage.listProviders();
    const configured = items.find((row) => row.name.toLowerCase() === provider)?.binPath;
    return (await resolveExecutable(configured ?? provider, process.env.PATH)) ?? provider;
  }

  private validateFile(file: ProviderAuthClaimBundle['files'][number]): {
    path: string;
    content: Buffer;
  } {
    const path = normalize(file.path);
    const inside = relative(this.home, path);
    if (!isAbsolute(file.path) || !inside || inside.startsWith('..') || isAbsolute(inside)) {
      throw new ValidationError('Every file must be inside the home directory.', {
        reason: 'provider_auth_file_outside_home',
      });
    }
    if (REFUSED_FILES.includes(inside.split(sep).join('/'))) {
      throw new ValidationError(`${inside} cannot be written.`, {
        reason: 'provider_auth_file_refused',
      });
    }
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.length > MAX_FILE_BYTES) {
      throw new ValidationError('A provider file is too large.', {
        reason: 'provider_auth_file_too_large',
      });
    }
    return { path, content };
  }

  /**
   * Removal targets: any well-formed provider env key, but only the login
   * files of the adapter table — never arbitrary in-home paths.
   */
  private validateRemove(spec: HostProviderAuthRemoveSpec | undefined): HostProviderAuthRemoveSpec {
    if (!spec) return { envKeys: [], files: [] };
    if (spec.envKeys.length > MAX_REMOVE_ENV_KEYS || spec.files.length > MAX_FILES) {
      throw new ValidationError('Too many removals in one request.', {
        reason: 'provider_auth_too_many',
      });
    }
    const envKeys = [...new Set(spec.envKeys)];
    for (const key of envKeys) {
      if (!PROVIDER_AUTH_ENV_KEY_PATTERN.test(key) || RESERVED_PROVIDER_AUTH_ENV_KEYS.has(key)) {
        throw new ValidationError(`Environment key "${key}" cannot be removed.`, {
          reason: 'provider_auth_env_key_refused',
        });
      }
    }
    const familyPaths = new Set(familyFilePaths().map((entry) => entry.path));
    const files = [...new Set(spec.files)].map((raw) => {
      const path = normalize(raw);
      const inside = relative(this.home, path);
      if (!isAbsolute(raw) || !inside || inside.startsWith('..') || isAbsolute(inside)) {
        throw new ValidationError('Every removed file must be inside the home directory.', {
          reason: 'provider_auth_file_outside_home',
        });
      }
      const relativePath = inside.split(sep).join('/');
      if (REFUSED_FILES.includes(relativePath)) {
        throw new ValidationError(`${inside} cannot be removed.`, {
          reason: 'provider_auth_file_refused',
        });
      }
      if (!familyPaths.has(relativePath)) {
        throw new ValidationError(`${inside} is not a provider login file.`, {
          reason: 'provider_auth_file_not_family',
        });
      }
      return path;
    });
    return { envKeys, files };
  }

  /** Takes the requested logins away; a key or file that is absent is a no-op. */
  private async removeLogins(
    remove: HostProviderAuthRemoveSpec,
  ): Promise<HostProviderAuthRemoveSpec> {
    const removedEnvKeys: string[] = [];
    if (remove.envKeys.length > 0) {
      const hostEnv = await this.readHostEnv();
      let envChanged = false;
      for (const key of remove.envKeys) {
        const known = key in hostEnv || key in process.env;
        if (key in hostEnv) {
          delete hostEnv[key];
          envChanged = true;
        }
        if (key in process.env) delete process.env[key];
        // A running tmux server keeps its own global copy of the old value.
        await this.executor.run({
          argv: ['tmux', 'set-environment', '-gu', key],
          mode: 'pipe',
        });
        if (known) removedEnvKeys.push(key);
      }
      if (envChanged) {
        await this.ensureDirs(dirname(this.envFile));
        await writeAtomic(this.envFile, Buffer.from(renderHostEnvFile(hostEnv)));
      }
    }

    const removedFiles: string[] = [];
    for (const path of remove.files) {
      await this.refuseSymlinkedParents(path);
      await refuseSymlink(path);
      const stat = await lstat(path).catch(() => null);
      if (!stat) continue; // A login file that is already gone needs no work.
      await rm(path, { force: true });
      removedFiles.push(path);
    }
    return { envKeys: removedEnvKeys, files: removedFiles };
  }

  /** Parents must be real directories: a symlinked directory could point outside home. */
  private async refuseSymlinkedParents(file: string): Promise<void> {
    let current = this.home;
    for (const segment of relative(this.home, file).split(sep).slice(0, -1)) {
      current = join(current, segment);
      await refuseSymlink(current);
    }
  }

  /** Missing directories between home and `dir` are created 0700; symlinks are refused. */
  private async ensureDirs(dir: string): Promise<void> {
    let current = this.home;
    for (const segment of relative(this.home, dir).split(sep).filter(Boolean)) {
      current = join(current, segment);
      await refuseSymlink(current);
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
  }
}

function validateEnv(key: string, value: string): void {
  if (!PROVIDER_AUTH_ENV_KEY_PATTERN.test(key) || RESERVED_PROVIDER_AUTH_ENV_KEYS.has(key)) {
    throw new ValidationError(`Environment key "${key}" cannot be set.`, {
      reason: 'provider_auth_env_key_refused',
    });
  }
  if (/[\0\r\n]/.test(value) || value.length > 16 * 1024) {
    throw new ValidationError(`The value of "${key}" must be one line.`, {
      reason: 'provider_auth_env_value_invalid',
    });
  }
}

async function refuseSymlink(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (stat?.isSymbolicLink()) {
    throw new ValidationError(`${path} is a symbolic link.`, { reason: 'provider_auth_symlink' });
  }
}

async function writeAtomic(path: string, content: Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
