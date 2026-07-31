import type { Socket } from 'socket.io-client';
import type { AgentEventBusStreamFrame } from './useAgentEventBusStream';
import { selectAgentEventBusRoute, selectRuntimeEventBusRoute } from './geometry';
import type {
  AgentEventBusActiveRoute,
  AgentEventBusEventKind,
  AgentEventBusDeliveryStatus,
  AgentEventBusGeometrySnapshot,
  AgentEventBusPath,
} from './types';

export const EVENT_BUS_MAX_ACTIVE_ROUTES = 6;
export const EVENT_BUS_MAX_TOTAL_ROUTES = 24;
export const EVENT_BUS_GROUP_STAGGER_MS = 70;
export const EVENT_BUS_STATIC_FLASH_MS = 280;
export const EVENT_BUS_ENDPOINT_FEEDBACK_MS = 240;

type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingRouteBase {
  id: string;
  frameId: string;
  eventKind: AgentEventBusEventKind;
  recipientAgentId: string;
  ready: boolean;
  staggerTimer?: TimerHandle;
}

type PendingRoute = PendingRouteBase &
  (
    | {
        source: { kind: 'agent'; senderAgentId: string };
        feedback: { kind: 'delivery'; status: AgentEventBusDeliveryStatus };
        teamId?: string;
      }
    | {
        source: { kind: 'runtime' };
        feedback: { kind: 'runtime-started' };
        runtimeOrdinal: number;
      }
  );

type InternalActiveRoute = AgentEventBusActiveRoute & {
  arrivalTimer?: TimerHandle;
  completionTimer?: TimerHandle;
};

export interface AgentEventBusSchedulerEnvironment {
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
}

const DEFAULT_ENVIRONMENT: AgentEventBusSchedulerEnvironment = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
};

function publicRoute(route: InternalActiveRoute): AgentEventBusActiveRoute {
  const { arrivalTimer: _arrivalTimer, completionTimer: _completionTimer, ...visibleRoute } = route;
  return visibleRoute;
}

function pathSourceKey(path: AgentEventBusPath): string {
  return path.source.kind === 'agent'
    ? `agent:${path.source.key}`
    : `runtime:${path.source.x}:${path.source.y}`;
}

function pathChanged(previous: AgentEventBusPath, next: AgentEventBusPath): boolean {
  return (
    pathSourceKey(previous) !== pathSourceKey(next) ||
    previous.recipient.key !== next.recipient.key ||
    previous.d !== next.d ||
    previous.length !== next.length
  );
}

function selectRoute(
  snapshot: AgentEventBusGeometrySnapshot,
  route: PendingRoute | AgentEventBusActiveRoute,
): AgentEventBusPath | null {
  if ('runtimeOrdinal' in route) {
    return selectRuntimeEventBusRoute(snapshot, route.recipientAgentId)?.path ?? null;
  }
  return (
    selectAgentEventBusRoute(
      snapshot,
      route.source.senderAgentId,
      route.recipientAgentId,
      route.teamId,
    )?.path ?? null
  );
}

export class AgentEventBusScheduler {
  private readonly environment: AgentEventBusSchedulerEnvironment;
  private readonly onRoutesChanged: (routes: AgentEventBusActiveRoute[]) => void;
  private scopeEpoch = 0;
  private projectId: string | null = null;
  private socket: Socket | null = null;
  private geometry: AgentEventBusGeometrySnapshot | null = null;
  private pending: PendingRoute[] = [];
  private active: InternalActiveRoute[] = [];
  private nextFrameId = 1;
  private nextRouteId = 1;
  private reduceMotion = false;

  constructor(
    onRoutesChanged: (routes: AgentEventBusActiveRoute[]) => void,
    environment: AgentEventBusSchedulerEnvironment = DEFAULT_ENVIRONMENT,
  ) {
    this.onRoutesChanged = onRoutesChanged;
    this.environment = environment;
  }

  get currentScopeEpoch(): number {
    return this.scopeEpoch;
  }

  get activeCount(): number {
    return this.active.length;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get totalCount(): number {
    return this.active.length + this.pending.length;
  }

  resetScope(projectId: string | null | undefined, socket: Socket): number {
    const normalizedProjectId = projectId || null;
    if (
      normalizedProjectId !== null &&
      normalizedProjectId === this.projectId &&
      socket === this.socket
    ) {
      return this.scopeEpoch;
    }

    this.scopeEpoch += 1;
    this.projectId = normalizedProjectId;
    this.socket = normalizedProjectId ? socket : null;
    this.geometry = null;
    this.clearAllRoutes();
    return this.scopeEpoch;
  }

  commitGeometry(snapshot: AgentEventBusGeometrySnapshot): boolean {
    if (snapshot.scopeEpoch !== this.scopeEpoch || this.projectId === null) return false;
    if (this.geometry && snapshot.geometryEpoch <= this.geometry.geometryEpoch) return false;

    this.geometry = snapshot;
    const retained: InternalActiveRoute[] = [];
    for (const route of this.active) {
      const path = selectRoute(snapshot, route);
      if (!path) {
        this.clearRouteTimers(route);
        continue;
      }
      if (!pathChanged(route.path, path)) {
        retained.push(route);
        continue;
      }

      this.clearRouteTimers(route);
      const rebuilt: InternalActiveRoute = {
        ...route,
        generation: route.generation + 1,
        path,
      };
      this.scheduleRoutePhase(rebuilt);
      retained.push(rebuilt);
    }
    this.active = retained;
    this.drain();
    this.emitRoutes();
    return true;
  }

  enqueue(frame: AgentEventBusStreamFrame): number {
    if (!this.projectId) return 0;
    switch (frame.kind) {
      case 'agent-message':
        return this.enqueueAgentMessage(frame);
      case 'session-started':
        return this.enqueueRuntimeStart(frame.agentId, 'session-started');
      case 'epic-assigned':
        // A first assignment has no previous holder, so it rides the runtime origin —
        // the same shape a session start uses when nothing sent it.
        return frame.fromAgentId === null
          ? this.enqueueRuntimeStart(frame.toAgentId, 'epic-assigned')
          : this.enqueueHandover(frame.fromAgentId, frame.toAgentId);
    }
  }

  setReduceMotion(enabled: boolean): void {
    if (enabled === this.reduceMotion) return;
    this.reduceMotion = enabled;
    if (!enabled || !this.geometry) return;

    const converted: InternalActiveRoute[] = [];
    for (const route of this.active) {
      this.clearRouteTimers(route);
      const path = selectRoute(this.geometry, route);
      if (!path) continue;
      const staticRoute: InternalActiveRoute = {
        ...route,
        generation: route.generation + 1,
        mode: 'static',
        path,
      };
      this.scheduleRoutePhase(staticRoute);
      converted.push(staticRoute);
    }
    this.active = converted;
    this.drain();
    this.emitRoutes();
  }

  dispose(): void {
    this.geometry = null;
    this.projectId = null;
    this.socket = null;
    this.clearAllRoutes(false);
  }

  private enqueueAgentMessage(
    frame: Extract<AgentEventBusStreamFrame, { kind: 'agent-message' }>,
  ): number {
    if (
      this.geometry &&
      !this.geometry.anchors.some((anchor) => anchor.agentId === frame.senderAgentId)
    ) {
      return 0;
    }

    const availableCapacity = EVENT_BUS_MAX_TOTAL_ROUTES - this.totalCount;
    if (availableCapacity <= 0) return 0;
    const acceptedRecipients = frame.recipients.slice(0, availableCapacity);
    const frameId = `${this.scopeEpoch}:frame:${this.nextFrameId++}`;
    const enqueueEpoch = this.scopeEpoch;

    acceptedRecipients.forEach((recipient, index) => {
      const request: PendingRoute = {
        id: `${this.scopeEpoch}:route:${this.nextRouteId++}`,
        frameId,
        eventKind: 'agent-message',
        source: { kind: 'agent', senderAgentId: frame.senderAgentId },
        recipientAgentId: recipient.agentId,
        ...(frame.teamId ? { teamId: frame.teamId } : {}),
        feedback: { kind: 'delivery', status: recipient.status },
        ready: frame.routingKind !== 'group' || index === 0,
      };
      if (!request.ready) {
        this.schedulePendingReady(request, index * EVENT_BUS_GROUP_STAGGER_MS, enqueueEpoch);
      }
      this.pending.push(request);
    });

    this.drain();
    this.emitRoutes();
    return acceptedRecipients.length;
  }

  /**
   * An epic moving between two agents: one route, from the previous holder to the new
   * one. Feedback is `delivered` because a handover has no delivery status of its own —
   * the neutral success arrival — while `eventKind` carries the epic identity.
   */
  private enqueueHandover(fromAgentId: string, toAgentId: string): number {
    if (this.totalCount >= EVENT_BUS_MAX_TOTAL_ROUTES) return 0;
    if (this.geometry && !this.geometry.anchors.some((anchor) => anchor.agentId === fromAgentId)) {
      return 0;
    }

    this.pending.push({
      id: `${this.scopeEpoch}:route:${this.nextRouteId++}`,
      frameId: `${this.scopeEpoch}:frame:${this.nextFrameId++}`,
      eventKind: 'epic-assigned',
      source: { kind: 'agent', senderAgentId: fromAgentId },
      recipientAgentId: toAgentId,
      feedback: { kind: 'delivery', status: 'delivered' },
      ready: true,
    });

    this.drain();
    this.emitRoutes();
    return 1;
  }

  private enqueueRuntimeStart(
    recipientAgentId: string,
    eventKind: Extract<AgentEventBusEventKind, 'session-started' | 'epic-assigned'>,
  ): number {
    if (this.totalCount >= EVENT_BUS_MAX_TOTAL_ROUTES) return 0;
    if (this.geometry && !selectRuntimeEventBusRoute(this.geometry, recipientAgentId)) {
      return 0;
    }

    const runtimeOrdinal = this.nextRuntimeOrdinal();
    const request: PendingRoute = {
      id: `${this.scopeEpoch}:route:${this.nextRouteId++}`,
      frameId: `${this.scopeEpoch}:frame:${this.nextFrameId++}`,
      eventKind,
      source: { kind: 'runtime' },
      recipientAgentId,
      feedback: { kind: 'runtime-started' },
      runtimeOrdinal,
      ready: runtimeOrdinal === 0,
    };
    if (!request.ready) {
      this.schedulePendingReady(
        request,
        runtimeOrdinal * EVENT_BUS_GROUP_STAGGER_MS,
        this.scopeEpoch,
      );
    }
    this.pending.push(request);
    this.drain();
    this.emitRoutes();
    return 1;
  }

  private nextRuntimeOrdinal(): number {
    const occupied = new Set<number>();
    for (const route of this.pending) {
      if ('runtimeOrdinal' in route) occupied.add(route.runtimeOrdinal);
    }
    for (const route of this.active) {
      if ('runtimeOrdinal' in route) occupied.add(route.runtimeOrdinal);
    }
    let ordinal = 0;
    while (occupied.has(ordinal)) ordinal += 1;
    return ordinal;
  }

  private schedulePendingReady(request: PendingRoute, delayMs: number, enqueueEpoch: number): void {
    request.staggerTimer = this.environment.setTimer(() => {
      if (this.scopeEpoch !== enqueueEpoch) return;
      const queued = this.pending.find((candidate) => candidate.id === request.id);
      if (!queued) return;
      queued.staggerTimer = undefined;
      queued.ready = true;
      this.drain();
      this.emitRoutes();
    }, delayMs);
  }

  private drain(): void {
    const snapshot = this.geometry;
    if (!snapshot || snapshot.scopeEpoch !== this.scopeEpoch) return;

    const mountedSenders = new Set(snapshot.anchors.map((anchor) => anchor.agentId));
    const missingSenderFrames = new Set(
      this.pending
        .filter(
          (request) =>
            !('runtimeOrdinal' in request) && !mountedSenders.has(request.source.senderAgentId),
        )
        .map((request) => request.frameId),
    );
    if (missingSenderFrames.size > 0) {
      this.pending = this.pending.filter((request) => {
        if (!missingSenderFrames.has(request.frameId)) return true;
        this.clearStaggerTimer(request);
        return false;
      });
    }
    this.pending = this.pending.filter((request) => {
      if (
        !('runtimeOrdinal' in request) ||
        selectRuntimeEventBusRoute(snapshot, request.recipientAgentId)
      ) {
        return true;
      }
      this.clearStaggerTimer(request);
      return false;
    });

    while (this.active.length < EVENT_BUS_MAX_ACTIVE_ROUTES) {
      const pendingIndex = this.pending.findIndex((request) => request.ready);
      if (pendingIndex < 0) break;
      const [request] = this.pending.splice(pendingIndex, 1);
      this.clearStaggerTimer(request);
      const path = selectRoute(snapshot, request);
      if (!path) continue;

      const route: InternalActiveRoute =
        'runtimeOrdinal' in request
          ? {
              id: request.id,
              frameId: request.frameId,
              generation: 1,
              eventKind: request.eventKind,
              recipientAgentId: request.recipientAgentId,
              source: request.source,
              feedback: request.feedback,
              runtimeOrdinal: request.runtimeOrdinal,
              mode: this.reduceMotion ? 'static' : 'traveling',
              path,
            }
          : {
              id: request.id,
              frameId: request.frameId,
              generation: 1,
              eventKind: request.eventKind,
              recipientAgentId: request.recipientAgentId,
              source: request.source,
              feedback: request.feedback,
              ...(request.teamId ? { teamId: request.teamId } : {}),
              mode: this.reduceMotion ? 'static' : 'traveling',
              path,
            };
      this.scheduleRoutePhase(route);
      this.active.push(route);
    }
  }

  private scheduleRoutePhase(route: InternalActiveRoute): void {
    if (route.mode === 'traveling') {
      this.scheduleArrival(route);
      return;
    }
    this.scheduleCompletion(
      route,
      route.mode === 'static' ? EVENT_BUS_STATIC_FLASH_MS : EVENT_BUS_ENDPOINT_FEEDBACK_MS,
    );
  }

  private scheduleArrival(route: InternalActiveRoute): void {
    const arrivalEpoch = this.scopeEpoch;
    const arrivalGeneration = route.generation;
    route.arrivalTimer = this.environment.setTimer(() => {
      if (this.scopeEpoch !== arrivalEpoch) return;
      const routeIndex = this.active.findIndex(
        (candidate) =>
          candidate.id === route.id &&
          candidate.generation === arrivalGeneration &&
          candidate.mode === 'traveling',
      );
      if (routeIndex < 0) return;
      const arrivedRoute: InternalActiveRoute = {
        ...this.active[routeIndex],
        arrivalTimer: undefined,
        mode: 'arrived',
      };
      this.scheduleCompletion(arrivedRoute, EVENT_BUS_ENDPOINT_FEEDBACK_MS);
      this.active[routeIndex] = arrivedRoute;
      this.emitRoutes();
    }, route.path.durationMs);
  }

  private scheduleCompletion(route: InternalActiveRoute, delayMs: number): void {
    const completionEpoch = this.scopeEpoch;
    const completionGeneration = route.generation;
    const completionMode = route.mode;
    route.completionTimer = this.environment.setTimer(() => {
      if (this.scopeEpoch !== completionEpoch) return;
      const routeIndex = this.active.findIndex(
        (candidate) =>
          candidate.id === route.id &&
          candidate.generation === completionGeneration &&
          candidate.mode === completionMode,
      );
      if (routeIndex < 0) return;
      this.active.splice(routeIndex, 1);
      this.drain();
      this.emitRoutes();
    }, delayMs);
  }

  private clearArrivalTimer(route: InternalActiveRoute): void {
    if (route.arrivalTimer === undefined) return;
    this.environment.clearTimer(route.arrivalTimer);
    route.arrivalTimer = undefined;
  }

  private clearCompletionTimer(route: InternalActiveRoute): void {
    if (route.completionTimer === undefined) return;
    this.environment.clearTimer(route.completionTimer);
    route.completionTimer = undefined;
  }

  private clearRouteTimers(route: InternalActiveRoute): void {
    this.clearArrivalTimer(route);
    this.clearCompletionTimer(route);
  }

  private clearStaggerTimer(route: PendingRoute): void {
    if (route.staggerTimer === undefined) return;
    this.environment.clearTimer(route.staggerTimer);
    route.staggerTimer = undefined;
  }

  private clearAllRoutes(emit = true): void {
    for (const route of this.pending) this.clearStaggerTimer(route);
    for (const route of this.active) this.clearRouteTimers(route);
    this.pending = [];
    this.active = [];
    if (emit) this.emitRoutes();
  }

  private emitRoutes(): void {
    this.onRoutesChanged(this.active.map(publicRoute));
  }
}
