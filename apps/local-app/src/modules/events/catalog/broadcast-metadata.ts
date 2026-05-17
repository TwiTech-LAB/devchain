export interface BroadcastTopicEntry<T = unknown> {
  topic: string | ((payload: T) => string);
  type: string | ((payload: T) => string);
  payloadProjection?: (payload: T) => unknown;
}

export interface BroadcastRegistryEntry {
  broadcastTopics: BroadcastTopicEntry[];
}
