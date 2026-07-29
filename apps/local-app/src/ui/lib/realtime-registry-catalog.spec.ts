import { broadcastRegistry } from '../../modules/events/catalog/broadcast-registry';
import {
  nonRegistryBroadcastCatalog,
  type RegistryCatalogEntry,
} from './realtime-registry-catalog';

const VALID_KINDS = ['invalidate', 'no-op', 'custom-handler'];

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
  return topic(sample);
}

describe('broadcastRegistry clientReaction contract ↔ non-registry catalog', () => {
  // Derive expected registry coverage from broadcastRegistry itself via each entry's
  // `clientReaction` — there is no hand-copied mirror to drift from anymore. Iterate EVERY
  // item in each event's array so the review dual-topic fan-out (2 entries per review event,
  // see broadcast-registry.ts review.* entries) is preserved.
  const registryDerived: RegistryCatalogEntry[] = [];
  const dynamicEntries: { eventName: string; kind: string }[] = [];

  for (const [eventName, entries] of Object.entries(broadcastRegistry)) {
    for (const entry of entries) {
      if (typeof entry.type === 'function') {
        // Dynamic-type entry (e.g. `epic.broadcast`): the concrete `type` is only known at
        // runtime from the payload, so there is no concrete topic/type to key-match here —
        // this mirrors the original test's `*`-skip. We still enforce its clientReaction.kind
        // below so a dynamic entry can never silently ship without a declared client reaction.
        dynamicEntries.push({ eventName, kind: entry.clientReaction.kind });
        continue;
      }
      registryDerived.push({
        topicPattern: resolveTopicPattern(entry.topic),
        type: entry.type,
        kind: entry.clientReaction.kind,
        owner: entry.clientReaction.owner,
      });
    }
  }

  // The full concrete catalog the web client reacts to: registry-derived (static-type) entries
  // plus the direct/non-registry broadcasts. The valid-kind and no-duplicate guards below run
  // over this COMBINED set — they previously guarded the hand mirror and must not be lost.
  const combined: RegistryCatalogEntry[] = [...registryDerived, ...nonRegistryBroadcastCatalog];

  it('coverage counts are stable (29 keys / 34 items / 33 static + 1 dynamic / 44 combined)', () => {
    const keyCount = Object.keys(broadcastRegistry).length;
    const itemCount = Object.values(broadcastRegistry).reduce((n, arr) => n + arr.length, 0);

    expect(keyCount).toBe(29);
    expect(itemCount).toBe(34);
    expect(registryDerived.length).toBe(33);
    expect(dynamicEntries.length).toBe(1);
    expect(nonRegistryBroadcastCatalog.length).toBe(11);
    expect(combined.length).toBe(44);
  });

  it('every dynamic-type registry entry declares a valid clientReaction kind', () => {
    expect(dynamicEntries.length).toBeGreaterThan(0);
    for (const entry of dynamicEntries) {
      expect(VALID_KINDS).toContain(entry.kind);
    }
  });

  it('every combined catalog entry has a valid kind', () => {
    for (const entry of combined) {
      expect(VALID_KINDS).toContain(entry.kind);
    }
  });

  it('no duplicate catalog entries across the combined set', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const entry of combined) {
      const key = `${entry.topicPattern}::${entry.type}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates).toEqual([]);
  });
});
