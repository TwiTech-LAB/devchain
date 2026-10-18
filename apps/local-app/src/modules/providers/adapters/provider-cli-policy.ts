import type { OpencodeCliVersion } from './opencode-cli-version';

export interface ProviderCliNoUpdateOptions {
  env: Record<string, string>;
  args: string[];
}

/** Per-command policy; never changes the user's persistent CLI configuration. */
export function getProviderCliNoUpdateOptions(
  providerName: string,
  baseEnv: NodeJS.ProcessEnv = {},
): ProviderCliNoUpdateOptions {
  // eslint-disable-next-line no-control-regex
  const controlChars = /[\x00-\x1f\x7f]/;
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !controlChars.test(value)) {
      inherited[key] = value;
    }
  }
  switch (providerName.toLowerCase()) {
    case 'claude':
      return { env: { ...inherited, DISABLE_AUTOUPDATER: '1' }, args: [] };
    case 'copilot':
      return { env: { ...inherited, COPILOT_AUTO_UPDATE: 'false' }, args: [] };
    case 'opencode':
      return { env: { ...inherited, OPENCODE_DISABLE_AUTOUPDATE: 'true' }, args: [] };
    case 'agy':
      return { env: { ...inherited, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, args: [] };
    case 'codex':
      return { env: inherited, args: ['-c', 'check_for_update_on_startup=false'] };
    default:
      return { env: inherited, args: [] };
  }
}

export interface ProviderCliNoUpdateCommand {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Applies the no-update policy to one command: the policy args go right after
 * the executable (`argv[0]`), and `env` is the policy env on top of `baseEnv`.
 */
export function applyProviderCliNoUpdate(
  providerName: string,
  argv: readonly string[],
  baseEnv: NodeJS.ProcessEnv = {},
): ProviderCliNoUpdateCommand {
  const policy = getProviderCliNoUpdateOptions(providerName, baseEnv);
  return { argv: [argv[0], ...policy.args, ...argv.slice(1)], env: policy.env };
}

/**
 * The single place that adds the OpenCode 2 `--standalone` flag: without it every
 * v2 command starts a per-user daemon that outlives the CLI. `argv` includes the
 * executable.
 */
export function opencodeV2CommandArgs(argv: readonly string[]): string[] {
  return [...argv, '--standalone'];
}

/** `argv` for the probed version; v1 rejects `--standalone`, so its argv is returned unchanged. */
export function opencodeCommandArgs(
  version: Pick<OpencodeCliVersion, 'major'>,
  argv: readonly string[],
): string[] {
  return version.major >= 2 ? opencodeV2CommandArgs(argv) : [...argv];
}
