import { z } from 'zod';
import { epicAssignedEvent } from './epic.assigned';
import { epicCreatedEvent } from './epic.created';
import { epicUpdatedEvent } from './epic.updated';
import { sessionStartedEvent } from './session.started';
import { sessionStoppedEvent } from './session.stopped';
import { sessionCrashedEvent } from './session.crashed';
import { terminalWatcherTriggeredEvent } from './terminal.watcher.triggered';
import { settingsTerminalChangedEvent } from './settings.terminal.changed';

// Re-export individual event definitions for direct import
export { settingsTerminalChangedEvent } from './settings.terminal.changed';

export const eventCatalog = {
  /** @deprecated Use epic.updated with changes.agentId instead */
  [epicAssignedEvent.name]: epicAssignedEvent.schema,
  [epicCreatedEvent.name]: epicCreatedEvent.schema,
  [epicUpdatedEvent.name]: epicUpdatedEvent.schema,
  [sessionStartedEvent.name]: sessionStartedEvent.schema,
  [sessionStoppedEvent.name]: sessionStoppedEvent.schema,
  [sessionCrashedEvent.name]: sessionCrashedEvent.schema,
  [terminalWatcherTriggeredEvent.name]: terminalWatcherTriggeredEvent.schema,
  [settingsTerminalChangedEvent.name]: settingsTerminalChangedEvent.schema,
} as const;

export type EventName = keyof typeof eventCatalog;
export type EventSchema<TName extends EventName> = (typeof eventCatalog)[TName];
export type EventPayload<TName extends EventName> = z.infer<EventSchema<TName>>;
export const eventNames = Object.keys(eventCatalog) as EventName[];
