import { z } from 'zod';

/**
 * terminal.watcher.triggered event
 * Published when a terminal watcher's condition matches the viewport content.
 */
export const terminalWatcherTriggeredEvent = {
  name: 'terminal.watcher.triggered',
  schema: z.object({
    // Watcher identification
    watcherId: z.string().min(1),
    watcherName: z.string().min(1),
    customEventName: z.string().min(1), // User-defined event name (e.g., 'claude.context_full')

    // Session context
    sessionId: z.string().min(1),
    agentId: z.string().nullable(), // Nullable - sessions may not have an agent
    agentName: z.string().nullable(), // Nullable
    projectId: z.string().min(1),

    // Viewport data
    viewportSnippet: z.string().max(500), // Last 500 chars of viewport
    viewportHash: z.string().min(1), // For deduplication tracking

    // Match details
    matchedPattern: z.string().optional(), // The pattern that matched (for debugging)

    // Trigger metadata
    triggerCount: z.number().int().min(1), // How many times this watcher has triggered
    triggeredAt: z.string().min(1), // ISO timestamp
  }),
} as const;

export type TerminalWatcherTriggeredEventPayload = z.infer<
  typeof terminalWatcherTriggeredEvent.schema
>;
