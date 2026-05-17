export interface McpServerEntry {
  alias: string;
  endpoint: string;
  transport?: string;
}

export interface LaunchInitialPromptBehavior {
  preKeys?: string[];
  preDelayMs?: number;
}

export interface RuntimePromptBehavior {
  postPasteDelayMs?: number;
}

export interface TerminalOutputBehavior {
  /**
   * When true, the adapter emits raw VT-style output: bare LF means
   * cursor-down-only, cursor positioning is done explicitly via CSI sequences,
   * and the terminal pipeline must NOT add CR before LF. When undefined or
   * false, the pipeline normalizes bare LFs to CRLF on the server side
   * (required because xterm.js runs with convertEol:false for Claude's sake).
   */
  rawLineEndings?: boolean;
}

export interface AddMcpServerOptions {
  endpoint: string;
  alias?: string;
  extraArgs?: string[];
}

export interface BuildLaunchArgsInput {
  mode: 'new' | 'restore';
  providerSessionId?: string;
  profileOptionArgs: string[];
}

export interface ProviderAdapter {
  readonly providerName: string;
  readonly launchInitialPromptBehavior?: LaunchInitialPromptBehavior;
  readonly runtimePromptBehavior?: RuntimePromptBehavior;
  readonly terminalOutputBehavior?: TerminalOutputBehavior;
  buildLaunchArgs(input: BuildLaunchArgsInput): { argv: string[] };
}
