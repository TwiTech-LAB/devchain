/**
 * Terminal scrollback constants - single source of truth
 * Used by: SettingsService, SettingsPage
 */

/** Default number of scrollback lines for terminal */
export const DEFAULT_TERMINAL_SCROLLBACK = 10000;

/** Minimum allowed scrollback lines */
export const MIN_TERMINAL_SCROLLBACK = 100;

/** Maximum allowed scrollback lines */
export const MAX_TERMINAL_SCROLLBACK = 50000;

/**
 * Whether Ctrl+C copies selected terminal text instead of sending an
 * interrupt. The stored KV key keeps the negative "suppress" wording for
 * compatibility with PR #22; user-facing labels stay positive.
 */
export const DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION = true;
