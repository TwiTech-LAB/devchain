import { isAllowlistedTunnelPushTopic } from '@devchain/shared';
import { broadcastRegistry } from './broadcast-registry';
import type { BroadcastTopicEntry } from './broadcast-metadata';

// Layer: pure unit (static registry contract). Exercising the real registry
// entries against the shared predicate is the cheapest reliable proof of
// web/mobile allowlist boundaries; no broadcaster or tunnel process is needed.
// Guards that the bridge receiver's push-topic allowlist (the canonical
// MOBILE_PUSH_TOPIC_ALLOWLIST in @devchain/shared) stays in sync with the
// broadcast-registry — the producer / source of truth. The bridge cannot
// runtime-import the ESM-only shared package, so it mirrors the predicate; this
// test drives the REAL registry entries through the REAL shared allowlist so any
// drift in the registry's mobile-chat topic shapes turns this red.

const SAMPLE = {
  sessionId: 'sess-1',
  agentId: 'agent-1',
  toolUseId: 'tool-1',
  projectId: 'proj-1',
  threadId: 'thread-1',
  reviewId: 'rev-1',
};

function resolve(entry: BroadcastTopicEntry): { topic: string; eventType: string } {
  const topic = typeof entry.topic === 'function' ? entry.topic(SAMPLE) : entry.topic;
  const eventType = typeof entry.type === 'function' ? entry.type(SAMPLE) : entry.type;
  return { topic, eventType };
}

describe('broadcast-registry ↔ shared push allowlist sync', () => {
  // The mobile-chat firehose subset (source event → must be allowlisted).
  // Phase 1 / Task 3 additions: agent.lifecycle + chat.message.created.
  const MOBILE_SOURCE_EVENTS = [
    'session.transcript.updated',
    'claude.hooks.ask_user_question.pending',
    'claude.hooks.ask_user_question.resolved',
    'session.presence.changed',
    'session.activity.changed',
    'agent.created',
    'agent.deleted',
    'chat.message.created',
  ];

  it.each(MOBILE_SOURCE_EVENTS)(
    'allowlists every topic the registry produces for %s',
    (eventName) => {
      const entries = broadcastRegistry[eventName];
      expect(entries?.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const { topic, eventType } = resolve(entry);
        expect(isAllowlistedTunnelPushTopic(topic, eventType)).toBe(true);
      }
    },
  );

  it('does NOT allowlist non-mobile registry topics (allowlist stays narrow)', () => {
    const nonMobile = Object.keys(broadcastRegistry).filter(
      (k) => !MOBILE_SOURCE_EVENTS.includes(k),
    );
    expect(nonMobile.length).toBeGreaterThan(0);
    for (const eventName of nonMobile) {
      for (const entry of broadcastRegistry[eventName]) {
        const { topic, eventType } = resolve(entry);
        expect(isAllowlistedTunnelPushTopic(topic, eventType)).toBe(false);
      }
    }
  });

  it('does NOT allowlist the web-only session.starting visualization frame', () => {
    const entry = broadcastRegistry['session.starting'][0];
    const { topic, eventType } = resolve(entry);

    expect(topic).toBe('project/proj-1/agent-messages');
    expect(eventType).toBe('session.starting');
    expect(isAllowlistedTunnelPushTopic(topic, eventType)).toBe(false);
  });
});
