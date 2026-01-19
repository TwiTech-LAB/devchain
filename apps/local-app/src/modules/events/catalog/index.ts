import { z } from 'zod';
import { epicCreatedEvent } from './epic.created';
import { epicUpdatedEvent } from './epic.updated';
import { sessionStartedEvent } from './session.started';
import { sessionStoppedEvent } from './session.stopped';
import { sessionCrashedEvent } from './session.crashed';
import { terminalWatcherTriggeredEvent } from './terminal.watcher.triggered';
import { settingsTerminalChangedEvent } from './settings.terminal.changed';
import { guestRegisteredEvent } from './guest.registered';
import { guestUnregisteredEvent } from './guest.unregistered';
import { reviewCreatedEvent } from './review.created';
import { reviewUpdatedEvent } from './review.updated';
import { reviewCommentCreatedEvent } from './review.comment.created';
import { reviewCommentResolvedEvent } from './review.comment.resolved';
import { reviewCommentDeletedEvent } from './review.comment.deleted';
import { reviewCommentUpdatedEvent } from './review.comment.updated';

// Re-export individual event definitions for direct import
export { settingsTerminalChangedEvent } from './settings.terminal.changed';

export const eventCatalog = {
  [epicCreatedEvent.name]: epicCreatedEvent.schema,
  [epicUpdatedEvent.name]: epicUpdatedEvent.schema,
  [sessionStartedEvent.name]: sessionStartedEvent.schema,
  [sessionStoppedEvent.name]: sessionStoppedEvent.schema,
  [sessionCrashedEvent.name]: sessionCrashedEvent.schema,
  [terminalWatcherTriggeredEvent.name]: terminalWatcherTriggeredEvent.schema,
  [settingsTerminalChangedEvent.name]: settingsTerminalChangedEvent.schema,
  [guestRegisteredEvent.name]: guestRegisteredEvent.schema,
  [guestUnregisteredEvent.name]: guestUnregisteredEvent.schema,
  [reviewCreatedEvent.name]: reviewCreatedEvent.schema,
  [reviewUpdatedEvent.name]: reviewUpdatedEvent.schema,
  [reviewCommentCreatedEvent.name]: reviewCommentCreatedEvent.schema,
  [reviewCommentResolvedEvent.name]: reviewCommentResolvedEvent.schema,
  [reviewCommentDeletedEvent.name]: reviewCommentDeletedEvent.schema,
  [reviewCommentUpdatedEvent.name]: reviewCommentUpdatedEvent.schema,
} as const;

export type EventName = keyof typeof eventCatalog;
export type EventSchema<TName extends EventName> = (typeof eventCatalog)[TName];
export type EventPayload<TName extends EventName> = z.infer<EventSchema<TName>>;
export const eventNames = Object.keys(eventCatalog) as EventName[];
