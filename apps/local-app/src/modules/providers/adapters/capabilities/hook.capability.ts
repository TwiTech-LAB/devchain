// Hook payloads and config locations differ by provider, so launch wiring
// consumes this capability rather than assuming one shared hook environment.

export const SESSION_START_SOURCE_ENV = 'DEVCHAIN_SESSION_START_SOURCE';

export const HOOK_ENV_KEYS = [
  'DEVCHAIN_API_URL',
  'DEVCHAIN_PROJECT_ID',
  'DEVCHAIN_AGENT_ID',
  'DEVCHAIN_SESSION_ID',
  'DEVCHAIN_TMUX_SESSION_NAME',
  'DEVCHAIN_HOOK_PROVIDER',
  SESSION_START_SOURCE_ENV,
] as const;

export interface HookEnvContext {
  apiUrl: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  tmuxSessionName: string;
  sessionStartSource?: 'fork';
}

export interface HookCapability {
  readonly hooksEnabled: true;
  readonly hooksProvideTranscriptPath: boolean;
  /** These keys come from buildHookEnv and are cleared from the process environment when omitted. */
  readonly managedHookEnvKeys?: readonly string[];
  buildHookEnv(context: HookEnvContext): Record<string, string>;
}
