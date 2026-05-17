import { broadcastRegistry } from '../../modules/events/catalog/broadcast-registry';
import type { BroadcastTopicEntry } from '../../modules/events/catalog/broadcast-metadata';
import { realtimeRegistryCatalog } from './realtime-registry-catalog';

function resolveTopicPattern(topic: string | ((p: Record<string, unknown>) => string)): string {
  if (typeof topic === 'string') return topic;
  const sample = {
    sessionId: '{id}',
    threadId: '{id}',
    projectId: '{id}',
    reviewId: '{id}',
    worktreeId: '{id}',
    agentId: '{id}',
  };
  const resolved = topic(sample);
  return resolved;
}

function resolveType(type: string | ((p: Record<string, unknown>) => string)): string {
  if (typeof type === 'string') return type;
  return '*';
}

describe('RealtimeRegistryCatalog ↔ broadcastRegistry alignment', () => {
  const catalogKeys = new Set(realtimeRegistryCatalog.map((e) => `${e.topicPattern}::${e.type}`));

  it('every broadcastRegistry entry has a matching catalog entry', () => {
    const missing: string[] = [];

    for (const [eventName, entries] of Object.entries(broadcastRegistry)) {
      for (const entry of entries as BroadcastTopicEntry<Record<string, unknown>>[]) {
        const topicPattern = resolveTopicPattern(entry.topic);
        const type = resolveType(entry.type);

        if (type === '*') continue;

        const key = `${topicPattern}::${type}`;
        if (!catalogKeys.has(key)) {
          missing.push(`${eventName} → ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('every catalog entry has a valid kind', () => {
    for (const entry of realtimeRegistryCatalog) {
      expect(['invalidate', 'no-op', 'custom-handler']).toContain(entry.kind);
    }
  });

  it('no duplicate catalog entries', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const entry of realtimeRegistryCatalog) {
      const key = `${entry.topicPattern}::${entry.type}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates).toEqual([]);
  });
});
