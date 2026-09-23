import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import {
  useMessagePools,
  isForceEligible,
  ForceConflictError,
  HOLD_REASON_LABELS,
  type PoolDetails,
  type ForceDeliveryResult,
} from '@/ui/hooks/chat/useMessagePools';
import {
  useForceDeliveryConfirm,
  type ForceDeliveryTarget,
} from '@/ui/hooks/chat/useForceDeliveryConfirm';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { cn } from '@/ui/lib/utils';

export type { PoolDetails };

interface CurrentPoolsPanelProps {
  projectId: string;
  onAgentClick?: (agentId: string) => void;
  selectedAgentId?: string;
}

interface PoolCardProps {
  pool: PoolDetails;
  onClick?: () => void;
  isSelected?: boolean;
}

function PoolCard({ pool, onClick, isSelected }: PoolCardProps) {
  const waitSeconds = Math.round(pool.waitingMs / 1000);
  const holdLabel = pool.holdReason ? HOLD_REASON_LABELS[pool.holdReason] : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'p-3 border rounded-lg text-left transition-colors',
        'hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        isSelected && 'bg-accent border-primary',
      )}
      aria-pressed={isSelected}
      aria-label={`${pool.agentName}: ${pool.messageCount} message${pool.messageCount !== 1 ? 's' : ''}, waiting ${waitSeconds} seconds${holdLabel ? `, ${holdLabel.toLowerCase()}` : ''}`}
    >
      <div className="font-medium">{pool.agentName}</div>
      <div className="text-sm text-muted-foreground">
        {pool.messageCount} msg{pool.messageCount !== 1 ? 's' : ''}
      </div>
      <div className="text-xs text-muted-foreground">~{waitSeconds}s wait</div>
      {holdLabel && <div className="text-xs text-muted-foreground mt-1">{holdLabel}</div>}
    </button>
  );
}

export function CurrentPoolsPanel({
  projectId,
  onAgentClick,
  selectedAgentId,
}: CurrentPoolsPanelProps) {
  const { pools, isLoading, error, forceDeferredDelivery, forcingAgentId } =
    useMessagePools(projectId);
  const [forceStatus, setForceStatus] = useState<{ agentId: string; message: string } | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleForceResult = useCallback(
    (result: ForceDeliveryResult, target: ForceDeliveryTarget) => {
      const messages: Record<string, string> = {
        delivered: 'Messages delivered to terminal.',
        unconfirmed: 'Delivery unconfirmed — paste timed out.',
        deferred: 'Still queued — input or context changed.',
        failed: result.reason ?? 'Delivery failed.',
      };
      setForceStatus({ agentId: target.agentId, message: messages[result.status] ?? 'Done.' });
    },
    [],
  );

  const handleForceError = useCallback((err: unknown, target: ForceDeliveryTarget) => {
    let message = 'Request failed.';
    if (err instanceof ForceConflictError) {
      message = 'Queue changed — review and confirm again.';
    } else if (err instanceof Error) {
      message = err.message;
    }
    setForceStatus({ agentId: target.agentId, message });
  }, []);

  const forceConfirm = useForceDeliveryConfirm({
    pools,
    now: nowTick,
    forceDeferredDelivery,
    forcingAgentId,
    onResult: handleForceResult,
    onError: handleForceError,
  });

  const handleOpenForce = (pool: PoolDetails) => {
    if (forceConfirm.open(pool)) setForceStatus(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Current Pools</CardTitle>
        <CardDescription>Messages waiting to be delivered to agents</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading pools...</p>}
        {error instanceof Error && (
          <p className="text-sm text-destructive">Failed to load pools: {error.message}</p>
        )}
        {!isLoading && !error && (
          <div className="flex flex-wrap gap-3">
            {pools?.map((pool) => {
              const eligible = isForceEligible(pool, nowTick);
              const status = forceStatus?.agentId === pool.agentId ? forceStatus.message : null;
              return (
                <div key={pool.agentId} className="flex flex-col gap-1">
                  <PoolCard
                    pool={pool}
                    onClick={() => onAgentClick?.(pool.agentId)}
                    isSelected={selectedAgentId === pool.agentId}
                  />
                  {eligible && (
                    <button
                      type="button"
                      onClick={() => handleOpenForce(pool)}
                      disabled={forcingAgentId === pool.agentId}
                      className="text-xs px-2 py-1 rounded border transition-colors hover:bg-blue-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
                      aria-label={`Send now for ${pool.agentName}`}
                    >
                      {forcingAgentId === pool.agentId ? (
                        <Loader2
                          className="h-3 w-3 animate-spin inline-block mr-1"
                          aria-hidden="true"
                        />
                      ) : null}
                      Send now
                    </button>
                  )}
                  {status && <p className="text-xs text-muted-foreground">{status}</p>}
                </div>
              );
            })}
            {pools?.length === 0 && (
              <p className="text-sm text-muted-foreground">No pending messages</p>
            )}
          </div>
        )}
      </CardContent>
      <ConfirmDialog {...forceConfirm.dialogProps} />
    </Card>
  );
}
