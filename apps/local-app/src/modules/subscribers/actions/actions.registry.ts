import type { ActionDefinition } from './action.interface';
import { sendMessageAction } from './send-message.action';
import { restartAgentAction } from './restart-agent.action';

/**
 * Actions Registry
 * Central registry of all available automation actions.
 *
 * To add a new action:
 * 1. Create the action file (e.g., my-action.action.ts)
 * 2. Import it here
 * 3. Add it to the ACTIONS_REGISTRY array
 */

/**
 * Registry of all available actions.
 * Each action is a complete ActionDefinition with execute function.
 */
export const ACTIONS_REGISTRY: ActionDefinition[] = [
  sendMessageAction,
  restartAgentAction,
  // Future actions:
  // sendNotificationAction,
];

/**
 * Get an action by type.
 *
 * @param type - The action type identifier (e.g., 'send_agent_message')
 * @returns The full ActionDefinition including execute function, or undefined if not found
 */
export function getAction(type: string): ActionDefinition | undefined {
  return ACTIONS_REGISTRY.find((action) => action.type === type);
}

/**
 * Get all available actions for API responses.
 * Strips the execute function for safe JSON serialization.
 *
 * @returns Array of action metadata without execute functions
 */
export function getAllActions(): Omit<ActionDefinition, 'execute'>[] {
  return ACTIONS_REGISTRY.map((action) => {
    // Destructure to exclude execute function
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { execute, ...actionWithoutExecute } = action;
    return actionWithoutExecute;
  });
}

/**
 * Get a single action's metadata by type (without execute function).
 *
 * @param type - The action type identifier
 * @returns Action metadata without execute function, or undefined if not found
 */
export function getActionMetadata(type: string): Omit<ActionDefinition, 'execute'> | undefined {
  const action = getAction(type);
  if (!action) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { execute, ...actionWithoutExecute } = action;
  return actionWithoutExecute;
}

/**
 * Check if an action type exists in the registry.
 *
 * @param type - The action type identifier
 * @returns true if the action exists
 */
export function hasAction(type: string): boolean {
  return ACTIONS_REGISTRY.some((action) => action.type === type);
}

/**
 * Get all action types.
 *
 * @returns Array of action type identifiers
 */
export function getActionTypes(): string[] {
  return ACTIONS_REGISTRY.map((action) => action.type);
}
