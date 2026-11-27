import { delimiter } from 'node:path';
import { ValidationError } from '../../../../common/errors/error-types';
import { processIdsEnv } from '../../../../common/process-ids-env';
import { sessionIdentityEnv, type SessionIdentity } from '../../../../common/session-identity-env';
import type {
  ProviderAdapter,
  LaunchInitialPromptBehavior,
  BuildLaunchArgsResult,
} from '../../../providers/adapters/provider-adapter.interface';
import {
  isAutoCompactCapable,
  isEffortCapable,
  isHookCapable,
  type HookEnvContext,
  type AutoCompactProviderState,
} from '../../../providers/adapters/capabilities';
import { HOOK_ENV_KEYS } from '../../../providers/adapters/capabilities/hook.capability';
import {
  parseProfileOptions,
  ProfileOptionsError,
  injectModelOverride,
  extractModelFromArgs,
} from '../../../providers/utils/profile-options';
import { buildSessionCommand, EnvBuilderError } from '../../../providers/utils/env-builder';
import { rejectedLaunchEnv } from '../../../providers/utils/launch-env-rules';
import {
  CONTEXT_WINDOW_ENV_KEY,
  parseContextWindowEnv,
  type ModelBoundContextWindow,
} from '../../../runtime-context-capture/context-window-policy';

export { ProfileOptionsError, EnvBuilderError };

export interface LaunchConfigInput {
  mode: 'new' | 'restore' | 'fork';
  providerSessionId?: string;
  /** The devchain `sessions.id`, for both modes; see {@link BuildLaunchArgsInput.sessionId}. */
  sessionId?: string;
  /** See {@link BuildLaunchArgsInput.projectId}. */
  projectId?: string;
  adapter: ProviderAdapter;
  profileOptions: string | null | undefined;
  modelOverride: string | null | undefined;
  /**
   * Effective effort value (agent override → config default), precomputed by the
   * pipeline. When set AND the adapter is effort-capable, the adapter strips any
   * conflicting raw effort flags and injects its native form. When null/undefined,
   * raw effort options pass through untouched (power-user escape hatch). Applied
   * after model injection so the adapter sees the effective model.
   */
  effortOverride?: string | null;
  providerBinPath: string;
  providerEnv: Record<string, string> | null;
  configEnv: Record<string, string> | null;
  provider: AutoCompactProviderState;
  /** DevChain-owned provider args emitted before every user/profile option. */
  providerOptionArgs?: string[];
  /** DevChain-owned launch-only env that must win over configurable env. */
  runtimeEnv?: Record<string, string>;
  /** The git shim's directory, put first on the session PATH so Git in agent shells uses it. */
  gitShimBin?: string;
  /** The directory of this app's `devchain` launcher, on the session PATH after the git shim. */
  cliBin?: string;
  hookContext?: HookEnvContext;
  /**
   * Applied after every other env layer, adapter env included, so no provider or
   * config key can make two sessions share one identity.
   */
  sessionIdentity?: SessionIdentity;
  /**
   * Pre-rendered initial prompt for opt-in seeding adapters
   * (`adapter.initialPromptSeedMode` set). Threaded into `buildLaunchArgs` so
   * `argv`-mode adapters can emit it as an argv value. Undefined for the
   * default post-launch paste path and when no initial prompt is configured.
   */
  initialPrompt?: string;
  /** `<bin> --version` output; see `requiresCliVersion` and `optionalCliVersion`. */
  cliVersion?: string;
}

export interface LaunchConfig {
  argv: string[];
  commandArgs: string[];
  env: Record<string, string> | null;
  /**
   * Dirs the launch script prepends to the pane shell's own `$PATH` at run time
   * (shim first). Empty when PATH is an explicit provider/config env override,
   * which is then carried literally in `env`/`commandArgs` instead.
   */
  pathPrependDirs: readonly string[];
  contextWindowOverride: ModelBoundContextWindow | null;
  promptHandshake?: LaunchInitialPromptBehavior;
}

interface LaunchOptions {
  profileOptionArgs: string[];
  env: Record<string, string> | null;
  pathPrependDirs: string[];
  contextWindowOverride: ModelBoundContextWindow | null;
}

export function resolve(input: LaunchConfigInput, forkArgs?: BuildLaunchArgsResult): LaunchConfig {
  const options = resolveLaunchOptions(input);
  if (forkArgs) {
    // Managed provider options are global CLI flags. Prepending them preserves the
    // prepared fork command and avoids creating a second provider conversation.
    return finalizeLaunchConfig(input, options, {
      argv: [...(input.providerOptionArgs ?? []), ...forkArgs.argv],
      env: forkArgs.env && { ...forkArgs.env, ...input.runtimeEnv },
    });
  }
  if (input.mode === 'fork') {
    throw new ValidationError('A fork launch requires the prepared fork arguments');
  }
  const launchArgs = input.adapter.buildLaunchArgs({
    mode: input.mode,
    providerSessionId: input.providerSessionId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    profileOptionArgs: options.profileOptionArgs,
    initialPrompt: input.initialPrompt,
    env: options.env,
    ...((input.adapter.requiresCliVersion || input.cliVersion !== undefined) && {
      cliVersion: input.cliVersion,
      providerBinPath: input.providerBinPath,
    }),
  });
  return finalizeLaunchConfig(input, options, launchArgs);
}

export function resolveLaunchOptions(input: LaunchConfigInput): LaunchOptions {
  let optionArgs = parseProfileOptions(input.profileOptions);

  if (input.modelOverride) {
    optionArgs = injectModelOverride(optionArgs, input.modelOverride);
  }

  const providerEnv = { ...(input.providerEnv ?? {}) };
  const configEnv = { ...(input.configEnv ?? {}) };
  const parsedContextWindow = parseContextWindowEnv(configEnv[CONTEXT_WINDOW_ENV_KEY]);
  delete providerEnv[CONTEXT_WINDOW_ENV_KEY];
  delete configEnv[CONTEXT_WINDOW_ENV_KEY];
  const effectiveModel = extractModelFromArgs(optionArgs);
  const contextWindowOverride =
    parsedContextWindow.kind === 'valid' && effectiveModel
      ? {
          modelId: effectiveModel,
          contextWindowTokens: parsedContextWindow.contextWindowTokens,
        }
      : null;

  const mergedBaseEnv = { ...providerEnv, ...configEnv };
  const rejection = rejectedLaunchEnv(input.adapter, mergedBaseEnv);
  if (rejection) throw new EnvBuilderError(rejection);

  let env = Object.keys(mergedBaseEnv).length > 0 ? mergedBaseEnv : null;

  if (isHookCapable(input.adapter) && input.hookContext) {
    const hookEnv = input.adapter.buildHookEnv(input.hookContext);
    env = { ...hookEnv, ...providerEnv, ...configEnv };
  }

  // Effort resolution runs after model injection so a per-model effort adapter
  // sees the effective model here.
  if (isEffortCapable(input.adapter) && input.effortOverride) {
    const effectiveModel = extractModelFromArgs(optionArgs) ?? undefined;
    const effortResult = input.adapter.applyEffort(
      optionArgs,
      env ?? {},
      input.effortOverride,
      effectiveModel,
    );
    optionArgs = effortResult.argv;
    env = Object.keys(effortResult.env).length > 0 ? effortResult.env : null;
  }

  if (isAutoCompactCapable(input.adapter)) {
    const autoCompactResult = input.adapter.applyAutoCompactConfig(
      optionArgs,
      env ?? {},
      input.provider,
    );
    optionArgs = autoCompactResult.argv;
    env = Object.keys(autoCompactResult.env).length > 0 ? autoCompactResult.env : null;
  }

  if (input.adapter.launchEnv && Object.keys(input.adapter.launchEnv).length > 0) {
    env = { ...(env ?? {}), ...input.adapter.launchEnv };
  }

  if (input.runtimeEnv && Object.keys(input.runtimeEnv).length > 0) {
    env = { ...(env ?? {}), ...input.runtimeEnv };
  }

  // The shim goes on last, so it stays first. An explicit PATH from provider or
  // config env keeps the literal prepend; without one the dirs go to the launch
  // script, which prepends them to the pane shell's own $PATH at run time —
  // the resolver must not bake this server process's PATH into the session.
  const pathPrependDirs: string[] = [];
  for (const dir of [input.cliBin, input.gitShimBin]) {
    if (!dir) continue;
    if (env?.PATH !== undefined) {
      const path = env.PATH;
      if (path.split(delimiter)[0] !== dir)
        env = { ...env, PATH: path ? `${dir}${delimiter}${path}` : dir };
    } else if (!pathPrependDirs.includes(dir)) {
      pathPrependDirs.unshift(dir);
    }
  }

  const idsEnv = processIdsEnv();
  if (Object.keys(idsEnv).length > 0) {
    env = { ...(env ?? {}), ...idsEnv };
  }

  return {
    profileOptionArgs: [...(input.providerOptionArgs ?? []), ...optionArgs],
    env,
    pathPrependDirs,
    contextWindowOverride,
  };
}

export function buildForkHelperEnv(
  adapter: ProviderAdapter,
  configuredEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const overrides = { ...configuredEnv, ...adapter.launchEnv };
  const rejection = rejectedLaunchEnv(adapter, overrides);
  if (rejection) throw new ValidationError(rejection);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, overrides);
  const managedHookEnvKeys = isHookCapable(adapter) ? adapter.managedHookEnvKeys : undefined;
  for (const key of [
    ...(adapter.launchUnsetEnv ?? []),
    ...(managedHookEnvKeys ?? []),
    CONTEXT_WINDOW_ENV_KEY,
    ...HOOK_ENV_KEYS,
  ]) {
    delete env[key];
  }
  const inheritedRejection = rejectedLaunchEnv(adapter, env);
  if (inheritedRejection) throw new ValidationError(inheritedRejection);
  return env;
}

export function finalizeLaunchConfig(
  input: LaunchConfigInput,
  options: LaunchOptions,
  launchArgs: BuildLaunchArgsResult,
): LaunchConfig {
  const { argv } = launchArgs;
  let env = launchArgs.env ?? options.env;
  if (input.sessionIdentity) {
    env = { ...(env ?? {}), ...sessionIdentityEnv(input.sessionIdentity) };
  }

  // Providers declare any env vars that must be cleared from their launch
  // environment via `launchUnsetEnv` (e.g. Claude unsets $TMUX/$TMUX_PANE to
  // avoid its degraded multiplexer renderer). Kept provider-agnostic here.
  const unsetEnv = new Set([...(input.adapter.launchUnsetEnv ?? []), CONTEXT_WINDOW_ENV_KEY]);

  // A managed hook key comes only from `buildHookEnv`; when it omits the key, the
  // launch clears any inherited value.
  if (isHookCapable(input.adapter) && input.adapter.managedHookEnvKeys?.length) {
    const hookEnv: Record<string, string | undefined> = input.hookContext
      ? input.adapter.buildHookEnv(input.hookContext)
      : {};
    const finalEnv = { ...env };
    for (const key of input.adapter.managedHookEnvKeys) {
      const value = hookEnv[key];
      if (value === undefined) {
        delete finalEnv[key];
        unsetEnv.add(key);
      } else {
        finalEnv[key] = value;
      }
    }
    env = Object.keys(finalEnv).length > 0 ? finalEnv : null;
  }

  const commandArgs = buildSessionCommand(env, input.providerBinPath, argv, [...unsetEnv]);

  return {
    argv,
    commandArgs,
    env,
    pathPrependDirs: options.pathPrependDirs,
    contextWindowOverride: options.contextWindowOverride,
    promptHandshake: input.adapter.launchInitialPromptBehavior,
  };
}
