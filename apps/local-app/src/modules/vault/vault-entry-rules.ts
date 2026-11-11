import { ValidationError } from '../../common/errors/error-types';
import {
  PROVIDER_AUTH_ADAPTERS,
  RESERVED_PROVIDER_AUTH_ENV_KEYS,
} from '../provider-auth/provider-auth-adapters';
import type { ProviderAdapter } from '../providers/adapters/provider-adapter.interface';
import { EnvBuilderError, validateEnvKey } from '../providers/utils/env-builder';
import { CONTEXT_WINDOW_ENV_KEY } from '../runtime-context-capture/context-window-policy';
import type { VaultEntryKind } from '../storage/models/domain.models';

/** The env-builder limit; a `secret` value goes into the process environment as is. */
export const VAULT_SECRET_MAX_CHARS = 32_768;
/** A `file` value is written to a 0600 file, so it may hold newlines. */
export const VAULT_FILE_MAX_BYTES = 256 * 1024;

const RESERVED_PREFIX = 'DEVCHAIN_';

/**
 * Names DevChain, the provider CLIs or a host claim set themselves. Every key of the
 * bootstrap `RESERVED_ENV_KEYS` (apps/host-bootstrap/lib/validate.js) is refused:
 * the system keys (HOME, PATH, LD_PRELOAD, NODE_OPTIONS, …) are in
 * `RESERVED_PROVIDER_AUTH_ENV_KEYS`, the `DEVCHAIN_HOST_*` keys match the prefix rule.
 * `vault-entry-rules.spec.ts` fails if the bootstrap set gains a key that is not refused.
 */
export function reservedVaultEntryNames(adapters: readonly ProviderAdapter[]): Set<string> {
  const names = new Set<string>([...RESERVED_PROVIDER_AUTH_ENV_KEYS, CONTEXT_WINDOW_ENV_KEY]);
  for (const spec of Object.values(PROVIDER_AUTH_ADAPTERS)) {
    if ('envKey' in spec) names.add(spec.envKey);
  }
  for (const adapter of adapters) {
    for (const key of Object.keys(adapter.launchEnv ?? {})) names.add(key);
    for (const key of adapter.launchUnsetEnv ?? []) names.add(key);
    for (const key of adapter.launchRejectEnv ?? []) names.add(key);
  }
  return new Set([...names].map((name) => name.toUpperCase()));
}

/** Reserved names match case-insensitively, so `Path` cannot stand in for `PATH`. */
export function assertVaultEntryName(name: string, reserved: ReadonlySet<string>): void {
  try {
    validateEnvKey(name);
  } catch (error) {
    if (!(error instanceof EnvBuilderError)) throw error;
    throw new ValidationError(
      'The name must be an environment variable name: letters, digits and underscores, not starting with a digit, at most 255 characters.',
      { code: 'VAULT_ENTRY_NAME_INVALID' },
    );
  }
  const upper = name.toUpperCase();
  if (upper.startsWith(RESERVED_PREFIX) || reserved.has(upper)) {
    throw new ValidationError(`The name ${name} is reserved by DevChain or a provider.`, {
      code: 'VAULT_ENTRY_NAME_RESERVED',
    });
  }
}

/** Error messages never quote the value. */
export function assertVaultEntryValue(kind: VaultEntryKind, value: string): void {
  if (value.length === 0) {
    throw new ValidationError('The value cannot be empty.', { code: 'VAULT_ENTRY_VALUE_INVALID' });
  }
  if (kind === 'secret') {
    if (value.length > VAULT_SECRET_MAX_CHARS) {
      throw new ValidationError(
        `A secret value can have at most ${VAULT_SECRET_MAX_CHARS} characters.`,
        { code: 'VAULT_ENTRY_VALUE_INVALID' },
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(value)) {
      throw new ValidationError(
        'A secret value cannot hold newlines or control characters. Use the file kind for multi-line values.',
        { code: 'VAULT_ENTRY_VALUE_INVALID' },
      );
    }
    return;
  }
  if (Buffer.byteLength(value, 'utf8') > VAULT_FILE_MAX_BYTES) {
    throw new ValidationError(`A file value can have at most ${VAULT_FILE_MAX_BYTES} bytes.`, {
      code: 'VAULT_ENTRY_VALUE_INVALID',
    });
  }
}
