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
 * Whether Ctrl+C is withheld from the terminal while text is selected.
 *
 * Selecting text in the terminal already copies it, so a Ctrl+C pressed with a
 * selection contributes nothing to copying — but it does reach the provider,
 * where it clears whatever the user had typed and not yet sent. Withholding it
 * costs nothing and matches the habit of copying with Ctrl+C. With no selection
 * it is always forwarded, so interrupting an agent still works.
 */
export const DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION = true;
