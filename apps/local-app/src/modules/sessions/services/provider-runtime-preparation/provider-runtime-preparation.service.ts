import { Inject, Injectable } from '@nestjs/common';
import { HostResolver } from '@devchain/shared';
import { getEnvConfig } from '../../../../common/config/env.config';
import { ValidationError } from '../../../../common/errors/error-types';
import { isHookCapable } from '../../../providers/adapters/capabilities';
import { ProviderPluginPolicyService } from '../../../providers/services/provider-plugin-policy.service';
import { ClaudeLaunchSettingsMaterializerService } from '../../../runtime-context-capture/claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from '../../../runtime-context-capture/codex-plugin-profile-materializer.service';
import type {
  PreparedArtifacts,
  ProviderLaunchArtifacts,
  ProviderPluginPolicyEntry,
} from '../../../runtime-context-capture/provider-artifacts.types';
import { RuntimeContextCaptureService } from '../../../runtime-context-capture/runtime-context-capture.service';
import type { RuntimeContextCaptureSnapshot } from '../../../runtime-context-capture/runtime-context-capture.types';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../../storage/interfaces/storage.interface';
import { extractModelFromArgs, parseProfileOptions } from '../../utils/profile-options';
import {
  resolve as resolveLaunchConfig,
  type LaunchConfig,
  type LaunchConfigInput,
} from '../provider-launch-config';
import type {
  PreparedProviderRuntime,
  ProviderRuntimePlanInput,
} from './provider-runtime-preparation.types';
import { ProviderRuntimePlan } from './provider-runtime-preparation.types';

interface ProviderRuntimePlanState {
  readonly mode: ProviderRuntimePlanInput['mode'];
  readonly provider: ProviderRuntimePlanInput['provider'];
  readonly providerName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRootPath: string;
  readonly sessionId: string;
  readonly providerSessionId: string | null;
  readonly profileOptionArgs: readonly string[];
  readonly pluginPolicy: ReadonlyArray<ProviderPluginPolicyEntry>;
  readonly baseInput: Readonly<LaunchConfigInput>;
  readonly baseConfig: LaunchConfig;
}

class ProviderRuntimePlanValue extends ProviderRuntimePlan {
  constructor(readonly state: ProviderRuntimePlanState) {
    super();
    Object.freeze(this);
  }
}

interface RollbackState {
  readonly mode: ProviderRuntimePlanInput['mode'];
  readonly sessionId: string;
  readonly priorCapture: RuntimeContextCaptureSnapshot | null;
  readonly captureStarted: boolean;
  readonly preparedArtifacts: readonly PreparedOwner[];
}

interface PreparedOwner {
  readonly owner: ProviderLaunchArtifacts;
  readonly handle: PreparedArtifacts;
}

@Injectable()
export class ProviderRuntimePreparationService {
  private readonly artifactOwners: readonly ProviderLaunchArtifacts[];

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: Pick<StorageService, 'getProviderEnvForProject'>,
    private readonly providerPluginPolicy: ProviderPluginPolicyService,
    private readonly runtimeContextCapture: RuntimeContextCaptureService,
    claudeLaunchSettings: ClaudeLaunchSettingsMaterializerService,
    codexPluginProfiles: CodexPluginProfileMaterializerService,
  ) {
    this.artifactOwners = [claudeLaunchSettings, codexPluginProfiles];
  }

  async createPlan(input: ProviderRuntimePlanInput): Promise<ProviderRuntimePlan> {
    const profileOptionArgs = Object.freeze(parseProfileOptions(input.profileOptions));
    const effectiveModel =
      input.agentModelOverride ?? input.configModel ?? extractModelFromArgs([...profileOptionArgs]);
    const effectiveEffort = input.agentEffortOverride ?? input.configEffort ?? null;
    const providerEnv = this.storage.getProviderEnvForProject(input.provider.id, input.projectId);
    const pluginPolicy = await this.providerPluginPolicy.resolveAll(
      input.projectId,
      input.provider.id,
    );
    const providerName = input.provider.name.toLowerCase();
    const frozenProvider = Object.freeze({
      ...input.provider,
      env: input.provider.env ? Object.freeze({ ...input.provider.env }) : null,
    });

    for (const owner of this.ownersFor(providerName)) {
      owner.assertNoPolicyConflict(profileOptionArgs, pluginPolicy.length > 0);
    }

    const environment = getEnvConfig();
    const baseInput: Readonly<LaunchConfigInput> = Object.freeze({
      mode: input.mode,
      ...(input.mode === 'new'
        ? { sessionId: input.sessionId, initialPrompt: input.initialPrompt }
        : { providerSessionId: input.providerSessionId }),
      adapter: input.adapter,
      profileOptions: input.profileOptions,
      modelOverride: effectiveModel,
      effortOverride: effectiveEffort,
      providerBinPath: input.providerBinPath,
      providerEnv: providerEnv ? Object.freeze({ ...providerEnv }) : null,
      configEnv: input.configEnv ? Object.freeze({ ...input.configEnv }) : null,
      provider: frozenProvider,
      hookContext: isHookCapable(input.adapter)
        ? Object.freeze({
            apiUrl: HostResolver.buildInternalBaseUrl({
              host: environment.HOST,
              port: environment.PORT,
            }),
            projectId: input.projectId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            tmuxSessionName: input.tmuxSessionName,
          })
        : undefined,
    });
    const baseConfig = this.freezeConfig(resolveLaunchConfig(baseInput));

    if (input.mode === 'restore') {
      this.assertRestoreIdentity(baseConfig, input.provider.name, input.providerSessionId);
    }

    return new ProviderRuntimePlanValue(
      Object.freeze({
        mode: input.mode,
        provider: frozenProvider,
        providerName,
        projectId: input.projectId,
        projectName: input.projectName,
        projectRootPath: input.projectRootPath,
        sessionId: input.sessionId,
        providerSessionId: input.mode === 'restore' ? input.providerSessionId : null,
        profileOptionArgs,
        pluginPolicy: Object.freeze(
          pluginPolicy.map(({ pluginId, enabled }) => Object.freeze({ pluginId, enabled })),
        ),
        baseInput,
        baseConfig,
      } satisfies ProviderRuntimePlanState),
    );
  }

  async materialize(plan: ProviderRuntimePlan): Promise<PreparedProviderRuntime> {
    if (!(plan instanceof ProviderRuntimePlanValue)) {
      throw new ValidationError('Provider runtime plan was not created by this service.');
    }
    const state = plan.state;
    const priorCapture =
      state.mode === 'restore' ? this.runtimeContextCapture.snapshot(state.sessionId) : null;
    let captureStarted = false;
    const preparedArtifacts: PreparedOwner[] = [];
    const rollbackState = (): RollbackState => ({
      mode: state.mode,
      sessionId: state.sessionId,
      priorCapture,
      captureStarted,
      preparedArtifacts,
    });

    try {
      const epoch = this.runtimeContextCapture.rotateEpoch(
        state.sessionId,
        state.baseConfig.contextWindowOverride ?? null,
      );
      captureStarted = true;

      for (const owner of this.ownersFor(state.providerName)) {
        const handle = await owner.prepare({
          provider: state.provider,
          providerBinPath: state.baseInput.providerBinPath,
          profileOptionArgs: state.profileOptionArgs,
          providerEnv: state.baseInput.providerEnv,
          configEnv: state.baseInput.configEnv,
          sessionId: state.sessionId,
          epoch,
          projectId: state.projectId,
          projectName: state.projectName,
          projectRootPath: state.projectRootPath,
          pluginPolicy: state.pluginPolicy,
          launchUnsetEnv: state.baseInput.adapter.launchUnsetEnv ?? [],
        });
        preparedArtifacts.push({ owner, handle });
      }

      let config = this.applyManagedOverlay(state, preparedArtifacts);
      if (
        state.mode === 'restore' &&
        preparedArtifacts.some(({ handle }) => handle.optionArgs.length > 0)
      ) {
        this.assertRestoreIdentity(
          config,
          state.providerName,
          this.restoreProviderSessionId(state),
        );
      }

      for (const { handle } of preparedArtifacts) {
        if (handle.wrapCommand) {
          config = { ...config, commandArgs: handle.wrapCommand(config) };
        }
      }
      const finalConfig = this.freezeConfig(config);

      return Object.freeze({
        config: finalConfig,
        afterCommand: async () => {
          for (const { handle } of preparedArtifacts) {
            await handle.afterCommand?.();
          }
        },
        rollback: async () => this.rollbackPrepared(rollbackState(), false),
      });
    } catch (error) {
      await this.rollbackPrepared(rollbackState(), true);
      throw error;
    }
  }

  private ownersFor(providerName: string): ProviderLaunchArtifacts[] {
    return this.artifactOwners.filter((owner) => owner.providerName === providerName);
  }

  private assertRestoreIdentity(
    config: LaunchConfig,
    providerName: string,
    providerSessionId: string,
  ): void {
    if (!config.argv.includes(providerSessionId)) {
      throw new ValidationError(
        'Restore argv does not include provider session ID — adapter contract violation',
        { providerName, providerSessionId },
      );
    }
  }

  private applyManagedOverlay(
    state: ProviderRuntimePlanState,
    preparedArtifacts: readonly PreparedOwner[],
  ): LaunchConfig {
    const providerOptionArgs = preparedArtifacts.flatMap(({ handle }) => handle.optionArgs);
    const runtimeEnv: Record<string, string> = {};
    for (const { handle } of preparedArtifacts) Object.assign(runtimeEnv, handle.runtimeEnv);
    if (providerOptionArgs.length === 0 && Object.keys(runtimeEnv).length === 0) {
      return state.baseConfig;
    }

    return this.freezeConfig(
      resolveLaunchConfig({
        ...state.baseInput,
        providerOptionArgs,
        runtimeEnv,
      }),
    );
  }

  private async rollbackPrepared(state: RollbackState, suppressError: boolean): Promise<void> {
    let firstError: unknown;
    const attempt = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };

    for (const { owner, handle } of [...state.preparedArtifacts].reverse()) {
      await attempt(() => owner.cleanupPrepared(handle, state.sessionId));
    }
    if (state.captureStarted) {
      await attempt(() => {
        if (state.mode === 'restore') {
          this.runtimeContextCapture.restoreSnapshot(state.sessionId, state.priorCapture);
        } else {
          this.runtimeContextCapture.clear(state.sessionId);
        }
      });
    }

    if (!suppressError && firstError !== undefined) throw firstError;
  }

  private restoreProviderSessionId(state: ProviderRuntimePlanState): string {
    if (state.providerSessionId === null) {
      throw new ValidationError('Restore provider session ID is missing from the runtime plan.');
    }
    return state.providerSessionId;
  }

  private freezeConfig(config: LaunchConfig): LaunchConfig {
    const frozenConfig: LaunchConfig = {
      ...config,
      argv: [...config.argv],
      commandArgs: [...config.commandArgs],
      env: config.env ? { ...config.env } : null,
      promptHandshake: config.promptHandshake
        ? {
            ...config.promptHandshake,
            preKeys: config.promptHandshake.preKeys
              ? [...config.promptHandshake.preKeys]
              : undefined,
          }
        : undefined,
    };
    Object.freeze(frozenConfig.argv);
    Object.freeze(frozenConfig.commandArgs);
    if (frozenConfig.env) Object.freeze(frozenConfig.env);
    if (frozenConfig.promptHandshake?.preKeys) Object.freeze(frozenConfig.promptHandshake.preKeys);
    if (frozenConfig.promptHandshake) Object.freeze(frozenConfig.promptHandshake);
    return Object.freeze(frozenConfig);
  }
}
