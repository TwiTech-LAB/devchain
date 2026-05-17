import { Injectable } from '@nestjs/common';
import type { EpicCreatedEventPayload } from '../../events/catalog/epic.created';
import type { EpicDeletedEventPayload } from '../../events/catalog/epic.deleted';
import type { EpicUpdatedEventPayload } from '../../events/catalog/epic.updated';
import type { EpicCommentCreatedEventPayload } from '../../events/catalog/epic.comment.created';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';

export interface IngestPayload {
  source: 'workflow';
  sourceEventId: string;
  sourceEventType: string;
  forwardingUserId: string;
  recipientMode: 'self';
  recipientHints: never[];
  occurredAt: string;
  payload: Record<string, unknown>;
  projectId: string | null;
  orgId: null;
}

type AllowlistedEvent =
  | { name: 'epic.created'; payload: EpicCreatedEventPayload }
  | { name: 'epic.updated'; payload: EpicUpdatedEventPayload }
  | { name: 'epic.deleted'; payload: EpicDeletedEventPayload }
  | { name: 'epic.comment.created'; payload: EpicCommentCreatedEventPayload }
  | { name: 'session.crashed'; payload: SessionCrashedEventPayload }
  | { name: 'session.stopped'; payload: SessionStoppedEventPayload };

@Injectable()
export class EventMapperService {
  mapToIngestPayload(
    event: AllowlistedEvent,
    sourceEventId: string,
    forwardingUserId: string,
  ): IngestPayload {
    const projectId = this.extractProjectId(event);

    return {
      source: 'workflow',
      sourceEventId,
      sourceEventType: event.name,
      forwardingUserId,
      recipientMode: 'self',
      recipientHints: [],
      occurredAt: new Date().toISOString(),
      payload: event.payload as unknown as Record<string, unknown>,
      projectId,
      orgId: null,
    };
  }

  private extractProjectId(event: AllowlistedEvent): string | null {
    switch (event.name) {
      case 'epic.created':
      case 'epic.updated':
      case 'epic.deleted':
      case 'epic.comment.created':
        return event.payload.projectId;
      case 'session.crashed':
      case 'session.stopped':
        return null;
    }
  }
}
