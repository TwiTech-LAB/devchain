/**
 * Event Fields Catalog
 * Defines available fields for each subscribable event type.
 *
 * This catalog is used by:
 * - UI: To populate field selectors when configuring subscriber input mappings
 * - API: To expose subscribable events and their fields
 * - SubscriberExecutorService: To validate event payloads and resolve input mappings
 */

/**
 * Definition of a single field available in an event payload.
 */
export interface EventFieldDefinition {
  /** Field path (supports dot notation for nested fields) */
  field: string;

  /** Human-readable label for UI display */
  label: string;

  /** Data type of the field */
  type: 'string' | 'number' | 'boolean';

  /** Whether this field may be null/undefined */
  nullable?: boolean;
}

/**
 * Definition of a subscribable event with its fields.
 */
export interface SubscribableEventDefinition {
  /** Event name (e.g., 'terminal.watcher.triggered') */
  name: string;

  /** Human-readable label for UI display */
  label: string;

  /** Description of when this event fires */
  description: string;

  /** Category for UI organization */
  category: 'terminal' | 'session' | 'epic' | 'chat';

  /** Available fields in the event payload */
  fields: EventFieldDefinition[];
}

/**
 * Catalog of all subscribable events with their field definitions.
 * Organized by event name for quick lookup.
 */
export const EVENT_FIELDS_CATALOG: Record<string, SubscribableEventDefinition> = {
  'terminal.watcher.triggered': {
    name: 'terminal.watcher.triggered',
    label: 'Terminal Watcher Triggered',
    description: 'Fired when a terminal watcher matches content in the viewport',
    category: 'terminal',
    fields: [
      { field: 'watcherId', label: 'Watcher ID', type: 'string' },
      { field: 'watcherName', label: 'Watcher Name', type: 'string' },
      { field: 'customEventName', label: 'Custom Event Name', type: 'string' },
      { field: 'sessionId', label: 'Session ID', type: 'string' },
      { field: 'agentId', label: 'Agent ID', type: 'string', nullable: true },
      { field: 'agentName', label: 'Agent Name', type: 'string', nullable: true },
      { field: 'projectId', label: 'Project ID', type: 'string' },
      { field: 'viewportSnippet', label: 'Viewport Snippet', type: 'string' },
      { field: 'viewportHash', label: 'Viewport Hash', type: 'string' },
      { field: 'matchedPattern', label: 'Matched Pattern', type: 'string', nullable: true },
      { field: 'triggerCount', label: 'Trigger Count', type: 'number' },
      { field: 'triggeredAt', label: 'Triggered At', type: 'string' },
    ],
  },

  /**
   * @deprecated Use epic.updated with changes.agentId instead.
   * This event is emitted for backward compatibility and will be removed in a future release.
   */
  'epic.assigned': {
    name: 'epic.assigned',
    label: 'Epic Assigned (Deprecated)',
    description:
      'DEPRECATED: Fired when an epic is assigned to an agent. Use epic.updated with changes.agentId instead.',
    category: 'epic',
    fields: [
      { field: 'epicId', label: 'Epic ID', type: 'string' },
      { field: 'projectId', label: 'Project ID', type: 'string' },
      { field: 'agentId', label: 'Agent ID', type: 'string' },
      { field: 'previousAgentId', label: 'Previous Agent ID', type: 'string', nullable: true },
      { field: 'epicTitle', label: 'Epic Title', type: 'string', nullable: true },
      { field: 'projectName', label: 'Project Name', type: 'string', nullable: true },
      { field: 'agentName', label: 'Agent Name', type: 'string', nullable: true },
    ],
  },

  'epic.updated': {
    name: 'epic.updated',
    label: 'Epic Updated',
    description: 'Fired when an epic is updated (title, status, agent, or parent changed)',
    category: 'epic',
    fields: [
      // Base fields
      { field: 'epicId', label: 'Epic ID', type: 'string' },
      { field: 'projectId', label: 'Project ID', type: 'string' },
      { field: 'version', label: 'Version', type: 'number' },
      { field: 'epicTitle', label: 'Epic Title', type: 'string' },
      { field: 'projectName', label: 'Project Name', type: 'string', nullable: true },
      // Actor field (who triggered this event)
      { field: 'actor.type', label: 'Actor Type', type: 'string', nullable: true },
      { field: 'actor.id', label: 'Actor ID', type: 'string', nullable: true },
      // Agent change fields (for assignment tracking)
      {
        field: 'changes.agentId.previous',
        label: 'Previous Agent ID',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.agentId.current',
        label: 'Current Agent ID',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.agentId.previousName',
        label: 'Previous Agent Name',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.agentId.currentName',
        label: 'Current Agent Name',
        type: 'string',
        nullable: true,
      },
      // Status change fields
      {
        field: 'changes.statusId.previous',
        label: 'Previous Status ID',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.statusId.current',
        label: 'Current Status ID',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.statusId.previousName',
        label: 'Previous Status Name',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.statusId.currentName',
        label: 'Current Status Name',
        type: 'string',
        nullable: true,
      },
      // Title change fields
      { field: 'changes.title.previous', label: 'Previous Title', type: 'string', nullable: true },
      { field: 'changes.title.current', label: 'Current Title', type: 'string', nullable: true },
      // Parent change fields
      {
        field: 'changes.parentId.previous',
        label: 'Previous Parent ID',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.parentId.current',
        label: 'Current Parent ID',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.parentId.previousTitle',
        label: 'Previous Parent Title',
        type: 'string',
        nullable: true,
      },
      {
        field: 'changes.parentId.currentTitle',
        label: 'Current Parent Title',
        type: 'string',
        nullable: true,
      },
    ],
  },

  'epic.created': {
    name: 'epic.created',
    label: 'Epic Created',
    description: 'Fired when a new epic is created',
    category: 'epic',
    fields: [
      { field: 'epicId', label: 'Epic ID', type: 'string' },
      { field: 'projectId', label: 'Project ID', type: 'string' },
      { field: 'title', label: 'Epic Title', type: 'string' },
      { field: 'statusId', label: 'Status ID', type: 'string', nullable: true },
      { field: 'agentId', label: 'Agent ID', type: 'string', nullable: true },
      { field: 'parentId', label: 'Parent Epic ID', type: 'string', nullable: true },
      // Actor field (who triggered this event)
      { field: 'actor.type', label: 'Actor Type', type: 'string', nullable: true },
      { field: 'actor.id', label: 'Actor ID', type: 'string', nullable: true },
      { field: 'projectName', label: 'Project Name', type: 'string', nullable: true },
      { field: 'statusName', label: 'Status Name', type: 'string', nullable: true },
      { field: 'agentName', label: 'Agent Name', type: 'string', nullable: true },
      { field: 'parentTitle', label: 'Parent Epic Title', type: 'string', nullable: true },
    ],
  },

  'session.started': {
    name: 'session.started',
    label: 'Session Started',
    description: 'Fired when a new session is started',
    category: 'session',
    fields: [
      { field: 'sessionId', label: 'Session ID', type: 'string' },
      { field: 'epicId', label: 'Epic ID', type: 'string', nullable: true },
      { field: 'agentId', label: 'Agent ID', type: 'string' },
      { field: 'tmuxSessionName', label: 'Tmux Session Name', type: 'string' },
    ],
  },

  'session.stopped': {
    name: 'session.stopped',
    label: 'Session Stopped',
    description: 'Fired when a session is stopped',
    category: 'session',
    fields: [{ field: 'sessionId', label: 'Session ID', type: 'string' }],
  },

  'session.crashed': {
    name: 'session.crashed',
    label: 'Session Crashed',
    description: 'Fired when a session crashes unexpectedly',
    category: 'session',
    fields: [
      { field: 'sessionId', label: 'Session ID', type: 'string' },
      { field: 'sessionName', label: 'Session Name', type: 'string' },
    ],
  },
};

/**
 * Get list of all subscribable event names.
 * @returns Array of event names
 */
export function getSubscribableEvents(): string[] {
  return Object.keys(EVENT_FIELDS_CATALOG);
}

/**
 * Get the definition for a specific event.
 * @param eventName - The event name to look up
 * @returns The event definition or undefined if not found
 */
export function getEventDefinition(eventName: string): SubscribableEventDefinition | undefined {
  return EVENT_FIELDS_CATALOG[eventName];
}

/**
 * Get available fields for a specific event.
 * @param eventName - The event name to get fields for
 * @returns Array of field definitions (empty if event not found)
 */
export function getEventFields(eventName: string): EventFieldDefinition[] {
  return EVENT_FIELDS_CATALOG[eventName]?.fields || [];
}

/**
 * Check if an event is subscribable.
 * @param eventName - The event name to check
 * @returns true if the event is in the catalog
 */
export function isSubscribableEvent(eventName: string): boolean {
  return eventName in EVENT_FIELDS_CATALOG;
}

/**
 * Get all subscribable events grouped by category.
 * @returns Map of category to event definitions
 */
export function getEventsByCategory(): Map<string, SubscribableEventDefinition[]> {
  const byCategory = new Map<string, SubscribableEventDefinition[]>();

  for (const event of Object.values(EVENT_FIELDS_CATALOG)) {
    const existing = byCategory.get(event.category) || [];
    existing.push(event);
    byCategory.set(event.category, existing);
  }

  return byCategory;
}
