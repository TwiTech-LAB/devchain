import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { getAppSocket, releaseAppSocket, type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import {
  type RealtimeInvalidationRegistry,
  dispatchRealtimeEnvelope,
  exactTopic,
} from '@/ui/lib/realtime-invalidation-registry';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

export type DeferredHoldReason = 'human_draft' | 'awaiting_quiet' | 'awaiting_idle';

export const HOLD_REASON_LABELS: Record<DeferredHoldReason, string> = {
  human_draft: 'Waiting for you to finish typing',
  awaiting_quiet: 'Waiting for terminal quiet',
  awaiting_idle: 'Waiting for provider idle',
};

/** Pool details from the API */
export interface PoolDetails {
  agentId: string;
  agentName: string;
  projectId: string;
  messageCount: number;
  humanHeldMessageCount: number;
  humanReleaseEligibleAt?: number;
  holdReason?: DeferredHoldReason;
  forceEligibleAt?: number;
  activeSessionId?: string;
  deferredMessageIds?: string[];
  waitingMs: number;
  messages: Array<{
    id: string;
    preview: string;
    source: string;
    timestamp: number;
  }>;
}

/** Server-derived Send now eligibility; never inferred from waitingMs or held counts. */
export function isForceEligible(pool: PoolDetails, now: number): boolean {
  return (
    pool.holdReason !== undefined &&
    pool.holdReason !== 'human_draft' &&
    pool.forceEligibleAt !== undefined &&
    pool.forceEligibleAt <= now &&
    pool.activeSessionId !== undefined &&
    pool.deferredMessageIds !== undefined &&
    pool.deferredMessageIds.length > 0
  );
}

export interface ForceDeliveryResult {
  status: 'delivered' | 'unconfirmed' | 'deferred' | 'failed';
  deliveredCount?: number;
  reason?: string;
}

export class ForceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForceConflictError';
  }
}

export interface ForceDeliveryRequest {
  agentId: string;
  sessionId: string;
  messageIds: string[];
}

interface PoolsResponse {
  pools: PoolDetails[];
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchPools(projectId: string, fetchFn: FetchFn): Promise<PoolDetails[]> {
  const res = await fetchFn(`/api/sessions/pools?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) {
    throw new Error('Failed to fetch pools');
  }
  const data: PoolsResponse = await res.json();
  return data.pools;
}

async function forceDeferred(
  projectId: string,
  agentId: string,
  sessionId: string,
  messageIds: string[],
  fetchFn: FetchFn,
): Promise<ForceDeliveryResult> {
  const response = await fetchFn(
    `/api/sessions/pools/${encodeURIComponent(agentId)}/force-deferred`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sessionId, messageIds }),
    },
  );
  if (response.status === 409) {
    throw new ForceConflictError(
      (await response.json().catch(() => ({}))).message ?? 'Snapshot changed',
    );
  }
  if (!response.ok) {
    throw new Error('Failed to force-send messages.');
  }
  return response.json();
}

async function releaseHumanHold(
  projectId: string,
  agentId: string,
  fetchFn: FetchFn,
): Promise<void> {
  const response = await fetchFn(
    `/api/sessions/pools/${encodeURIComponent(agentId)}/release-human-hold`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? 'More recent terminal input postponed queued-message release.'
        : 'Failed to release queued messages.',
    );
  }
}

/**
 * Sole owner of the project-scoped message-pool query and its `messages/pools`
 * realtime invalidation. Consumers read the returned cache state directly; a
 * second subscriber joins the same shared socket and query key.
 */
export function useMessagePools(projectId: string | null) {
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();
  // Realtime registry keys are string[]; the no-project placeholder keeps the
  // key well-formed while the disabled query never fetches.
  const poolsQueryKey = useMemo(() => ['pools', projectId ?? 'no-project'], [projectId]);

  const {
    data: pools,
    isLoading,
    error,
  } = useQuery({
    queryKey: poolsQueryKey,
    queryFn: () => fetchPools(projectId!, apiFetch),
    enabled: Boolean(projectId),
    refetchInterval: 5000, // Fallback poll; realtime invalidation is the primary refresh path
    staleTime: 1000,
  });

  const releaseMutation = useMutation({
    mutationFn: (agentId: string) => releaseHumanHold(projectId!, agentId, apiFetch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: poolsQueryKey }),
  });

  const forceMutation = useMutation({
    mutationFn: (req: ForceDeliveryRequest) =>
      forceDeferred(projectId!, req.agentId, req.sessionId, req.messageIds, apiFetch),
    onSettled: () => queryClient.invalidateQueries({ queryKey: poolsQueryKey }),
  });

  const poolsRegistry: RealtimeInvalidationRegistry = useMemo(
    () => [
      {
        match: exactTopic('messages/pools'),
        type: 'updated',
        entries: [{ kind: 'invalidate' as const, queryKey: poolsQueryKey }],
      },
    ],
    [poolsQueryKey],
  );

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      dispatchRealtimeEnvelope(envelope, poolsRegistry, queryClient);
    },
    [poolsRegistry, queryClient],
  );

  // Root-project pool broadcasts arrive on the main instance socket; pin this
  // subscription to it even while a worktree tab is active. Passing an override
  // makes useAppSocket skip its own acquire/release, so this hook owns the
  // shared socket's refcount for its lifetime.
  const rootSocketRef = useRef<Socket | null>(null);
  if (rootSocketRef.current === null) {
    rootSocketRef.current = getAppSocket();
  }
  useEffect(() => () => releaseAppSocket(), []);

  useAppSocket({ message: handleEnvelope }, [handleEnvelope], rootSocketRef.current);

  return {
    pools,
    isLoading,
    error,
    releaseHumanHeldMessages: releaseMutation.mutateAsync,
    releasingAgentId: releaseMutation.isPending ? releaseMutation.variables : null,
    forceDeferredDelivery: forceMutation.mutateAsync,
    forcingAgentId: forceMutation.isPending ? (forceMutation.variables?.agentId ?? null) : null,
  };
}
