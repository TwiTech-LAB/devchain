import type { Socket } from 'socket.io-client';
import { EVENT_BUS_ROUTE_DURATION_MS } from './geometry';
import {
  AgentEventBusScheduler,
  EVENT_BUS_MAX_ACTIVE_ROUTES,
  EVENT_BUS_MAX_TOTAL_ROUTES,
  type AgentEventBusSchedulerEnvironment,
} from './scheduler';
import type {
  AgentEventBusActiveRoute,
  AgentEventBusAnchor,
  AgentEventBusGeometrySnapshot,
} from './types';
import type { AgentMessageEventFrame } from './useAgentEventBusStream';

// Layer: pure unit. The scheduler's injected timer environment and geometry
// snapshots are the cheapest reliable proof of capacity, epochs, routing, and
// phase transitions without nondeterministic browser animation timing.
type TimerHandle = ReturnType<typeof setTimeout>;

interface CapturedTimer {
  callback: () => void;
  cleared: boolean;
  delayMs: number;
}

function createTimerEnvironment() {
  let nextHandle = 1;
  const timers = new Map<number, CapturedTimer>();
  const environment: AgentEventBusSchedulerEnvironment = {
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, cleared: false, delayMs });
      return handle as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      const timer = timers.get(handle as unknown as number);
      if (timer) timer.cleared = true;
    },
  };
  return {
    environment,
    runBefore(maximumDelayMs: number) {
      for (const timer of timers.values()) {
        if (!timer.cleared && timer.delayMs < maximumDelayMs) {
          timer.cleared = true;
          timer.callback();
        }
      }
    },
    runDelay(delayMs: number) {
      const matchingTimers = [...timers.values()].filter(
        (timer) => !timer.cleared && timer.delayMs === delayMs,
      );
      for (const timer of matchingTimers) {
        timer.cleared = true;
        timer.callback();
      }
    },
    callbacksForDelay(delayMs: number) {
      return [...timers.values()]
        .filter((timer) => timer.delayMs === delayMs)
        .map((timer) => timer.callback);
    },
    forceCallbacks(callbacks: Array<() => void>) {
      for (const callback of callbacks) callback();
    },
    forceAllCallbacks() {
      for (const timer of timers.values()) timer.callback();
    },
  };
}

function anchor(
  key: string,
  agentId: string,
  y: number,
  order: number,
  teamId?: string,
): AgentEventBusAnchor {
  return { key, agentId, x: 48, y, order, ...(teamId ? { teamId } : {}) };
}

function geometry(
  scopeEpoch: number,
  geometryEpoch: number,
  anchors: AgentEventBusAnchor[],
): AgentEventBusGeometrySnapshot {
  return {
    scopeEpoch,
    geometryEpoch,
    width: 320,
    height: 500,
    busX: 8,
    runtimeOrigin: { kind: 'runtime', x: 8, y: 8 },
    anchors,
  };
}

function frame(
  recipients: AgentMessageEventFrame['recipients'],
  overrides: Partial<AgentMessageEventFrame> = {},
): AgentMessageEventFrame {
  return {
    kind: 'agent-message',
    senderAgentId: 'sender',
    routingKind: recipients.length > 1 ? 'group' : 'direct',
    recipients,
    ...overrides,
  };
}

const socketOne = {} as Socket;
const socketTwo = {} as Socket;

describe('AgentEventBusScheduler', () => {
  let routes: AgentEventBusActiveRoute[];
  let timers: ReturnType<typeof createTimerEnvironment>;
  let scheduler: AgentEventBusScheduler;

  beforeEach(() => {
    routes = [];
    timers = createTimerEnvironment();
    scheduler = new AgentEventBusScheduler((nextRoutes) => {
      routes = nextRoutes;
    }, timers.environment);
  });

  it('fans group delivery out with staggered routes and preserves raw recipient status', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 20, 0),
        anchor('r1', 'r1', 80, 1),
        anchor('r2', 'r2', 120, 2),
        anchor('r3', 'r3', 160, 3),
      ]),
    );

    expect(
      scheduler.enqueue(
        frame([
          { agentId: 'r1', status: 'delivered' },
          { agentId: 'r2', status: 'failed' },
          { agentId: 'r3', status: 'unconfirmed' },
        ]),
      ),
    ).toBe(3);
    expect(routes).toHaveLength(1);

    timers.runBefore(500);

    expect(routes).toHaveLength(3);
    expect(routes.map((route) => route.feedback)).toEqual([
      { kind: 'delivery', status: 'delivered' },
      { kind: 'delivery', status: 'failed' },
      { kind: 'delivery', status: 'unconfirmed' },
    ]);
  });

  it('enforces six active and 24 total routes and drops newly arriving excess', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    const recipients = Array.from({ length: 30 }, (_, index) => ({
      agentId: `recipient-${index}`,
      status: 'delivered' as const,
    }));
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 10, 0),
        ...recipients.map((recipient, index) =>
          anchor(recipient.agentId, recipient.agentId, 30 + index * 10, index + 1),
        ),
      ]),
    );

    for (const recipient of recipients.slice(0, EVENT_BUS_MAX_TOTAL_ROUTES)) {
      expect(scheduler.enqueue(frame([recipient]))).toBe(1);
    }

    expect(scheduler.activeCount).toBe(EVENT_BUS_MAX_ACTIVE_ROUTES);
    expect(scheduler.totalCount).toBe(EVENT_BUS_MAX_TOTAL_ROUTES);
    expect(scheduler.enqueue(frame([{ agentId: 'recipient-29', status: 'delivered' }]))).toBe(0);
  });

  it('drops every route for a missing sender but only the missing recipient otherwise', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 20, 0),
        anchor('mounted', 'mounted', 80, 1),
      ]),
    );

    expect(
      scheduler.enqueue(
        frame([{ agentId: 'mounted', status: 'delivered' }], {
          senderAgentId: 'missing',
        }),
      ),
    ).toBe(0);
    expect(
      scheduler.enqueue(
        frame([
          { agentId: 'missing', status: 'failed' },
          { agentId: 'mounted', status: 'delivered' },
        ]),
      ),
    ).toBe(2);
    timers.runBefore(500);

    expect(routes).toHaveLength(1);
    expect(routes[0].recipientAgentId).toBe('mounted');
  });

  it('rebuilds only moved active routes and drops only disappeared endpoints', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 20, 0),
        anchor('r1', 'r1', 80, 1),
        anchor('r2', 'r2', 140, 2),
      ]),
    );
    scheduler.enqueue(
      frame([
        { agentId: 'r1', status: 'delivered' },
        { agentId: 'r2', status: 'delivered' },
      ]),
    );
    timers.runBefore(500);
    const initialGenerations = new Map(
      routes.map((route) => [route.recipientAgentId, route.generation]),
    );

    scheduler.commitGeometry(
      geometry(scopeEpoch, 2, [
        anchor('sender', 'sender', 20, 0),
        anchor('r1', 'r1', 100, 1),
        anchor('r2', 'r2', 140, 2),
      ]),
    );

    expect(routes.find((route) => route.recipientAgentId === 'r1')?.generation).toBe(
      (initialGenerations.get('r1') ?? 0) + 1,
    );
    expect(routes.find((route) => route.recipientAgentId === 'r2')?.generation).toBe(
      initialGenerations.get('r2'),
    );

    scheduler.commitGeometry(
      geometry(scopeEpoch, 3, [anchor('sender', 'sender', 20, 0), anchor('r1', 'r1', 100, 1)]),
    );
    expect(routes.map((route) => route.recipientAgentId)).toEqual(['r1']);
  });

  it('starts recipient status feedback only on arrival and releases it after the endpoint window', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 20, 0),
        anchor('delivered', 'delivered', 80, 1),
        anchor('failed', 'failed', 140, 2),
      ]),
    );
    scheduler.enqueue(
      frame([
        { agentId: 'delivered', status: 'delivered' },
        { agentId: 'failed', status: 'failed' },
      ]),
    );
    timers.runBefore(500);

    expect(routes.map((route) => route.mode)).toEqual(['traveling', 'traveling']);

    timers.runDelay(EVENT_BUS_ROUTE_DURATION_MS);

    expect(routes.map((route) => route.mode)).toEqual(['arrived', 'arrived']);
    expect(routes.map((route) => route.feedback)).toEqual([
      { kind: 'delivery', status: 'delivered' },
      { kind: 'delivery', status: 'failed' },
    ]);
    expect(scheduler.totalCount).toBe(2);

    timers.runDelay(240);

    expect(routes).toHaveLength(0);
    expect(scheduler.totalCount).toBe(0);
  });

  it('rejects an old geometry generation arrival callback after rebuilding the route', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 20, 0),
        anchor('recipient', 'recipient', 80, 1),
      ]),
    );
    scheduler.enqueue(frame([{ agentId: 'recipient', status: 'failed' }]));
    const staleArrivalCallbacks = timers.callbacksForDelay(EVENT_BUS_ROUTE_DURATION_MS);

    scheduler.commitGeometry(
      geometry(scopeEpoch, 2, [
        anchor('sender', 'sender', 20, 0),
        anchor('recipient', 'recipient', 100, 1),
      ]),
    );
    const rebuiltGeneration = routes[0].generation;
    timers.forceCallbacks(staleArrivalCallbacks);

    expect(routes[0]).toMatchObject({
      generation: rebuiltGeneration,
      mode: 'traveling',
      feedback: { kind: 'delivery', status: 'failed' },
    });

    timers.runDelay(EVENT_BUS_ROUTE_DURATION_MS);
    expect(routes[0].mode).toBe('arrived');
  });

  it('converts valid traveling routes to static flashes and leaves them static when toggled off', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('sender', 'sender', 20, 0),
        anchor('recipient', 'recipient', 80, 1),
      ]),
    );
    scheduler.enqueue(frame([{ agentId: 'recipient', status: 'failed' }]));
    const travelingGeneration = routes[0].generation;

    scheduler.setReduceMotion(true);

    expect(routes[0].mode).toBe('static');
    expect(routes[0].generation).toBe(travelingGeneration + 1);

    scheduler.setReduceMotion(false);
    expect(routes[0].mode).toBe('static');
  });

  it('routes startup from the runtime origin with neutral feedback and minimal ordinals', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('recipient-bottom', 'recipient', 160, 1),
        anchor('recipient-top', 'recipient', 80, 0),
      ]),
    );

    expect(scheduler.enqueue({ kind: 'session-started', agentId: 'recipient' })).toBe(1);
    expect(scheduler.enqueue({ kind: 'session-started', agentId: 'recipient' })).toBe(1);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      source: { kind: 'runtime' },
      feedback: { kind: 'runtime-started' },
      recipientAgentId: 'recipient',
      runtimeOrdinal: 0,
      mode: 'traveling',
      path: {
        source: { kind: 'runtime', x: 8, y: 8 },
        recipient: { key: 'recipient-top' },
      },
    });
    expect(timers.callbacksForDelay(70)).toHaveLength(1);

    timers.runDelay(70);

    expect(routes).toHaveLength(2);
    expect(routes[1]).toMatchObject({
      source: { kind: 'runtime' },
      feedback: { kind: 'runtime-started' },
      runtimeOrdinal: 1,
    });
    expect(routes.every((route) => !('status' in route))).toBe(true);
    expect(routes.every((route) => !('senderAgentId' in route))).toBe(true);
  });

  it('reuses the lowest free runtime ordinal and drops unmounted startup recipients', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(
      geometry(scopeEpoch, 1, [
        anchor('recipient-a', 'recipient-a', 80, 0),
        anchor('recipient-b', 'recipient-b', 120, 1),
      ]),
    );

    scheduler.enqueue({ kind: 'session-started', agentId: 'recipient-a' });
    scheduler.enqueue({ kind: 'session-started', agentId: 'recipient-b' });
    expect(scheduler.enqueue({ kind: 'session-started', agentId: 'missing' })).toBe(0);

    timers.runDelay(EVENT_BUS_ROUTE_DURATION_MS);
    timers.runDelay(240);
    expect(routes).toHaveLength(0);

    scheduler.enqueue({ kind: 'session-started', agentId: 'recipient-a' });
    expect(routes[0]).toMatchObject({ runtimeOrdinal: 0 });

    scheduler.commitGeometry(geometry(scopeEpoch, 2, []));
    expect(routes).toHaveLength(0);
  });

  it('synchronously converts runtime travel to static origin/target feedback', () => {
    const scopeEpoch = scheduler.resetScope('project-1', socketOne);
    scheduler.commitGeometry(geometry(scopeEpoch, 1, [anchor('recipient', 'recipient', 80, 0)]));
    scheduler.enqueue({ kind: 'session-started', agentId: 'recipient' });

    scheduler.setReduceMotion(true);

    expect(routes[0]).toMatchObject({
      source: { kind: 'runtime' },
      feedback: { kind: 'runtime-started' },
      mode: 'static',
    });
    timers.runDelay(280);
    expect(routes).toHaveLength(0);
  });

  it('rejects stale callbacks and geometry after scope reset and restores all capacity', () => {
    const oldScopeEpoch = scheduler.resetScope('project-1', socketOne);
    const recipients = Array.from({ length: EVENT_BUS_MAX_TOTAL_ROUTES }, (_, index) => ({
      agentId: `old-${index}`,
      status: 'delivered' as const,
    }));
    scheduler.commitGeometry(
      geometry(oldScopeEpoch, 1, [
        anchor('sender', 'sender', 10, 0),
        ...recipients.map((recipient, index) =>
          anchor(recipient.agentId, recipient.agentId, 30 + index * 10, index + 1),
        ),
      ]),
    );
    for (const recipient of recipients) scheduler.enqueue(frame([recipient]));
    expect(scheduler.totalCount).toBe(EVENT_BUS_MAX_TOTAL_ROUTES);

    const newScopeEpoch = scheduler.resetScope('project-2', socketTwo);
    expect(scheduler.totalCount).toBe(0);
    expect(scheduler.commitGeometry(geometry(oldScopeEpoch, 99, []))).toBe(false);
    expect(
      scheduler.enqueue(
        frame([{ agentId: 'new-recipient', status: 'delivered' }], {
          senderAgentId: 'new-sender',
        }),
      ),
    ).toBe(1);
    expect(routes).toHaveLength(0);

    timers.forceAllCallbacks();
    expect(routes).toHaveLength(0);
    expect(scheduler.totalCount).toBe(1);

    expect(
      scheduler.commitGeometry(
        geometry(newScopeEpoch, 1, [
          anchor('new-sender', 'new-sender', 20, 0),
          anchor('new-recipient', 'new-recipient', 80, 1),
        ]),
      ),
    ).toBe(true);
    expect(routes).toHaveLength(1);
    expect(scheduler.totalCount).toBe(1);
  });
});
