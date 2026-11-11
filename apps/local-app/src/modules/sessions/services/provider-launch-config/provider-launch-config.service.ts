import { delimiter } from 'node:path';
import { processIdsEnv } from '../../../../common/process-ids-env';
import { sessionIdentityEnv, type SessionIdentity } from '../../../../common/session-identity-env';
import type {
  ProviderAdapter,
  LaunchInitialPromptBehavior,
} from '../../../providers/adapters/provider-adapter.interface';
import {
  isAutoCompactCapable,
  isEffortCapable,
  isHookCapable,
  type HookEnvContext,
  type AutoCompactProviderState,
} from '../../../providers/adapters/capabilities';
import {
  parseProfileOptions,
  ProfileOptionsError,
  injectModelOverride,
  extractModelFromArgs,
} from '../../../providers/utils/profile-options';
import { buildSessionCommand, EnvBuilderError } from '../../../providers/utils/env-builder';
import {
  CONTEXT_WINDOW_ENV_KEY,
  parseContextWindowEnv,
  type ModelBoundContextWindow,
} from '../../../runtime-context-capture/context-window-policy';

export { ProfileOptionsError, EnvBuilderError };

export interface LaunchConfigInput {
  mode: 'new' | 'restore';
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
  /** `<bin> --version` output; set for adapters with `requiresCliVersion`. */
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

export function resolve(input: LaunchConfigInput): LaunchConfig {
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

  // Reject any provider-forbidden env var (e.g. Copilot's COPILOT_HOME, R4)
  // BEFORE the process starts — these pass launch but break read-time invariants.
  const rejectEnv = input.adapter.launchRejectEnv;
  if (rejectEnv?.length) {
    for (const key of rejectEnv) {
      if (key in providerEnv || key in configEnv) {
        throw new EnvBuilderError(
          `${key} is not supported for the ${input.adapter.providerName} provider — ` +
            `remove it from the provider/config environment. devchain reads this ` +
            `provider's session store from a fixed home-relative path, so relocating ` +
            `it would make launched sessions unreadable.`,
        );
      }
    }
  }

  let env: Record<string, string> | null = null;

  const mergedBaseEnv = { ...providerEnv, ...configEnv };
  if (Object.keys(mergedBaseEnv).length > 0) {
    env = mergedBaseEnv;
  }

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

  const finalOptionArgs = [...(input.providerOptionArgs ?? []), ...optionArgs];
  const launchArgs = input.adapter.buildLaunchArgs({
    mode: input.mode,
    providerSessionId: input.providerSessionId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    profileOptionArgs: finalOptionArgs,
    initialPrompt: input.initialPrompt,
    env,
    ...(input.adapter.requiresCliVersion && {
      cliVersion: input.cliVersion,
      providerBinPath: input.providerBinPath,
    }),
  });
  const { argv } = launchArgs;
  if (launchArgs.env !== undefined) env = launchArgs.env;
  if (input.sessionIdentity) {
    env = { ...(env ?? {}), ...sessionIdentityEnv(input.sessionIdentity) };
  }

  // Providers declare any env vars that must be cleared from their launch
  // environment via `launchUnsetEnv` (e.g. Claude unsets $TMUX/$TMUX_PANE to
  // avoid its degraded multiplexer renderer). Kept provider-agnostic here.
  const unsetEnv = [...new Set([...(input.adapter.launchUnsetEnv ?? []), CONTEXT_WINDOW_ENV_KEY])];

  const commandArgs = buildSessionCommand(env, input.providerBinPath, argv, unsetEnv);

  return {
    argv,
    commandArgs,
    env,
    pathPrependDirs,
    contextWindowOverride,
    promptHandshake: input.adapter.launchInitialPromptBehavior,
  };
}
