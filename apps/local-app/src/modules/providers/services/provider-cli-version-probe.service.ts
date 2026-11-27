import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';
import { resolveBinary } from '../../../common/resolve-binary';
import { ValidationError } from '../../../common/errors/error-types';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { getProviderCliNoUpdateOptions } from '../adapters/provider-cli-policy';

export const PROVIDER_CLI_VERSION_PROBE_TTL_MS = 60_000;
const PROVIDER_CLI_VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Runs `<bin> --version` and returns the trimmed stdout. Successful results are
 * cached by binary file (realpath + mtime + size) and, for forks, invocation
 * path and helper context.
 */
@Injectable()
export class ProviderCliVersionProbe {
  private readonly cache = new Map<string, { version: string; expiresAt: number }>();

  constructor(private readonly executor: ProcessExecutor) {}

  async probe(provider: string, binPath: string): Promise<string> {
    const resolved = await resolveBinary(binPath, this.executor);
    if (!resolved) {
      throw new ValidationError(`Provider binary not found: ${binPath}`, {
        reason: 'binary_not_found',
        binPath,
      });
    }

    const { env } = getProviderCliNoUpdateOptions(provider, process.env);
    return this.probeExecutable(provider, await realpath(resolved), env, { displayPath: resolved });
  }

  async probeForFork(
    provider: string,
    binPath: string,
    helperEnv: Readonly<Record<string, string>>,
    cwd: string,
  ): Promise<{ providerBinPath: string; cliVersion: string } | null> {
    const { env } = getProviderCliNoUpdateOptions(provider, helperEnv);
    const executable = await resolveForkExecutable(binPath, env.PATH, cwd);
    if (!executable) return null;
    const cliVersion = await this.probeExecutable(provider, executable.realPath, env, {
      cwd,
      invocationPath: executable.entryPath,
    });
    return { providerBinPath: executable.entryPath, cliVersion };
  }

  private async probeExecutable(
    provider: string,
    realPath: string,
    env: Readonly<Record<string, string>>,
    {
      cwd,
      invocationPath = realPath,
      displayPath = invocationPath,
    }: { cwd?: string; invocationPath?: string; displayPath?: string },
  ): Promise<string> {
    const { mtimeMs, size } = await stat(realPath);
    let key = `${provider}\0${realPath}\0${mtimeMs}\0${size}`;
    if (cwd !== undefined) {
      // A launcher can select another CLI version without changing its own file.
      const envEntries = Object.keys(env)
        .sort()
        .map((name) => [name, env[name]]);
      const context = createHash('sha256')
        .update(JSON.stringify([cwd, envEntries]))
        .digest('hex');
      key += `\0${invocationPath}\0${context}`;
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.version;

    const result = await this.executor.run({
      argv: [invocationPath, '--version'],
      mode: 'pipe',
      ...(cwd !== undefined && { cwd }),
      env,
      timeout: PROVIDER_CLI_VERSION_PROBE_TIMEOUT_MS,
      outputLimits: { maxBytes: 8192 },
    });
    const version = result.stdout.trim();
    if (!result.success || !version) {
      throw new ValidationError(`Unable to read the ${provider} version from ${displayPath}`, {
        reason: result.timedOut ? 'version_probe_timeout' : 'version_probe_failed',
        binPath: displayPath,
      });
    }

    this.cache.set(key, { version, expiresAt: Date.now() + PROVIDER_CLI_VERSION_PROBE_TTL_MS });
    return version;
  }
}

async function resolveForkExecutable(
  binPath: string,
  helperPath: string | undefined,
  cwd: string,
): Promise<{ entryPath: string; realPath: string } | null> {
  // Child process lookup uses the Unix default search path when env has no PATH.
  const candidates =
    isAbsolute(binPath) || binPath.includes(sep)
      ? [resolve(cwd, binPath)]
      : (helperPath ?? '/usr/bin:/bin').split(delimiter).map((dir) => resolve(cwd, dir, binPath));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      // A version manager can dispatch on the invocation name, including a symlink name.
      return { entryPath: candidate, realPath: path };
    } catch {
      // Try the next PATH entry when this file is absent or cannot be executed.
    }
  }
  return null;
}
