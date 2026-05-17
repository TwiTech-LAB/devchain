import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import {
  type RealtimeInvalidationRegistry,
  dispatchRealtimeEnvelope,
  exactTopic,
} from '@/ui/lib/realtime-invalidation-registry';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { cn } from '@/ui/lib/utils';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

/** Pool details from the API */
export interface PoolDetails {
  agentId: string;
  agentName: string;
  projectId: string;
  messageCount: number;
  waitingMs: number;
  messages: Array<{
    id: string;
    preview: string;
    source: string;
    timestamp: number;
  }>;
}

interface PoolsResponse {
  pools: PoolDetails[];
}

interface CurrentPoolsPanelProps {
  projectId: string;
  onAgentClick?: (agentId: string) => void;
  selectedAgentId?: string;
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
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();

  const {
    data: pools,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['pools', projectId],
    queryFn: () => fetchPools(projectId, apiFetch),
    refetchInterval: 5000, // Poll every 5 seconds as fallback
    staleTime: 1000,
  });

  const poolsRegistry: RealtimeInvalidationRegistry = useMemo(
    () => [
      {
        match: exactTopic('messages/pools'),
        type: 'updated',
        entries: [{ kind: 'invalidate' as const, queryKey: ['pools', projectId] }],
      },
    ],
    [projectId],
  );

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      dispatchRealtimeEnvelope(envelope, poolsRegistry, queryClient);
    },
    [poolsRegistry, queryClient],
  );

  useAppSocket({ message: handleEnvelope }, [handleEnvelope]);

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
