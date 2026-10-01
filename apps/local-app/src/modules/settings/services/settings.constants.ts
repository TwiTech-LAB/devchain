import type { TerminalInputMode } from '../dtos/settings.dto';

export {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
  DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
} from '../../../common/constants/terminal';

export const DEFAULT_TERMINAL_SEED_MAX_BYTES = 1024 * 1024;
export const MIN_TERMINAL_SEED_MAX_BYTES = 64 * 1024;
export const MAX_TERMINAL_SEED_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TERMINAL_INPUT_MODE: TerminalInputMode = 'tty';

export const DEFAULT_MESSAGE_POOL_ENABLED = true;
export const DEFAULT_MESSAGE_POOL_DELAY_MS = 10000;
export const MIN_MESSAGE_POOL_DELAY_MS = 1000;
export const MAX_MESSAGE_POOL_DELAY_MS = 60000;
export const DEFAULT_MESSAGE_POOL_MAX_WAIT_MS = 30000;
export const MIN_MESSAGE_POOL_MAX_WAIT_MS = 5000;
export const MAX_MESSAGE_POOL_MAX_WAIT_MS = 120000;
export const DEFAULT_MESSAGE_POOL_MAX_MESSAGES = 10;
export const MIN_MESSAGE_POOL_MAX_MESSAGES = 1;
export const MAX_MESSAGE_POOL_MAX_MESSAGES = 100;
export const DEFAULT_MESSAGE_POOL_SEPARATOR = '\n---\n';
export const DEFAULT_SKILLS_SYNC_ON_STARTUP = true;
export const DEFAULT_MESSAGING_FOLLOW_NOTE = true;

/**
 * Used when `events.epicAssigned.template` has no stored value. Lives here so
 * every reader (settings delegates, the assignment notifier, the replica read
 * side) resolves the same default.
 */
export const DEFAULT_EPIC_ASSIGNED_TEMPLATE =
  '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. Status: {epic_status}. (Epic ID: {epic_id})';

/** Fallback of `activity.idleTimeoutMs` shared by its readers. */
export const DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS = 30000;

export interface ProjectPoolSettings {
  enabled?: boolean;
  delayMs?: number;
  maxWaitMs?: number;
  maxMessages?: number;
  separator?: string;
}

export interface ProjectSettings {
  initialSessionPromptId?: string | null;
  autoCleanStatusIds?: string[];
  epicAssignedTemplate?: string;
  messagePoolSettings?: ProjectPoolSettings;
}
