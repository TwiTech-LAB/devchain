/**
 * Phase 2 fixtures sanity test. Asserts each fixture validates against the
 * structural guards in `tunnel-protocol.ts` (so a shape regression is caught
 * here, not in some downstream package's pipeline test). Layer: unit.
 */
import { describe, it, expect } from 'vitest';
import {
  isTunnelPushFrame,
  isAllowlistedTunnelPushTopic,
  type TunnelPushEnvelope,
  type TunnelPushFrame,
} from '../tunnel-protocol.js';
import {
  TRANSCRIPT_UPDATED_ENVELOPE,
  AUQ_PENDING_ENVELOPE,
  AUQ_RESOLVED_ENVELOPE,
  PRESENCE_CHANGED_ENVELOPE,
  ACTIVITY_CHANGED_ENVELOPE,
  UNKNOWN_TOPIC_ENVELOPE,
  WRONG_EVENT_TYPE_ENVELOPE,
  SMUGGLED_EVENT_ID_FRAME,
  ALLOWLISTED_TOPIC_PAIRS,
} from './phase2-frames.js';

describe('Phase 2 fixtures', () => {
  it('the five allowlisted envelopes pass structural validation', () => {
    for (const envelope of [
      TRANSCRIPT_UPDATED_ENVELOPE,
      AUQ_PENDING_ENVELOPE,
      AUQ_RESOLVED_ENVELOPE,
      PRESENCE_CHANGED_ENVELOPE,
      ACTIVITY_CHANGED_ENVELOPE,
    ] as const) {
      // Envelopes omit `eventId`; structural validation accepts that.
      expect(isTunnelPushFrame(envelope)).toBe(true);
    }
  });

  it('envelopes are JSON-serializable (wire-safe; no functions/symbols)', () => {
    for (const envelope of [
      TRANSCRIPT_UPDATED_ENVELOPE,
      AUQ_PENDING_ENVELOPE,
      AUQ_RESOLVED_ENVELOPE,
      PRESENCE_CHANGED_ENVELOPE,
      UNKNOWN_TOPIC_ENVELOPE,
      WRONG_EVENT_TYPE_ENVELOPE,
    ] as const) {
      const round = JSON.parse(JSON.stringify(envelope)) as TunnelPushEnvelope;
      expect(round.type).toBe(envelope.type);
      expect(round.v).toBe(envelope.v);
    }
  });

  it('the allowlisted envelopes are accepted by isAllowlistedTunnelPushTopic', () => {
    expect(
      isAllowlistedTunnelPushTopic(
        TRANSCRIPT_UPDATED_ENVELOPE.topic,
        TRANSCRIPT_UPDATED_ENVELOPE.eventType,
      ),
    ).toBe(true);
    expect(
      isAllowlistedTunnelPushTopic(AUQ_PENDING_ENVELOPE.topic, AUQ_PENDING_ENVELOPE.eventType),
    ).toBe(true);
    expect(
      isAllowlistedTunnelPushTopic(AUQ_RESOLVED_ENVELOPE.topic, AUQ_RESOLVED_ENVELOPE.eventType),
    ).toBe(true);
    expect(
      isAllowlistedTunnelPushTopic(
        PRESENCE_CHANGED_ENVELOPE.topic,
        PRESENCE_CHANGED_ENVELOPE.eventType,
      ),
    ).toBe(true);
    expect(
      isAllowlistedTunnelPushTopic(
        ACTIVITY_CHANGED_ENVELOPE.topic,
        ACTIVITY_CHANGED_ENVELOPE.eventType,
      ),
    ).toBe(true);
  });

  it('ALLOWLISTED_TOPIC_PAIRS all pass the allowlist guard', () => {
    for (const [topic, eventType] of ALLOWLISTED_TOPIC_PAIRS) {
      expect(isAllowlistedTunnelPushTopic(topic, eventType)).toBe(true);
    }
  });

  it('the unknown-topic envelope is structurally valid but NOT allowlisted (reject-before-dispatch territory)', () => {
    expect(isTunnelPushFrame(UNKNOWN_TOPIC_ENVELOPE)).toBe(true);
    expect(
      isAllowlistedTunnelPushTopic(UNKNOWN_TOPIC_ENVELOPE.topic, UNKNOWN_TOPIC_ENVELOPE.eventType),
    ).toBe(false);
  });

  it('the wrong-eventType envelope is structurally valid but NOT allowlisted (reject-before-dispatch territory)', () => {
    expect(isTunnelPushFrame(WRONG_EVENT_TYPE_ENVELOPE)).toBe(true);
    expect(
      isAllowlistedTunnelPushTopic(
        WRONG_EVENT_TYPE_ENVELOPE.topic,
        WRONG_EVENT_TYPE_ENVELOPE.eventType,
      ),
    ).toBe(false);
  });

  it('the smuggled-eventId frame is structurally valid (carries an eventId the bridge must strip)', () => {
    const frame = SMUGGLED_EVENT_ID_FRAME as TunnelPushFrame;
    expect(isTunnelPushFrame(frame)).toBe(true);
    expect(frame.eventId).toBe('client-smuggled-999'); // present on input
    // Allowlist accepts the (topic, eventType) regardless of eventId.
    expect(isAllowlistedTunnelPushTopic(frame.topic, frame.eventType)).toBe(true);
  });
});
