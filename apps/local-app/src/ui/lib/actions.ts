/**
 * Actions API functions
 * Provides centralized API layer for action metadata retrieval.
 */

// ============================================
// TYPES
// ============================================

export type ActionCategory = 'terminal' | 'session' | 'notification' | 'external';

export interface ActionInput {
  name: string;
  label: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea';
  required: boolean;
  defaultValue?: string | number | boolean;
  options?: { value: string; label: string }[];
  /**
   * Allowed source types for this input.
   * If not specified, defaults to ['custom', 'event_field'] (both allowed).
   */
  allowedSources?: Array<'custom' | 'event_field'>;
}

/**
 * Event field definition for mapping event payload fields to action inputs.
 * These come from the event catalog (GET /api/subscribers/events), not from actions.
 */
export interface EventFieldDefinition {
  /** Field name in the event payload (e.g., 'watcherId', 'agentName') */
  field: string;
  /** Human-readable label for UI display */
  label: string;
  /** Data type of the field */
  type: string;
  /** Whether this field may be null/undefined */
  nullable?: boolean;
}

export interface ActionMetadata {
  type: string;
  name: string;
  description: string;
  category: ActionCategory;
  inputs: ActionInput[];
}

// ============================================
// API FUNCTIONS
// ============================================

/**
 * Fetch all available actions.
 */
export async function fetchActions(): Promise<ActionMetadata[]> {
  const response = await fetch('/api/actions');
  if (!response.ok) {
    throw new Error('Failed to fetch actions');
  }
  return response.json();
}

/**
 * Fetch a single action by type.
 */
export async function fetchAction(type: string): Promise<ActionMetadata> {
  const response = await fetch(`/api/actions/${encodeURIComponent(type)}`);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Action type '${type}' not found`);
    }
    throw new Error('Failed to fetch action');
  }
  return response.json();
}
