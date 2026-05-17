import { z } from 'zod';
import { agentCreatedEvent } from './agent.created';
import { agentDeletedEvent } from './agent.deleted';
import { chatMessageReadEvent } from './chat.message.read';
import { epicCreatedEvent } from './epic.created';
import { epicDeletedEvent } from './epic.deleted';
import { epicUpdatedEvent } from './epic.updated';
import { epicCommentCreatedEvent } from './epic.comment.created';
import { sessionStartedEvent } from './session.started';
import { sessionRestoredEvent } from './session.restored';
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
import { claudeHooksSessionStartedEvent } from './claude.hooks.session.started';
import { sessionTranscriptDiscoveredEvent } from './session.transcript.discovered';
import { sessionProviderSessionIdDiscoveredEvent } from './session.provider-session-id.discovered';
import { sessionTranscriptUpdatedEvent } from './session.transcript.updated';
import { sessionTranscriptEndedEvent } from './session.transcript.ended';
import { teamConfigUpdatedEvent } from './team.config.updated';
import { teamMemberAddedEvent } from './team.member.added';
import { teamMemberRemovedEvent } from './team.member.removed';
import { sessionActivityChangedEvent } from './session.activity.changed';
import { sessionCloudConnectedEvent } from './session.cloud-connected';
import { sessionCloudDisconnectedEvent } from './session.cloud-disconnected';
import { sessionPresenceChangedEvent } from './session.presence.changed';
import { sessionRecommendationEvent } from './session.recommendation';
import { scheduledEpicExecutedEvent } from './scheduled-epic.executed';

// Re-export individual event definitions for direct import
export { settingsTerminalChangedEvent } from './settings.terminal.changed';
export { sessionRestoredEvent } from './session.restored';
export type { SessionRestoredEventPayload } from './session.restored';
export { scheduledEpicExecutedEvent } from './scheduled-epic.executed';
export type {
  ScheduledEpicExecutedEventPayload,
  ScheduledEpicErrorCode,
} from './scheduled-epic.executed';

export const eventCatalog = {
  [agentCreatedEvent.name]: agentCreatedEvent.schema,
  [agentDeletedEvent.name]: agentDeletedEvent.schema,
  [chatMessageReadEvent.name]: chatMessageReadEvent.schema,
  [epicCreatedEvent.name]: epicCreatedEvent.schema,
  [epicDeletedEvent.name]: epicDeletedEvent.schema,
  [epicUpdatedEvent.name]: epicUpdatedEvent.schema,
  [epicCommentCreatedEvent.name]: epicCommentCreatedEvent.schema,
  [sessionStartedEvent.name]: sessionStartedEvent.schema,
  [sessionRestoredEvent.name]: sessionRestoredEvent.schema,
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
  [claudeHooksSessionStartedEvent.name]: claudeHooksSessionStartedEvent.schema,
  [sessionTranscriptDiscoveredEvent.name]: sessionTranscriptDiscoveredEvent.schema,
  [sessionProviderSessionIdDiscoveredEvent.name]: sessionProviderSessionIdDiscoveredEvent.schema,
  [sessionTranscriptUpdatedEvent.name]: sessionTranscriptUpdatedEvent.schema,
  [sessionTranscriptEndedEvent.name]: sessionTranscriptEndedEvent.schema,
  [teamConfigUpdatedEvent.name]: teamConfigUpdatedEvent.schema,
  [teamMemberAddedEvent.name]: teamMemberAddedEvent.schema,
  [teamMemberRemovedEvent.name]: teamMemberRemovedEvent.schema,
  [sessionActivityChangedEvent.name]: sessionActivityChangedEvent.schema,
  [sessionCloudConnectedEvent.name]: sessionCloudConnectedEvent.schema,
  [sessionCloudDisconnectedEvent.name]: sessionCloudDisconnectedEvent.schema,
  [sessionPresenceChangedEvent.name]: sessionPresenceChangedEvent.schema,
  [sessionRecommendationEvent.name]: sessionRecommendationEvent.schema,
  [scheduledEpicExecutedEvent.name]: scheduledEpicExecutedEvent.schema,
} as const;

export type EventName = keyof typeof eventCatalog;
export type EventSchema<TName extends EventName> = (typeof eventCatalog)[TName];
export type EventPayload<TName extends EventName> = z.infer<EventSchema<TName>>;
export const eventNames = Object.keys(eventCatalog) as EventName[];
