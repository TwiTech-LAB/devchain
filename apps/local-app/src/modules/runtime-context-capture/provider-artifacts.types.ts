export interface ProviderSessionArtifacts {
  cleanupSessionSync?(sessionId: string): void;
  cleanupSession?(sessionId: string): Promise<void>;
  reconcileStartup?(nonLiveSessionIds: ReadonlySet<string>): Promise<void> | void;
}

export interface ProviderPluginPolicyEntry {
  readonly pluginId: string;
  readonly enabled: boolean;
}

export interface PrepareProviderLaunchArtifactsInput {
  readonly provider: {
    readonly name: string;
    readonly claudeLaunchSettingsJson: string | null;
  };
  readonly providerBinPath: string;
  readonly profileOptionArgs: readonly string[];
  readonly providerEnv: Record<string, string> | null;
  readonly configEnv: Record<string, string> | null;
  readonly sessionId: string;
  readonly epoch: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRootPath: string;
  readonly pluginPolicy: ReadonlyArray<ProviderPluginPolicyEntry>;
  readonly launchUnsetEnv: readonly string[];
}

export interface PreparedArtifacts {
  readonly optionArgs: string[];
  readonly runtimeEnv: Record<string, string>;
  readonly wrapCommand?: (command: {
    readonly argv: readonly string[];
    readonly env: Record<string, string> | null;
  }) => string[];
  readonly afterCommand?: () => Promise<void>;
}

export interface ProviderLaunchArtifacts {
  readonly providerName: string;
  assertNoPolicyConflict(profileOptionArgs: readonly string[], policyActive: boolean): void;
  prepare(input: PrepareProviderLaunchArtifactsInput): Promise<PreparedArtifacts>;
  cleanupPrepared(handle: PreparedArtifacts, sessionId: string): Promise<void>;
}
