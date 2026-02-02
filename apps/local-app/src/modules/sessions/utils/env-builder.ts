/**
 * Environment variable builder for session launch.
 * Provides safe validation and shell quoting for env vars.
 */

export class EnvBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvBuilderError';
  }
}

/**
 * Valid env key: starts with letter or underscore, followed by alphanumeric or underscore.
 * Matches POSIX standard for environment variable names.
 */
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Control characters (0x00-0x1F) except tab (0x09) which is sometimes allowed.
 * We reject all control chars including tab for safety.
 */
const CONTROL_CHAR_REGEX = /[\x00-\x1f]/;

/**
 * Validates an environment variable key.
 * Must be alphanumeric + underscore, starting with letter or underscore.
 * @throws EnvBuilderError if key is invalid
 */
export function validateEnvKey(key: string): void {
  if (!key || key.length === 0) {
    throw new EnvBuilderError('Environment variable key cannot be empty');
  }

  if (key.length > 255) {
    throw new EnvBuilderError(
      `Environment variable key too long: ${key.slice(0, 20)}... (max 255 chars)`,
    );
  }

  if (!ENV_KEY_REGEX.test(key)) {
    throw new EnvBuilderError(
      `Invalid environment variable key "${key}": must contain only alphanumeric characters and underscores, starting with a letter or underscore`,
    );
  }
}

/**
 * Validates an environment variable value.
 * Must not contain control characters or newlines.
 * @throws EnvBuilderError if value is invalid
 */
export function validateEnvValue(key: string, value: string): void {
  if (value.length > 32768) {
    throw new EnvBuilderError(`Environment variable value too long for "${key}" (max 32KB)`);
  }

  if (CONTROL_CHAR_REGEX.test(value)) {
    throw new EnvBuilderError(
      `Environment variable "${key}" contains control characters or newlines`,
    );
  }
}

/**
 * Quotes a value for safe shell usage using single quotes.
 * Single quotes preserve literal value, only ' needs escaping as '\''
 *
 * NOTE: This function is NOT used by buildEnvArgs() because TmuxService.sendCommandArgs()
 * handles shell quoting for all argv elements. Using quoteEnvValue() here would cause
 * double-quoting. This function is kept for potential direct shell command usage.
 */
export function quoteEnvValue(value: string): string {
  // Empty string needs explicit quotes
  if (value.length === 0) {
    return "''";
  }

  // Use single quotes, escape any embedded single quotes as '\''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds an array of env var assignments for use with the `env` command.
 * Each entry is formatted as KEY=value WITHOUT shell quoting.
 *
 * IMPORTANT: Do NOT add shell quoting here. The TmuxService.sendCommandArgs() method
 * handles quoting for all argv elements. Adding quotes here causes double-quoting,
 * resulting in literal quote characters in the final env var values.
 *
 * @param env - Record of environment variables (key -> value)
 * @returns Array of "KEY=value" strings (unquoted) ready for argv
 * @throws EnvBuilderError if any key or value is invalid
 */
export function buildEnvArgs(env: Record<string, string> | null | undefined): string[] {
  if (!env || Object.keys(env).length === 0) {
    return [];
  }

  const args: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    validateEnvKey(key);
    validateEnvValue(key, value);

    // Format: KEY=value (unquoted - sendCommandArgs handles shell quoting)
    args.push(`${key}=${value}`);
  }

  return args;
}

/**
 * Builds the full command argv for launching a session with env vars.
 * Uses the `env` command to set environment variables before running the provider.
 *
 * @param envVars - Environment variables to set
 * @param providerBinPath - Path to the provider binary
 * @param optionArgs - Additional arguments for the provider
 * @returns Full argv array: ['env', 'KEY=value', ..., 'provider', ...options]
 */
export function buildSessionCommand(
  envVars: Record<string, string> | null | undefined,
  providerBinPath: string,
  optionArgs: string[],
): string[] {
  const envArgs = buildEnvArgs(envVars);

  if (envArgs.length === 0) {
    // No env vars, just run provider directly
    return [providerBinPath, ...optionArgs];
  }

  // Use env command to set variables: env KEY=value KEY2=value2 provider args...
  return ['env', ...envArgs, providerBinPath, ...optionArgs];
}
