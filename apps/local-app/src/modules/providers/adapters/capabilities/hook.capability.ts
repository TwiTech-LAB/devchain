// Real capability — 2nd adopter (Copilot) landed alongside Claude. The hook
// surface differs per provider (payload casing, config location, event keys), so
// this stays a typed capability rather than a base-interface field: each adopter
// supplies its own `hooksEventName` + `buildHookEnv`, narrowed via `isHookCapable`.

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
