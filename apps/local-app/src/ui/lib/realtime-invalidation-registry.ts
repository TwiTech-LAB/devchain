import type { QueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from './socket';

export type RealtimeInvalidationEntry =
  | {
      kind: 'invalidate';
      queryKey: string[] | ((payload: Record<string, unknown>) => string[]);
    }
  | {
      kind: 'no-op';
      rationale: string;
    }
  | {
      kind: 'custom-handler';
      handler: (payload: Record<string, unknown>, queryClient: QueryClient) => void;
    };

export interface TopicMatcher {
  match: (topic: string) => boolean;
  type: string;
  entries: RealtimeInvalidationEntry[];
}

export type RealtimeInvalidationRegistry = TopicMatcher[];

export function dispatchRealtimeEnvelope(
  envelope: WsEnvelope,
  registry: RealtimeInvalidationRegistry,
  queryClient: QueryClient,
): void {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;

  for (const matcher of registry) {
    if (!matcher.match(envelope.topic) || matcher.type !== envelope.type) continue;

    for (const entry of matcher.entries) {
      switch (entry.kind) {
        case 'invalidate': {
          const keys =
            typeof entry.queryKey === 'function' ? entry.queryKey(payload) : entry.queryKey;
          queryClient.invalidateQueries({ queryKey: keys });
          break;
        }
        case 'custom-handler':
          entry.handler(payload, queryClient);
          break;
        case 'no-op':
          break;
      }
    }
  }
}

export function exactTopic(topic: string): (t: string) => boolean {
  return (t) => t === topic;
}

export function prefixTopic(prefix: string): (t: string) => boolean {
  return (t) => t.startsWith(prefix);
}

export function patternTopic(pattern: RegExp): (t: string) => boolean {
  return (t) => pattern.test(t);
}
