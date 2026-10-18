import { describe, it, expect } from 'vitest';
import {
  TUNNEL_PROTOCOL_VERSION_PUSH,
  SUPPORTED_TUNNEL_PROTOCOL_VERSIONS,
  TUNNEL_PUSH_FRAME_TYPE,
  TUNNEL_PUSH_FRAME_VERSION,
  isSupportedTunnelProtocolVersion,
  isPushCapableTunnelProtocolVersion,
  isTunnelPushFrame,
  type TunnelPushFrame,
} from './tunnel-protocol';

function validFrame(overrides: Partial<TunnelPushFrame> = {}): unknown {
  return {
    type: TUNNEL_PUSH_FRAME_TYPE,
    v: TUNNEL_PUSH_FRAME_VERSION,
    topic: 'session/abc/transcript',
    eventType: 'updated',
    payload: { newMessageCount: 1 },
    ...overrides,
  };
}

describe('tunnel-protocol constants', () => {
  it('exposes the push protocol version and supported set', () => {
    expect(TUNNEL_PROTOCOL_VERSION_PUSH).toBe('2');
    expect(SUPPORTED_TUNNEL_PROTOCOL_VERSIONS).toEqual(['1', '2']);
    expect(TUNNEL_PUSH_FRAME_TYPE).toBe('push');
    expect(TUNNEL_PUSH_FRAME_VERSION).toBe(2);
  });
});

describe('isSupportedTunnelProtocolVersion', () => {
  it('accepts both rollout versions', () => {
    expect(isSupportedTunnelProtocolVersion('1')).toBe(true);
    expect(isSupportedTunnelProtocolVersion('2')).toBe(true);
  });

  it('rejects unknown versions and non-strings', () => {
    expect(isSupportedTunnelProtocolVersion('3')).toBe(false);
    expect(isSupportedTunnelProtocolVersion(2)).toBe(false);
    expect(isSupportedTunnelProtocolVersion(undefined)).toBe(false);
  });
});

describe('isPushCapableTunnelProtocolVersion', () => {
  it('is true only for v2', () => {
    expect(isPushCapableTunnelProtocolVersion('2')).toBe(true);
    expect(isPushCapableTunnelProtocolVersion('1')).toBe(false);
  });
});

describe('isTunnelPushFrame', () => {
  it('accepts a well-formed envelope (no eventId required)', () => {
    expect(isTunnelPushFrame(validFrame())).toBe(true);
  });

  it('accepts a frame that already carries a bridge-assigned eventId', () => {
    expect(isTunnelPushFrame(validFrame({ eventId: '42' }))).toBe(true);
  });

  it('rejects JSON-RPC responses and other non-push frames', () => {
    expect(isTunnelPushFrame({ id: 'rpc-1', result: { ok: true } })).toBe(false);
    expect(isTunnelPushFrame({ type: 'ready', instanceId: 'i-1' })).toBe(false);
  });

  it('rejects a wrong schema version', () => {
    expect(isTunnelPushFrame(validFrame({ v: 1 as unknown as 2 }))).toBe(false);
  });

  it('rejects malformed / empty topic', () => {
    expect(isTunnelPushFrame(validFrame({ topic: '' }))).toBe(false);
    expect(isTunnelPushFrame(validFrame({ topic: undefined as unknown as string }))).toBe(false);
  });

  it('rejects missing eventType and missing payload', () => {
    const noEventType = validFrame();
    delete (noEventType as Record<string, unknown>).eventType;
    expect(isTunnelPushFrame(noEventType)).toBe(false);

    const noPayload = validFrame();
    delete (noPayload as Record<string, unknown>).payload;
    expect(isTunnelPushFrame(noPayload)).toBe(false);
  });

  it('rejects primitives and null safely', () => {
    expect(isTunnelPushFrame(null)).toBe(false);
    expect(isTunnelPushFrame('push')).toBe(false);
    expect(isTunnelPushFrame(42)).toBe(false);
  });
});

import {
  MOBILE_PUSH_TOPIC_ALLOWLIST,
  MOBILE_PUSH_TOPIC_ID_SEGMENT,
  isAllowlistedTunnelPushTopic,
} from './tunnel-protocol';

describe('mobile push topic allowlist', () => {
  it('accepts every canonical Phase-2 mobile-chat pair', () => {
    expect(isAllowlistedTunnelPushTopic('session/abc/transcript', 'updated')).toBe(true);
    expect(isAllowlistedTunnelPushTopic('session/abc', 'ask_user_question.pending')).toBe(true);
    expect(isAllowlistedTunnelPushTopic('session/abc', 'ask_user_question.resolved')).toBe(true);
    expect(isAllowlistedTunnelPushTopic('session/abc', 'activity')).toBe(true);
    expect(isAllowlistedTunnelPushTopic('agent/xyz', 'presence')).toBe(true);
    expect(isAllowlistedTunnelPushTopic('project/p1/state', 'agent.created')).toBe(true);
    expect(isAllowlistedTunnelPushTopic('project/p1/state', 'agent.deleted')).toBe(true);
  });

  it('rejects a syntactically-valid but unknown topic', () => {
    expect(isAllowlistedTunnelPushTopic('project/p1/epics', 'created')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('review/r1', 'comment.created')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('worktrees', 'changed')).toBe(false);
  });

  it('rejects a wrong eventType for a known topic shape', () => {
    expect(isAllowlistedTunnelPushTopic('session/abc/transcript', 'presence')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('session/abc', 'updated')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('agent/xyz', 'updated')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('project/p1/state', 'agent.updated')).toBe(false);
  });

  it('rejects an empty id segment or wrong arity', () => {
    expect(isAllowlistedTunnelPushTopic('session//transcript', 'updated')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('session', 'ask_user_question.pending')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('session/abc/transcript/extra', 'updated')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('agent', 'presence')).toBe(false);
  });

  it('rejects non-string inputs safely', () => {
    expect(isAllowlistedTunnelPushTopic(undefined, 'updated')).toBe(false);
    expect(isAllowlistedTunnelPushTopic('agent/xyz', 42)).toBe(false);
    expect(isAllowlistedTunnelPushTopic(null, null)).toBe(false);
  });

  it('defines the exact mobile push topic and event pairs', () => {
    expect(MOBILE_PUSH_TOPIC_ID_SEGMENT).toBe(':id');
    expect(MOBILE_PUSH_TOPIC_ALLOWLIST.length).toBe(4);
    const pairs = MOBILE_PUSH_TOPIC_ALLOWLIST.flatMap((rule) =>
      rule.eventTypes.map((eventType) => `${rule.segments.join('/')} [${eventType}]`),
    );
    expect(pairs.sort()).toEqual(
      [
        'session/:id/transcript [updated]',
        'session/:id [ask_user_question.pending]',
        'session/:id [ask_user_question.resolved]',
        'session/:id [activity]',
        'agent/:id [presence]',
        'project/:id/state [agent.created]',
        'project/:id/state [agent.deleted]',
      ].sort(),
    );
  });
});

import {
  TUNNEL_CONTROL_FRAME_TYPE,
  TUNNEL_CONTROL_FRAME_VERSION,
  isTunnelControlFrame,
  isTunnelLivenessQueryFrame,
  isTunnelLivenessResultFrame,
  isTunnelWorkspaceModeCommandFrame,
  isTunnelWorkspaceModeResultFrame,
} from './tunnel-protocol';

describe('tunnel control frame', () => {
  const query = {
    type: TUNNEL_CONTROL_FRAME_TYPE,
    v: TUNNEL_CONTROL_FRAME_VERSION,
    ctrl: 'sse_liveness_query',
    id: 'ctrl-1',
  };
  const result = {
    type: TUNNEL_CONTROL_FRAME_TYPE,
    v: TUNNEL_CONTROL_FRAME_VERSION,
    ctrl: 'sse_liveness_result',
    id: 'ctrl-1',
    live: true,
    lastSeenAt: 1000,
  };

  it('exposes the control frame constants', () => {
    expect(TUNNEL_CONTROL_FRAME_TYPE).toBe('ctrl');
    expect(TUNNEL_CONTROL_FRAME_VERSION).toBe(1);
  });

  it('accepts well-formed query and result frames', () => {
    expect(isTunnelControlFrame(query)).toBe(true);
    expect(isTunnelControlFrame(result)).toBe(true);
    expect(isTunnelLivenessQueryFrame(query)).toBe(true);
    expect(isTunnelLivenessResultFrame(result)).toBe(true);
  });

  it('keeps query and result discriminated', () => {
    expect(isTunnelLivenessResultFrame(query)).toBe(false);
    expect(isTunnelLivenessQueryFrame(result)).toBe(false);
  });

  it('rejects wrong type, version, ctrl, or missing/empty id', () => {
    expect(isTunnelControlFrame({ ...query, type: 'push' })).toBe(false);
    expect(isTunnelControlFrame({ ...query, v: 2 })).toBe(false);
    expect(isTunnelControlFrame({ ...query, ctrl: 'bogus' })).toBe(false);
    expect(isTunnelControlFrame({ ...query, id: '' })).toBe(false);
    expect(isTunnelControlFrame({ ...query, id: undefined })).toBe(false);
  });

  it('rejects a result frame without a boolean live flag', () => {
    expect(isTunnelLivenessResultFrame({ ...result, live: 'yes' })).toBe(false);
  });

  it('rejects primitives and null safely', () => {
    expect(isTunnelControlFrame(null)).toBe(false);
    expect(isTunnelControlFrame('ctrl')).toBe(false);
    expect(isTunnelControlFrame(7)).toBe(false);
  });

  it('accepts workspace-mode commands and acknowledgements as distinct control frames', () => {
    const command = {
      type: TUNNEL_CONTROL_FRAME_TYPE,
      v: TUNNEL_CONTROL_FRAME_VERSION,
      ctrl: 'workspace_mode_command',
      id: 'workspace-1',
      operation: 'prepare',
      multiWorkspaceMode: true,
    };
    const acknowledgement = {
      type: TUNNEL_CONTROL_FRAME_TYPE,
      v: TUNNEL_CONTROL_FRAME_VERSION,
      ctrl: 'workspace_mode_result',
      id: 'workspace-1',
      operation: 'prepare',
      ok: true,
    };

    expect(isTunnelControlFrame(command)).toBe(true);
    expect(isTunnelWorkspaceModeCommandFrame(command)).toBe(true);
    expect(isTunnelWorkspaceModeResultFrame(command)).toBe(false);
    expect(isTunnelControlFrame(acknowledgement)).toBe(true);
    expect(isTunnelWorkspaceModeResultFrame(acknowledgement)).toBe(true);
  });

  it('rejects malformed workspace-mode controls', () => {
    const command = {
      type: TUNNEL_CONTROL_FRAME_TYPE,
      v: TUNNEL_CONTROL_FRAME_VERSION,
      ctrl: 'workspace_mode_command',
      id: 'workspace-1',
      operation: 'commit',
      multiWorkspaceMode: false,
    };
    expect(isTunnelWorkspaceModeCommandFrame({ ...command, operation: 'start' })).toBe(false);
    expect(isTunnelWorkspaceModeCommandFrame({ ...command, multiWorkspaceMode: 'false' })).toBe(
      false,
    );
    expect(
      isTunnelWorkspaceModeResultFrame({
        ...command,
        ctrl: 'workspace_mode_result',
        ok: 'yes',
      }),
    ).toBe(false);
  });
});

import {
  TUNNEL_VIEWPORT_FRAME_TYPE,
  TUNNEL_VIEWPORT_FRAME_VERSION,
  MOBILE_VIEWPORT_SSE_EVENT,
  MOBILE_VIEWPORT_SSE_PATH_TEMPLATE,
  mobileViewportSsePath,
  isTunnelViewportFrame,
  isViewportBody,
  isViewportCursor,
  isMobileViewportSseEvent,
  type TunnelViewportFrame,
  type ViewportBody,
} from './tunnel-protocol';

const fullBody: ViewportBody = {
  kind: 'full',
  screen: {
    lines: ['[31mhello[0m', 'world'],
    cursor: { x: 5, y: 1 },
    cols: 80,
    rows: 24,
  },
};

const diffBody: ViewportBody = {
  kind: 'diff',
  changedLines: [{ row: 1, text: '[32mworld![0m' }],
};

function validViewportFrame(overrides: Partial<TunnelViewportFrame> = {}): unknown {
  return {
    type: TUNNEL_VIEWPORT_FRAME_TYPE,
    v: TUNNEL_VIEWPORT_FRAME_VERSION,
    subscriptionId: 'sub-1',
    sessionId: 'sess-1',
    seq: 0,
    body: fullBody,
    ...overrides,
  };
}

describe('tunnel viewport frame', () => {
  it('exposes the viewport frame constants and is a distinct lane from push/ctrl', () => {
    expect(TUNNEL_VIEWPORT_FRAME_TYPE).toBe('viewport');
    expect(TUNNEL_VIEWPORT_FRAME_VERSION).toBe(1);
    expect(TUNNEL_VIEWPORT_FRAME_TYPE).not.toBe(TUNNEL_PUSH_FRAME_TYPE);
  });

  it('accepts a well-formed full-screen frame', () => {
    expect(isTunnelViewportFrame(validViewportFrame())).toBe(true);
  });

  it('accepts a well-formed diff frame (optional cursor/cols/rows absent)', () => {
    expect(isTunnelViewportFrame(validViewportFrame({ seq: 7, body: diffBody }))).toBe(true);
  });

  it('accepts a diff frame carrying optional cursor/cols/rows', () => {
    const body: ViewportBody = {
      kind: 'diff',
      changedLines: [{ row: 0, text: 'x' }],
      cursor: { x: 1, y: 0 },
      cols: 80,
      rows: 24,
    };
    expect(isTunnelViewportFrame(validViewportFrame({ body }))).toBe(true);
  });

  it('rejects wrong type or schema version', () => {
    expect(isTunnelViewportFrame(validViewportFrame({ type: 'push' as never }))).toBe(false);
    expect(isTunnelViewportFrame(validViewportFrame({ v: 2 as never }))).toBe(false);
  });

  it('rejects missing/empty subscriptionId or sessionId', () => {
    expect(isTunnelViewportFrame(validViewportFrame({ subscriptionId: '' }))).toBe(false);
    expect(isTunnelViewportFrame(validViewportFrame({ sessionId: '' }))).toBe(false);
  });

  it('rejects a non-monotonic-shaped seq (negative, fractional, non-number)', () => {
    expect(isTunnelViewportFrame(validViewportFrame({ seq: -1 }))).toBe(false);
    expect(isTunnelViewportFrame(validViewportFrame({ seq: 1.5 }))).toBe(false);
    expect(isTunnelViewportFrame(validViewportFrame({ seq: '0' as never }))).toBe(false);
  });

  it('rejects a malformed body', () => {
    expect(isTunnelViewportFrame(validViewportFrame({ body: { kind: 'bogus' } as never }))).toBe(
      false,
    );
    expect(isTunnelViewportFrame(validViewportFrame({ body: undefined as never }))).toBe(false);
  });

  it('rejects primitives and null safely', () => {
    expect(isTunnelViewportFrame(null)).toBe(false);
    expect(isTunnelViewportFrame('viewport')).toBe(false);
    expect(isTunnelViewportFrame(42)).toBe(false);
  });

  it('is NOT a push topic (separate lane — never on the firehose allowlist)', () => {
    expect(isAllowlistedTunnelPushTopic('viewport', 'full')).toBe(false);
    expect(isAllowlistedTunnelPushTopic(TUNNEL_VIEWPORT_FRAME_TYPE, 'diff')).toBe(false);
  });
});

describe('isViewportBody', () => {
  it('accepts full and diff bodies', () => {
    expect(isViewportBody(fullBody)).toBe(true);
    expect(isViewportBody(diffBody)).toBe(true);
  });

  it('rejects a full body with a non-string line or missing geometry', () => {
    expect(
      isViewportBody({
        kind: 'full',
        screen: { lines: [1], cursor: { x: 0, y: 0 }, cols: 80, rows: 24 },
      }),
    ).toBe(false);
    expect(
      isViewportBody({ kind: 'full', screen: { lines: [], cursor: { x: 0, y: 0 }, rows: 24 } }),
    ).toBe(false);
  });

  it('rejects a diff body with malformed changedLines', () => {
    expect(isViewportBody({ kind: 'diff', changedLines: [{ row: '0', text: 'x' }] })).toBe(false);
    expect(isViewportBody({ kind: 'diff', changedLines: [{ row: 0 }] })).toBe(false);
    expect(isViewportBody({ kind: 'diff' })).toBe(false);
  });

  it('rejects unknown kinds, primitives, and null', () => {
    expect(isViewportBody({ kind: 'full-screen' })).toBe(false);
    expect(isViewportBody(null)).toBe(false);
    expect(isViewportBody('full')).toBe(false);
  });

  it('accepts an enc-full body carrying a well-formed E2eeEnvelope (shape only)', () => {
    expect(
      isViewportBody({
        kind: 'enc-full',
        enc: { v: 1, kid: 'pc-kid', alg: 'XC20P', nonce: 'bm9uY2U=', ct: 'Y2lwaGVy' },
      }),
    ).toBe(true);
  });

  it('rejects an enc-full body whose envelope is malformed or missing', () => {
    // Missing ct.
    expect(
      isViewportBody({ kind: 'enc-full', enc: { v: 1, kid: 'k', alg: 'XC20P', nonce: 'n' } }),
    ).toBe(false);
    // Empty kid.
    expect(
      isViewportBody({
        kind: 'enc-full',
        enc: { v: 1, kid: '', alg: 'XC20P', nonce: 'n', ct: 'c' },
      }),
    ).toBe(false);
    // No envelope at all.
    expect(isViewportBody({ kind: 'enc-full' })).toBe(false);
  });
});

describe('isViewportCursor', () => {
  it('accepts numeric x/y and rejects everything else', () => {
    expect(isViewportCursor({ x: 0, y: 0 })).toBe(true);
    expect(isViewportCursor({ x: 0 })).toBe(false);
    expect(isViewportCursor({ x: '0', y: 0 })).toBe(false);
    expect(isViewportCursor(null)).toBe(false);
  });
});

describe('mobile viewport SSE contract', () => {
  it('exposes the SSE event name and route template', () => {
    expect(MOBILE_VIEWPORT_SSE_EVENT).toBe('viewport');
    expect(MOBILE_VIEWPORT_SSE_PATH_TEMPLATE).toBe(
      '/v1/instances/:instanceId/sessions/:sessionId/viewport',
    );
  });

  it('builds a session-scoped path with URL-encoded segments', () => {
    expect(mobileViewportSsePath('i-1', 's-1')).toBe('/v1/instances/i-1/sessions/s-1/viewport');
    expect(mobileViewportSsePath('a/b', 'c d')).toBe('/v1/instances/a%2Fb/sessions/c%20d/viewport');
  });

  it('accepts a well-formed SSE event (full and diff)', () => {
    expect(
      isMobileViewportSseEvent({
        subscriptionId: 'sub-1',
        sessionId: 's-1',
        seq: 0,
        body: fullBody,
      }),
    ).toBe(true);
    expect(
      isMobileViewportSseEvent({
        subscriptionId: 'sub-1',
        sessionId: 's-1',
        seq: 3,
        body: diffBody,
      }),
    ).toBe(true);
  });

  it('rejects malformed SSE events', () => {
    expect(
      isMobileViewportSseEvent({ subscriptionId: 'sub-1', sessionId: '', seq: 0, body: fullBody }),
    ).toBe(false);
    expect(isMobileViewportSseEvent({ sessionId: 's-1', seq: 0, body: fullBody })).toBe(false);
    expect(
      isMobileViewportSseEvent({ subscriptionId: '', sessionId: 's-1', seq: 0, body: fullBody }),
    ).toBe(false);
    expect(
      isMobileViewportSseEvent({
        subscriptionId: 'sub-1',
        sessionId: 's-1',
        seq: -1,
        body: fullBody,
      }),
    ).toBe(false);
    expect(
      isMobileViewportSseEvent({
        subscriptionId: 'sub-1',
        sessionId: 's-1',
        seq: 0,
        body: { kind: 'bogus' },
      }),
    ).toBe(false);
    expect(isMobileViewportSseEvent(null)).toBe(false);
  });
});
