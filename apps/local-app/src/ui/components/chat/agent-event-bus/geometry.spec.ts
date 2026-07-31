import {
  createRoundedOrthogonalPath,
  createRoundedSystemIngressPath,
  DEFAULT_BUS_X,
  EVENT_BUS_GUTTER_RIGHT,
  EVENT_BUS_ROUTE_DURATION_MS,
  roundSvgCoordinate,
  selectAgentEventBusRoute,
  selectRuntimeEventBusRoute,
} from './geometry';
import type { AgentEventBusAnchor, AgentEventBusGeometrySnapshot } from './types';

// Layer: pure unit. Direct deterministic geometry inputs are the cheapest
// reliable proof of path math, duration bounds, and duplicate-anchor selection;
// no DOM rendering is needed for these calculations.
function anchor(
  key: string,
  agentId: string,
  y: number,
  order: number,
  teamId?: string,
): AgentEventBusAnchor {
  return { key, agentId, x: 48, y, order, ...(teamId ? { teamId } : {}) };
}

function snapshot(anchors: AgentEventBusAnchor[]): AgentEventBusGeometrySnapshot {
  return {
    scopeEpoch: 1,
    geometryEpoch: 1,
    width: 320,
    height: 480,
    busX: 8,
    runtimeOrigin: { kind: 'runtime', x: 8, y: 8 },
    anchors,
  };
}

describe('agent event-bus geometry', () => {
  it('pins the shared conductor and filtered-gutter boundaries', () => {
    expect(DEFAULT_BUS_X).toBe(4);
    expect(EVENT_BUS_GUTTER_RIGHT).toBe(16);
  });

  it('rounds inputs once and uses those exact values for path text and analytical length', () => {
    const path = createRoundedOrthogonalPath(
      { ...anchor('source', 'sender', 10.004, 0), x: 50.004 },
      { ...anchor('recipient', 'recipient', 100.006, 1), x: 52.006 },
      10.004,
      12.006,
    );

    expect(path.d).toBe('M 50 10 H 22.01 Q 10 10 10 22.01 V 88 Q 10 100.01 22.01 100.01 H 52.01');
    expect(path.radius).toBe(12.01);
    expect(path.length).toBe(roundSvgCoordinate(40 + 42.01 + 90.01 - 4 * 12.01 + Math.PI * 12.01));
    expect(path.durationMs).toBe(EVENT_BUS_ROUTE_DURATION_MS);
  });

  it('gives every route the same duration regardless of length', () => {
    const shortRoute = createRoundedOrthogonalPath(
      anchor('source', 'source', 20, 0),
      anchor('recipient', 'recipient', 60, 1),
      10,
    );
    const longRoute = createRoundedOrthogonalPath(
      anchor('source', 'source', 20, 0),
      anchor('recipient', 'recipient', 900, 1),
      10,
    );

    expect(longRoute.length).toBeGreaterThan(shortRoute.length * 5);
    expect(shortRoute.durationMs).toBe(EVENT_BUS_ROUTE_DURATION_MS);
    expect(longRoute.durationMs).toBe(EVENT_BUS_ROUTE_DURATION_MS);
  });

  it('builds one rounded runtime ingress turn from the same rounded analytical inputs', () => {
    const path = createRoundedSystemIngressPath(
      { ...anchor('recipient', 'recipient', 100.006, 1), x: 52.006 },
      8.004,
      8.006,
      12.006,
    );

    expect(path.d).toBe('M 8 8.01 V 88 Q 8 100.01 20.01 100.01 H 52.01');
    expect(path.radius).toBe(12.01);
    expect(path.source).toEqual({ kind: 'runtime', x: 8, y: 8.01 });
    expect(path.length).toBe(roundSvgCoordinate(92 + 44.01 - 2 * 12.01 + (Math.PI * 12.01) / 2));
    expect(path.durationMs).toBe(EVENT_BUS_ROUTE_DURATION_MS);
  });

  it('selects duplicate sender and recipient copies jointly by vertical distance then DOM order', () => {
    const geometry = snapshot([
      anchor('sender-top', 'sender', 20, 0),
      anchor('recipient-top', 'recipient', 80, 1),
      anchor('sender-bottom', 'sender', 160, 2),
      anchor('recipient-bottom', 'recipient', 100, 3),
    ]);

    const selected = selectAgentEventBusRoute(geometry, 'sender', 'recipient');

    expect(selected?.source.key).toBe('sender-top');
    expect(selected?.recipient.key).toBe('recipient-top');
  });

  it('prefers target-team copies independently at both endpoints', () => {
    const geometry = snapshot([
      anchor('sender-a', 'sender', 95, 0, 'team-a'),
      anchor('sender-b', 'sender', 20, 1, 'team-b'),
      anchor('recipient-a', 'recipient', 100, 2, 'team-a'),
      anchor('recipient-b', 'recipient', 70, 3, 'team-b'),
    ]);

    const selected = selectAgentEventBusRoute(geometry, 'sender', 'recipient', 'team-b');

    expect(selected?.source.key).toBe('sender-b');
    expect(selected?.recipient.key).toBe('recipient-b');
  });

  it('falls back to all sender copies for a cross-team send with no target-team sender', () => {
    const geometry = snapshot([
      anchor('sender-a-top', 'sender', 20, 0, 'team-a'),
      anchor('sender-a-bottom', 'sender', 92, 1, 'team-a'),
      anchor('recipient-b', 'recipient', 100, 2, 'team-b'),
      anchor('recipient-a', 'recipient', 22, 3, 'team-a'),
    ]);

    const selected = selectAgentEventBusRoute(geometry, 'sender', 'recipient', 'team-b');

    expect(selected?.source.key).toBe('sender-a-bottom');
    expect(selected?.recipient.key).toBe('recipient-b');
  });

  it('returns no route when either mounted endpoint is absent', () => {
    const geometry = snapshot([anchor('sender', 'sender', 20, 0)]);

    expect(selectAgentEventBusRoute(geometry, 'sender', 'recipient')).toBeNull();
    expect(selectAgentEventBusRoute(geometry, 'missing', 'sender')).toBeNull();
  });

  it('selects the shortest mounted runtime target copy with DOM-order tie-break', () => {
    const geometry = snapshot([
      { ...anchor('far', 'recipient', 160, 0), x: 48 },
      { ...anchor('near-later', 'recipient', 80, 2), x: 48 },
      { ...anchor('near-earlier', 'recipient', 80, 1), x: 48 },
    ]);

    const selected = selectRuntimeEventBusRoute(geometry, 'recipient');

    expect(selected?.recipient.key).toBe('near-earlier');
    expect(selected?.path.source).toEqual(geometry.runtimeOrigin);
    expect(selectRuntimeEventBusRoute(geometry, 'missing')).toBeNull();
  });
});
