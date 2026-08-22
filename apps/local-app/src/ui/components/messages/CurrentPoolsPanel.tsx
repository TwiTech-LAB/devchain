import { useMessagePools, type PoolDetails } from '@/ui/hooks/chat/useMessagePools';
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
      aria-label={`${pool.agentName}: ${pool.messageCount} message${pool.messageCount !== 1 ? 's' : ''}, waiting ${waitSeconds} seconds`}
    >
      <div className="font-medium">{pool.agentName}</div>
      <div className="text-sm text-muted-foreground">
        {pool.messageCount} msg{pool.messageCount !== 1 ? 's' : ''}
      </div>
      <div className="text-xs text-muted-foreground">~{waitSeconds}s wait</div>
    </button>
  );
}

export function CurrentPoolsPanel({
  projectId,
  onAgentClick,
  selectedAgentId,
}: CurrentPoolsPanelProps) {
  const { pools, isLoading, error } = useMessagePools(projectId);

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
            {pools?.map((pool) => (
              <PoolCard
                key={pool.agentId}
                pool={pool}
                onClick={() => onAgentClick?.(pool.agentId)}
                isSelected={selectedAgentId === pool.agentId}
              />
            ))}
            {pools?.length === 0 && (
              <p className="text-sm text-muted-foreground">No pending messages</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
