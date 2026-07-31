import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useAppSocket } from '@/ui/hooks/useAppSocket';

export type AgentMessageRecipientStatus = 'queued' | 'delivered' | 'failed' | 'unconfirmed';

export interface AgentMessageEventRecipient {
  agentId: string;
  status: AgentMessageRecipientStatus;
}

export interface AgentMessageEventFrame {
  kind: 'agent-message';
  senderAgentId: string;
  routingKind: 'direct' | 'group';
  teamId?: string;
  recipients: AgentMessageEventRecipient[];
}

export interface SessionStartedEventFrame {
  kind: 'session-started';
  agentId: string;
}

/**
 * An epic changed hands. `fromAgentId` is null for a first assignment, which routes from
 * the runtime origin exactly like a session start — there is no sender to travel from.
 */
export interface EpicAssignedEventFrame {
  kind: 'epic-assigned';
  fromAgentId: string | null;
  toAgentId: string;
}

export type AgentEventBusStreamFrame =
  | AgentMessageEventFrame
  | SessionStartedEventFrame
  | EpicAssignedEventFrame;

type AgentEventBusEventHandler = (frame: AgentEventBusStreamFrame) => void;

const FRAME_KEYS = new Set(['senderAgentId', 'routingKind', 'teamId', 'recipients']);
const RECIPIENT_KEYS = new Set(['agentId', 'status']);
const SESSION_STARTED_KEYS = new Set(['agentId']);
const EPIC_ASSIGNED_KEYS = new Set(['fromAgentId', 'toAgentId']);
const ENVELOPE_KEYS = new Set(['topic', 'type', 'payload', 'ts']);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECIPIENT_STATUSES = new Set<AgentMessageRecipientStatus>([
  'queued',
  'delivered',
  'failed',
  'unconfirmed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAgentMessageRecipient(value: unknown): value is AgentMessageEventRecipient {
  if (!isRecord(value) || !hasOnlyKeys(value, RECIPIENT_KEYS)) return false;
  if (Object.keys(value).length !== RECIPIENT_KEYS.size) return false;

  return (
    isNonEmptyString(value.agentId) &&
    typeof value.status === 'string' &&
    RECIPIENT_STATUSES.has(value.status as AgentMessageRecipientStatus)
  );
}

export type AgentMessageEventPayload = Omit<AgentMessageEventFrame, 'kind'>;

export function isAgentMessageEventPayload(value: unknown): value is AgentMessageEventPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, FRAME_KEYS)) return false;
  if (!isNonEmptyString(value.senderAgentId)) return false;
  if (value.routingKind !== 'direct' && value.routingKind !== 'group') return false;
  if ('teamId' in value && !isNonEmptyString(value.teamId)) return false;
  if (value.routingKind === 'direct' && 'teamId' in value) return false;
  if (!Array.isArray(value.recipients) || value.recipients.length === 0) return false;
  if (!value.recipients.every(isAgentMessageRecipient)) return false;

  const recipientIds = value.recipients.map((recipient) => recipient.agentId);
  return new Set(recipientIds).size === recipientIds.length;
}

export function isSessionStartedEventPayload(
  value: unknown,
): value is Omit<SessionStartedEventFrame, 'kind'> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, SESSION_STARTED_KEYS) &&
    Object.keys(value).length === SESSION_STARTED_KEYS.size &&
    isNonEmptyString(value.agentId)
  );
}

export function isEpicAssignedEventPayload(
  value: unknown,
): value is Omit<EpicAssignedEventFrame, 'kind'> {
  if (!isRecord(value) || !hasOnlyKeys(value, EPIC_ASSIGNED_KEYS)) return false;
  if (Object.keys(value).length !== EPIC_ASSIGNED_KEYS.size) return false;
  if (!isNonEmptyString(value.toAgentId)) return false;
  // A first assignment has no sender; anything else must be a real agent id.
  return value.fromAgentId === null || isNonEmptyString(value.fromAgentId);
}

function hasValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseAgentEventBusEnvelope(
  value: unknown,
  expectedTopic: string,
): AgentEventBusStreamFrame | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ENVELOPE_KEYS) ||
    Object.keys(value).length !== ENVELOPE_KEYS.size ||
    value.topic !== expectedTopic ||
    !hasValidTimestamp(value.ts)
  ) {
    return null;
  }

  if (value.type === 'sent' && isAgentMessageEventPayload(value.payload)) {
    return { kind: 'agent-message', ...value.payload };
  }
  // Wire type is `session.starting` — the launch pipeline announces the start before the
  // provider CLI runs, so the pulse is not several seconds behind the agent. The client
  // discriminant stays `session-started` because it names the visual concept (a startup
  // route), not the backend event.
  if (value.type === 'session.starting' && isSessionStartedEventPayload(value.payload)) {
    return { kind: 'session-started', ...value.payload };
  }
  if (value.type === 'epic.assignment' && isEpicAssignedEventPayload(value.payload)) {
    return { kind: 'epic-assigned', ...value.payload };
  }
  return null;
}

/**
 * Consumes transient event-bus frames from the runtime-selected pooled socket.
 * The returned socket identity is part of the visualization's runtime scope.
 */
export function useAgentEventBusStream(
  projectId: string | null | undefined,
  onFrame: AgentEventBusEventHandler,
): Socket {
  const socket = useAppSocket({}, []);
  const latestHandlerRef = useRef(onFrame);
  const scopeEpochRef = useRef(0);
  const activeScopeRef = useRef<{ projectId: string; socket: Socket } | null>(null);

  useLayoutEffect(() => {
    latestHandlerRef.current = onFrame;
  }, [onFrame]);

  useLayoutEffect(() => {
    scopeEpochRef.current += 1;
    activeScopeRef.current = projectId ? { projectId, socket } : null;
  }, [projectId, socket]);

  useEffect(() => {
    if (!projectId) return;

    const expectedTopic = `project/${projectId}/agent-messages`;
    const listenerEpoch = scopeEpochRef.current;
    const handleMessage = (envelope: unknown) => {
      const activeScope = activeScopeRef.current;
      if (
        !activeScope ||
        activeScope.projectId !== projectId ||
        activeScope.socket !== socket ||
        scopeEpochRef.current !== listenerEpoch
      ) {
        return;
      }
      const frame = parseAgentEventBusEnvelope(envelope, expectedTopic);
      if (frame) latestHandlerRef.current(frame);
    };

    socket.on('message', handleMessage);
    return () => {
      socket.off('message', handleMessage);
    };
  }, [projectId, socket]);

  return socket;
}
