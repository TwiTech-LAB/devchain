import type { RefCallback } from 'react';

export type AgentEventBusDeliveryStatus = 'queued' | 'delivered' | 'failed' | 'unconfirmed';

export interface AgentEventBusAnchorDescriptor {
  key: string;
  agentId: string;
  teamId?: string;
}

export interface AgentEventBusAnchor extends AgentEventBusAnchorDescriptor {
  x: number;
  y: number;
  order: number;
}

export interface AgentEventBusRuntimeOrigin {
  kind: 'runtime';
  x: number;
  y: number;
}

export interface AgentEventBusGeometrySnapshot {
  scopeEpoch: number;
  geometryEpoch: number;
  width: number;
  height: number;
  busX: number;
  runtimeOrigin: AgentEventBusRuntimeOrigin;
  anchors: AgentEventBusAnchor[];
}

export type AgentEventBusPathSource =
  | (AgentEventBusAnchor & { kind: 'agent' })
  | AgentEventBusRuntimeOrigin;

export interface AgentEventBusPath {
  d: string;
  length: number;
  durationMs: number;
  radius: number;
  source: AgentEventBusPathSource;
  recipient: AgentEventBusAnchor;
}

export type AgentEventBusRouteSource =
  | { kind: 'agent'; senderAgentId: string }
  | { kind: 'runtime' };

export type AgentEventBusRouteFeedback =
  | { kind: 'delivery'; status: AgentEventBusDeliveryStatus }
  | { kind: 'runtime-started' };

/**
 * What the pulse represents. Deliberately independent of `source.kind`: an epic can be
 * assigned by an agent or by the system, so topology cannot stand in for identity the way
 * it did when messages and session starts were the only two kinds.
 */
export type AgentEventBusEventKind = 'agent-message' | 'session-started' | 'epic-assigned';

interface AgentEventBusActiveRouteBase {
  id: string;
  frameId: string;
  generation: number;
  eventKind: AgentEventBusEventKind;
  recipientAgentId: string;
  mode: 'traveling' | 'arrived' | 'static';
  path: AgentEventBusPath;
}

export type AgentEventBusActiveRoute = AgentEventBusActiveRouteBase &
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

export interface AgentEventBusLayoutApi {
  getAnchorRef: (descriptor: AgentEventBusAnchorDescriptor) => RefCallback<HTMLElement>;
  refreshRegistrationOrder: () => void;
}

export interface AgentEventBusAnimationHandle {
  cancel: () => void;
}

export interface AgentEventBusAnimationDriver {
  animate: (
    element: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) => AgentEventBusAnimationHandle;
}
