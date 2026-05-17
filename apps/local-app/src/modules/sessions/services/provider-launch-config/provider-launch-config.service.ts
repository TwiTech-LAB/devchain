import type {
  ProviderAdapter,
  LaunchInitialPromptBehavior,
} from '../../../providers/adapters/provider-adapter.interface';
import {
  isContextWindowCapable,
  isHookCapable,
  type HookEnvContext,
  type ContextWindowProviderState,
} from '../../../providers/adapters/capabilities';
import {
  parseProfileOptions,
  ProfileOptionsError,
  injectModelOverride,
} from '../../utils/profile-options';
import { buildSessionCommand, EnvBuilderError } from '../../utils/env-builder';

export { ProfileOptionsError, EnvBuilderError };

export interface LaunchConfigInput {
  mode: 'new' | 'restore';
  providerSessionId?: string;
  adapter: ProviderAdapter;
  profileOptions: string | null | undefined;
  modelOverride: string | null | undefined;
  providerBinPath: string;
  providerEnv: Record<string, string> | null;
  configEnv: Record<string, string> | null;
  provider: ContextWindowProviderState;
  hookContext?: HookEnvContext;
}

export interface LaunchConfig {
  argv: string[];
  commandArgs: string[];
  env: Record<string, string> | null;
  promptHandshake?: LaunchInitialPromptBehavior;
}

export function resolve(input: LaunchConfigInput): LaunchConfig {
  let optionArgs = parseProfileOptions(input.profileOptions);

  if (input.modelOverride) {
    optionArgs = injectModelOverride(optionArgs, input.modelOverride);
  }

  const providerEnv = input.providerEnv ?? {};
  const configEnv = input.configEnv ?? {};
  let env: Record<string, string> | null = null;

  const mergedBaseEnv = { ...providerEnv, ...configEnv };
  if (Object.keys(mergedBaseEnv).length > 0) {
    env = mergedBaseEnv;
  }

  if (isHookCapable(input.adapter) && input.hookContext) {
    const hookEnv = input.adapter.buildHookEnv(input.hookContext);
    env = { ...hookEnv, ...providerEnv, ...configEnv };
  }

  if (isContextWindowCapable(input.adapter)) {
    const cwResult = input.adapter.applyContextWindowConfig(optionArgs, env ?? {}, input.provider);
    optionArgs = cwResult.argv;
    env = Object.keys(cwResult.env).length > 0 ? cwResult.env : null;
  }

  const { argv } = input.adapter.buildLaunchArgs({
    mode: input.mode,
    providerSessionId: input.providerSessionId,
    profileOptionArgs: optionArgs,
  });

  // Claude's fullscreen renderer takes a degraded code path when it detects $TMUX
  // (cell-diff updates without ESC[K cleanup, leaving stale cells that drift into
  // scrollback). Unsetting both vars forces the full non-multiplexer renderer.
  const unsetEnv =
    input.adapter.providerName === 'claude' ? (['TMUX', 'TMUX_PANE'] as const) : undefined;

  const commandArgs = buildSessionCommand(env, input.providerBinPath, argv, unsetEnv);

  return {
    argv,
    commandArgs,
    env,
    promptHandshake: input.adapter.launchInitialPromptBehavior,
  };
}
