import { useCallback, useEffect, useState } from 'react';
import {
  isForceEligible,
  type ForceDeliveryRequest,
  type ForceDeliveryResult,
  type PoolDetails,
} from '@/ui/hooks/chat/useMessagePools';

/** The exact agent, session and ordered batch the user is asked to confirm. */
export interface ForceDeliveryTarget extends ForceDeliveryRequest {
  agentName: string;
  messageCount: number;
}

interface UseForceDeliveryConfirmOptions {
  pools: PoolDetails[] | undefined;
  /** Caller-owned clock tick; eligibility is time based. */
  now: number;
  forceDeferredDelivery: (request: ForceDeliveryRequest) => Promise<ForceDeliveryResult>;
  forcingAgentId: string | null;
  /** Must be referentially stable (useCallback). */
  onResult: (result: ForceDeliveryResult, target: ForceDeliveryTarget) => void;
  /** Must be referentially stable (useCallback). */
  onError: (error: unknown, target: ForceDeliveryTarget) => void;
}

function describeForceDelivery(target: ForceDeliveryTarget | null): string {
  if (!target) return '';
  const noun = target.messageCount === 1 ? 'message' : 'messages';
  return `Send ${target.messageCount} queued ${noun} to ${target.agentName} now? Active typing will still prevent delivery.`;
}

function matchesSnapshot(pool: PoolDetails, target: ForceDeliveryTarget): boolean {
  return (
    pool.activeSessionId === target.sessionId &&
    pool.deferredMessageIds !== undefined &&
    pool.deferredMessageIds.length === target.messageIds.length &&
    pool.deferredMessageIds.every((id, index) => id === target.messageIds[index])
  );
}

/**
 * Send now confirmation shared by Chat and Current Pools: captures the confirmed
 * snapshot, closes a stale confirmation, and reports the actual outcome to the caller.
 */
export function useForceDeliveryConfirm({
  pools,
  now,
  forceDeferredDelivery,
  forcingAgentId,
  onResult,
  onError,
}: UseForceDeliveryConfirmOptions) {
  const [target, setTarget] = useState<ForceDeliveryTarget | null>(null);

  // Stale confirmation: close the dialog when the pool snapshot changes.
  useEffect(() => {
    if (!target || !pools) return;
    const pool = pools.find((p) => p.agentId === target.agentId);
    if (!pool || !matchesSnapshot(pool, target) || !isForceEligible(pool, now)) {
      setTarget(null);
    }
  }, [pools, target, now]);

  /** Returns false when the pool has no confirmable batch. */
  const open = useCallback((pool: PoolDetails | undefined): boolean => {
    if (!pool?.activeSessionId || !pool.deferredMessageIds?.length) return false;
    setTarget({
      agentId: pool.agentId,
      agentName: pool.agentName,
      sessionId: pool.activeSessionId,
      messageIds: pool.deferredMessageIds,
      messageCount: pool.deferredMessageIds.length,
    });
    return true;
  }, []);

  const confirm = useCallback(() => {
    if (!target) return;
    void forceDeferredDelivery({
      agentId: target.agentId,
      sessionId: target.sessionId,
      messageIds: target.messageIds,
    })
      .then((result) => {
        setTarget(null);
        onResult(result, target);
      })
      .catch((error: unknown) => {
        setTarget(null);
        onError(error, target);
      });
  }, [target, forceDeferredDelivery, onResult, onError]);

  return {
    open,
    dialogProps: {
      open: target !== null,
      onOpenChange: (isOpen: boolean) => {
        if (!isOpen && forcingAgentId === null) setTarget(null);
      },
      onConfirm: confirm,
      title: 'Send now',
      description: describeForceDelivery(target),
      confirmText: 'Send now',
      cancelText: 'Cancel',
      loading: forcingAgentId === target?.agentId,
    },
  };
}
