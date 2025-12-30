/**
 * Action System Interfaces
 * Defines the contract for automation actions that can be executed by subscribers.
 *
 * Actions are triggered by system events and can perform operations like:
 * - Sending messages to terminal sessions
 * - Restarting sessions
 * - Sending notifications
 * - Calling external APIs
 */

import type { Logger } from 'pino';
import type { TmuxService } from '../../terminal/services/tmux.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import type { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import type { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';

// ============================================
// EVENT ENVELOPE
// ============================================

/**
 * Standardized event envelope for action execution.
 * Provides a consistent structure for all event types while preserving event-specific data.
 *
 * This envelope enables actions to work with any system event (not just watcher events)
 * while maintaining type safety for common fields.
 */
export interface EventEnvelope {
  /** Event name (e.g., 'terminal.watcher.triggered', 'epic.assigned') */
  eventName: string;

  /** Project ID */
  projectId: string;

  /** Agent ID (if applicable) */
  agentId?: string | null;

  /** Session ID (if applicable) */
  sessionId?: string;

  /** ISO timestamp when the event occurred */
  occurredAt: string;

  /** Optional unique event ID for tracing */
  eventId?: string;

  /** Full event-specific payload (flexible, event-dependent) */
  payload: Record<string, unknown>;
}

// ============================================
// ACTION INPUT DEFINITION
// ============================================

/**
 * Input field definition for an action.
 * Describes what inputs the action expects, including UI metadata for form rendering.
 */
export interface ActionInputDefinition {
  /** Unique identifier for this input (used as key in inputs object) */
  name: string;

  /** Human-readable label for UI display */
  label: string;

  /** Data type of the input */
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea';

  /** Whether this input is required */
  required: boolean;

  /** Optional description/help text for the input */
  description?: string;

  /** Placeholder text for text inputs */
  placeholder?: string;

  /** Default value if not provided */
  defaultValue?: unknown;

  /** Options for 'select' type inputs */
  options?: Array<{ value: string; label: string }>;

  /** Minimum length for string inputs */
  minLength?: number;

  /** Maximum length for string inputs */
  maxLength?: number;

  /** Minimum value for number inputs */
  min?: number;

  /** Maximum value for number inputs */
  max?: number;

  /** Regex pattern for string validation */
  pattern?: string;

  /**
   * Allowed source types for this input.
   * - 'custom': User can provide a static/template value
   * - 'event_field': User can bind to an event payload field
   *
   * If not specified, defaults to ['custom', 'event_field'] (both allowed).
   * Use ['custom'] for inputs that should only accept static values (e.g., submitKey).
   */
  allowedSources?: Array<'custom' | 'event_field'>;
}

// ============================================
// ACTION CONTEXT
// ============================================

/**
 * Context provided to action execution.
 * Contains services and data needed to perform the action.
 */
export interface ActionContext {
  /** Tmux service for terminal operations */
  tmuxService: TmuxService;

  /** Sessions service for session management */
  sessionsService: SessionsService;

  /** Session coordinator for agent-level locking */
  sessionCoordinator: SessionCoordinatorService;

  /** Coordinator for sending messages to terminals */
  sendCoordinator: TerminalSendCoordinatorService;

  /** Message pool service for batched message delivery */
  messagePoolService: SessionsMessagePoolService;

  /** Storage service for data access (e.g., agent resolution) */
  storage: StorageService;

  /** ID of the session that triggered the event */
  sessionId: string;

  /** ID of the agent associated with the session (may be null) */
  agentId: string | null;

  /** ID of the project */
  projectId: string;

  /** Tmux session name for direct terminal access */
  tmuxSessionName: string;

  /** Standardized event envelope containing event metadata and payload */
  event: EventEnvelope;

  /** Logger instance for action logging */
  logger: Logger;
}

// ============================================
// ACTION RESULT
// ============================================

/**
 * Result of action execution.
 */
export interface ActionResult {
  /** Whether the action completed successfully */
  success: boolean;

  /** Human-readable message about the result */
  message?: string;

  /** Error message if action failed */
  error?: string;

  /** Additional data returned by the action */
  data?: unknown;
}

// ============================================
// ACTION DEFINITION
// ============================================

/**
 * Action category for UI organization.
 */
export type ActionCategory = 'terminal' | 'session' | 'notification' | 'external';

/**
 * Action definition that describes an action type.
 * Used by the UI to render action configuration forms and by the executor to run actions.
 *
 * Note: Event fields for input mapping come from the event catalog (GET /api/subscribers/events),
 * not from the action definition. This allows the same action to work with any event type.
 */
export interface ActionDefinition {
  /** Unique identifier for this action type (e.g., 'send_agent_message') */
  type: string;

  /** Human-readable name for UI display */
  name: string;

  /** Description of what this action does */
  description: string;

  /** Category for UI organization */
  category: ActionCategory;

  /** Input fields this action accepts */
  inputs: ActionInputDefinition[];

  /** Execute the action with the given context and resolved inputs */
  execute: (context: ActionContext, inputs: Record<string, unknown>) => Promise<ActionResult>;
}

// ============================================
// ACTION REGISTRATION (for registry)
// ============================================

/**
 * Action executor function type.
 */
export type ActionExecutor = (
  context: ActionContext,
  inputs: Record<string, unknown>,
) => Promise<ActionResult>;

/**
 * Complete action registration including definition and executor.
 * Used internally by the actions registry.
 */
export interface ActionRegistration {
  definition: Omit<ActionDefinition, 'execute'>;
  execute: ActionExecutor;
}
