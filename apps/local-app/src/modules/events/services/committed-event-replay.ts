import { eventCatalog, type EventName, type EventPayload } from '../catalog';
import {
  legacyIntegrationConnectionCreatedEventSchema,
  legacyIntegrationConnectionDeletedEventSchema,
  legacyIntegrationConnectionUpdatedEventSchema,
  type LegacyIntegrationConnectionCreatedEventPayload,
  type LegacyIntegrationConnectionDeletedEventPayload,
  type LegacyIntegrationConnectionUpdatedEventPayload,
} from '../catalog/integration.connection.legacy';

interface LegacyConnectionPayloadByEventName {
  'integration.connection.created': LegacyIntegrationConnectionCreatedEventPayload;
  'integration.connection.updated': LegacyIntegrationConnectionUpdatedEventPayload;
  'integration.connection.deleted': LegacyIntegrationConnectionDeletedEventPayload;
}

export type ReplayedEventPayload<TName extends EventName> =
  TName extends keyof LegacyConnectionPayloadByEventName
    ? EventPayload<TName> | LegacyConnectionPayloadByEventName[TName]
    : EventPayload<TName>;

export function parseCommittedEventPayloadForReplay<TName extends EventName>(
  name: TName,
  payload: unknown,
): ReplayedEventPayload<TName> {
  switch (name) {
    case 'integration.connection.created': {
      const current = eventCatalog[name].safeParse(payload);
      return (
        current.success
          ? current.data
          : legacyIntegrationConnectionCreatedEventSchema.parse(payload)
      ) as ReplayedEventPayload<TName>;
    }
    case 'integration.connection.updated': {
      const current = eventCatalog[name].safeParse(payload);
      return (
        current.success
          ? current.data
          : legacyIntegrationConnectionUpdatedEventSchema.parse(payload)
      ) as ReplayedEventPayload<TName>;
    }
    case 'integration.connection.deleted': {
      const current = eventCatalog[name].safeParse(payload);
      return (
        current.success
          ? current.data
          : legacyIntegrationConnectionDeletedEventSchema.parse(payload)
      ) as ReplayedEventPayload<TName>;
    }
    default:
      return payload as ReplayedEventPayload<TName>;
  }
}
