// Hook payloads and config locations differ by provider, so launch wiring
// consumes this capability rather than assuming one shared hook environment.

export interface HookEnvContext {
  apiUrl: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  tmuxSessionName: string;
}

export interface HookCapability {
  readonly hooksEnabled: true;
  readonly hooksProvideTranscriptPath: boolean;
  buildHookEnv(context: HookEnvContext): Record<string, string>;
}
