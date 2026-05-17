// Provisional capability — single adopter (Claude). Revisit if a 2nd provider implements hooks.

export interface HookEnvContext {
  apiUrl: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  tmuxSessionName: string;
}

export interface HookCapability {
  readonly hooksEnabled: true;
  readonly hooksEventName: string;
  readonly hooksProvideTranscriptPath: boolean;
  // Relocated from sessions.service.ts composeLaunchEnv (was inline DEVCHAIN_* env construction).
  // These vars exist for hook integration, not provider env in general.
  buildHookEnv(context: HookEnvContext): Record<string, string>;
}
