import { ValidationError } from '../../../common/errors/error-types';
import type { ProviderAdapter } from '../adapters/provider-adapter.interface';

/** The parts of a provider adapter that decide the environment a session's provider runs with. */
export type LaunchEnvRules = Pick<
  ProviderAdapter,
  'providerName' | 'launchUnsetEnv' | 'launchRejectEnv'
>;

/**
 * Launch's refusal of a provider or config environment: the message names the key and never its
 * value. Undefined when launch accepts the environment.
 */
export function rejectedLaunchEnv(
  adapter: LaunchEnvRules,
  env: Readonly<Record<string, string>>,
): string | undefined {
  const key = adapter.launchRejectEnv?.find((entry) => Object.hasOwn(env, entry));
  if (key === undefined) return undefined;
  return (
    `${key} is not supported for the ${adapter.providerName} provider — ` +
    `remove it from the provider/config environment. devchain reads this ` +
    `provider's session store from a fixed home-relative path, so relocating ` +
    `it would make launched sessions unreadable.`
  );
}

/** Throws launch's refusal of `sessionEnv`, before any provider command runs. */
export function assertLaunchEnvAccepted(
  adapter: LaunchEnvRules,
  sessionEnv: Readonly<Record<string, string>>,
): void {
  const rejection = rejectedLaunchEnv(adapter, sessionEnv);
  if (rejection) throw new ValidationError(rejection, { providerName: adapter.providerName });
}

/**
 * The environment for a provider command that must see the session's account (an MCP check or
 * repair): this process's environment without the adapter's `launchUnsetEnv` keys, then the
 * session environment (provider env, then config env) on top. Launch itself also drops the keys
 * that only a session uses (`finalizeLaunchConfig`, `buildForkHelperEnv`).
 */
export function sessionLaunchEnv(
  adapter: LaunchEnvRules,
  sessionEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  assertLaunchEnvAccepted(adapter, sessionEnv);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of adapter.launchUnsetEnv ?? []) delete env[key];
  return Object.assign(env, sessionEnv);
}
