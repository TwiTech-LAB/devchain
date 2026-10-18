import { Injectable } from '@nestjs/common';
import { realpath, stat } from 'fs/promises';
import { resolveBinary } from '../../../common/resolve-binary';
import { ValidationError } from '../../../common/errors/error-types';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { getProviderCliNoUpdateOptions } from '../adapters/provider-cli-policy';

export const PROVIDER_CLI_VERSION_PROBE_TTL_MS = 60_000;
const PROVIDER_CLI_VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Runs `<bin> --version` and returns the trimmed stdout. Results are cached per
 * binary file (realpath + mtime + size), so replacing the binary invalidates the
 * entry immediately; failures are never cached.
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

    const real = await realpath(resolved);
    const { mtimeMs, size } = await stat(real);
    const key = `${provider}\0${real}\0${mtimeMs}\0${size}`;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.version;

    // The policy env replaces the child env, so PATH/HOME must come from process.env.
    const command = getProviderCliNoUpdateOptions(provider, process.env);
    const result = await this.executor.run({
      argv: [real, '--version'],
      mode: 'pipe',
      env: command.env,
      timeout: PROVIDER_CLI_VERSION_PROBE_TIMEOUT_MS,
      outputLimits: { maxBytes: 8192 },
    });
    const version = result.stdout.trim();
    if (!result.success || !version) {
      throw new ValidationError(`Unable to read the ${provider} version from ${resolved}`, {
        reason: result.timedOut ? 'version_probe_timeout' : 'version_probe_failed',
        binPath: resolved,
      });
    }

    this.cache.set(key, { version, expiresAt: Date.now() + PROVIDER_CLI_VERSION_PROBE_TTL_MS });
    return version;
  }
}
