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
  /**
   * When true, the provider runs as a full-screen TUI that legitimately uses the
   * terminal alternate screen. The terminal pipeline then KEEPS alt-screen on
   * (tmux `alternate-screen on`) and does NOT strip the `?1049/?1047/?47` DECSET
   * toggles from the PTY stream — critical because TUIs emit a combined
   * `ESC[?1049;1000h` (alt-screen + mouse-tracking) and stripping the whole DECSET
   * would drop mouse-tracking as collateral, breaking wheel passthrough. When
   * undefined or false, alt-screen is suppressed (tmux `alternate-screen off` and
   * the strip stays active) so line-streaming CLIs accumulate scrollback — the
   * broader, safer default.
   */
  usesAlternateScreen?: boolean;
}

export interface AddMcpServerOptions {
  endpoint: string;
  alias?: string;
  extraArgs?: string[];
}

export interface BuildLaunchArgsInput {
  mode: 'new' | 'restore';
  providerSessionId?: string;
  /**
   * The devchain `sessions.id` for a NEW launch. Supplied only for `mode:'new'`
   * so a deterministic-binding adapter (e.g. Copilot) can pass it to the provider
   * CLI as that session's own UUID (`--session-id <sessions.id>`), making the
   * transcript path derivable pre-scan. Undefined for `mode:'restore'` (which
   * binds via `providerSessionId`, e.g. `--resume`) and ignored by adapters that
   * do not bind at launch — existing providers simply never read it.
   */
  sessionId?: string;
  profileOptionArgs: string[];
  /**
   * Pre-rendered initial prompt, supplied ONLY for adapters that declare an
   * `initialPromptSeedMode` (opt-in launch-time seeding). `argv`-mode adapters
   * emit it as an argv value here; `stdin`-mode adapters ignore it (the launch
   * pipeline pipes it to the process after start). Undefined for every provider
   * that uses the default post-launch paste path, and whenever no initial prompt
   * is configured for the project.
   */
  initialPrompt?: string;
}

export interface ProviderAdapter {
  readonly providerName: string;
  readonly launchInitialPromptBehavior?: LaunchInitialPromptBehavior;
  readonly runtimePromptBehavior?: RuntimePromptBehavior;
  readonly terminalOutputBehavior?: TerminalOutputBehavior;
  /**
   * Opt-in initial-prompt seeding at launch time, instead of the default
   * post-launch out-of-band paste. Set this for full-screen TUIs (e.g. agy)
   * where pasting into an alt-screen bubbletea UI is fragile. When set, the
   * launch pipeline renders the initial prompt BEFORE `resolveLaunchConfig()`,
   * threads it into `buildLaunchArgs` as `initialPrompt`, and SKIPS the
   * post-launch paste.
   *
   * - `'argv'`: the adapter emits the prompt as an argv value from
   *   `buildLaunchArgs` (note: argv is visible in `ps`/`/proc`).
   * - `'stdin'`: the pipeline pipes the prompt to the process after start
   *   (no paste); the adapter's `buildLaunchArgs` ignores `initialPrompt`.
   *
   * Leave undefined to keep the existing post-launch paste path unchanged.
   */
  readonly initialPromptSeedMode?: 'argv' | 'stdin';
  /**
   * Environment variables the provider needs cleared from its launch
   * environment (passed to `env -u <KEY>`). Lets a provider opt out of
   * inherited vars without callers hardcoding provider-specific behavior.
   */
  readonly launchUnsetEnv?: readonly string[];
  /**
   * Environment variable keys that MUST NOT be present in a provider's launch
   * environment (provider or config env). When any is set, `resolveLaunchConfig`
   * throws BEFORE the process starts. Used for vars that would let launch succeed
   * but break read-time invariants — e.g. Copilot rejects `COPILOT_HOME` (R4)
   * because a relocated store passes launch then fails transcript-path validation
   * (`PROVIDER_ROOTS` is `os.homedir()`-relative). Provider-agnostic mechanism.
   */
  readonly launchRejectEnv?: readonly string[];
  buildLaunchArgs(input: BuildLaunchArgsInput): { argv: string[] };
}
