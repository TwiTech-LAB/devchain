import type { BuildLaunchArgsResult } from '../provider-adapter.interface';

export interface ProviderSessionTranscript {
  providerSessionId: string;
  transcriptPath: string;
}

export interface CreateSessionSavePointInput extends ProviderSessionTranscript {
  projectId: string;
  projectPath: string;
  /**
   * The DevChain session ID of the target row. For `prepareForkLaunch` that row can exist already
   * and own provider files, so a copy must not overwrite or reuse anything named after this ID.
   */
  sessionId: string;
  providerBinPath: string;
  cliVersion?: string;
  /** The input environment for the launch, with hook variables during fork preparation. */
  env: Readonly<Record<string, string>> | null;
  /** The complete child environment for helper processes, without session or hook variables. */
  helperEnv: Readonly<Record<string, string>>;
}

export interface PrepareSessionForkLaunchInput extends CreateSessionSavePointInput {
  profileOptionArgs: string[];
}

/** A save point copy. DevChain discards a copy that it fails to store, where the provider can. */
export interface SessionSavePointCopy extends ProviderSessionTranscript {
  /** Discards the copy if DevChain fails to bind it to a session row. */
  discardUnboundTranscript?: () => Promise<void>;
}

export interface SessionForkLaunchResult extends SessionSavePointCopy, BuildLaunchArgsResult {
  /** DevChain calls it after it binds the prepared transcript to the session row. */
  commitBoundTranscript?: () => Promise<void>;
}

export interface SessionForkCapability {
  /**
   * True when `prepareForkLaunch` reads the save point's stored transcript path. DevChain then
   * validates that path under the provider roots first. An ID-based fork leaves it unset.
   */
  readonly forkReadsSavePointTranscript?: boolean;
  /** If present, DevChain probes the CLI version before it allows save or fork. */
  supportsForkForVersion?(cliVersion: string): boolean;
  createSavePoint(input: CreateSessionSavePointInput): Promise<SessionSavePointCopy>;
  prepareForkLaunch(input: PrepareSessionForkLaunchInput): Promise<SessionForkLaunchResult>;
}
