/**
 * Guest module constants
 */

/**
 * Name for the ephemeral sandbox project created for guests
 * without a matching project directory.
 */
export const GUEST_SANDBOX_PROJECT_NAME = 'Guest Sandbox';

/**
 * Sentinel root path for the sandbox project.
 * Uses a path that won't match any real directory.
 */
export const GUEST_SANDBOX_ROOT_PATH = '/__devchain_guest_sandbox__';

/**
 * Interval in milliseconds for health checking guest tmux sessions.
 * Default: 30 seconds
 */
export const GUEST_HEALTH_CHECK_INTERVAL_MS = 30_000;
