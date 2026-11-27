import type { ProviderAdapter } from '../../../providers/adapters/provider-adapter.interface';
import type {
  ProviderSessionTranscript,
  SessionForkCapability,
} from '../../../providers/adapters/capabilities/session-fork.capability';
import type { Provider } from '../../../storage/models/domain.models';
import type { LaunchConfig } from '../provider-launch-config';

interface SharedProviderRuntimePlanInput {
  readonly adapter: ProviderAdapter;
  readonly provider: Provider;
  readonly providerBinPath: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRootPath: string;
  readonly agentId: string;
  readonly agentModelOverride: string | null | undefined;
  readonly agentEffortOverride: string | null | undefined;
  readonly configModel: string | null | undefined;
  readonly configEffort: string | null | undefined;
  readonly profileOptions: string | null | undefined;
  readonly configEnv: Record<string, string> | null;
  readonly sessionId: string;
  readonly tmuxSessionName: string;
}

export interface NewProviderRuntimePlanInput extends SharedProviderRuntimePlanInput {
  readonly mode: 'new';
  readonly initialPrompt?: string;
  readonly providerSessionId?: never;
}

export interface RestoreProviderRuntimePlanInput extends SharedProviderRuntimePlanInput {
  readonly mode: 'restore';
  readonly providerSessionId: string;
  readonly initialPrompt?: never;
}

export interface ForkProviderRuntimePlanInput extends SharedProviderRuntimePlanInput {
  readonly mode: 'fork';
  readonly adapter: ProviderAdapter & SessionForkCapability;
  readonly savePoint: ProviderSessionTranscript;
  readonly cliVersion?: string;
  readonly helperEnv: Readonly<Record<string, string>>;
  readonly providerSessionId?: never;
  readonly initialPrompt?: never;
}

export type ProviderRuntimePlanInput =
  | NewProviderRuntimePlanInput
  | RestoreProviderRuntimePlanInput
  | ForkProviderRuntimePlanInput;

export abstract class ProviderRuntimePlan {
  declare private readonly providerRuntimePlanBrand: void;
  abstract readonly fork: Readonly<ProviderSessionTranscript> | null;
  /** Removes a fork copy that no session row owns yet. Logs a failure and never rejects. */
  abstract readonly discardUnboundTranscript?: () => Promise<void>;
  /** Finishes a fork copy after a session row owns it. Logs a failure and never rejects. */
  abstract readonly commitBoundTranscript?: () => Promise<void>;

  protected constructor() {}
}

export interface PreparedProviderRuntime {
  readonly config: LaunchConfig;
  /** The line to type into the pane: `/bin/sh <launch script>`. The script runs `config.commandArgs`. */
  readonly typedArgs: readonly string[];
  readonly afterCommand: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}
