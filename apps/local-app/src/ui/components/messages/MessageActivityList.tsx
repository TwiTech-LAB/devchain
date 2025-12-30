import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { cn } from '@/ui/lib/utils';

/** Message log preview from the list API (truncated content) */
export interface MessageLogPreview {
  id: string;
  timestamp: number;
  projectId: string;
  agentId: string;
  agentName: string;
  /** First 100 characters of message text */
  preview: string;
  source: string;
  senderAgentId?: string;
  status: 'queued' | 'delivered' | 'failed';
  batchId?: string;
  deliveredAt?: number;
  error?: string;
  immediate: boolean;
}

/** Full message log entry (from detail API) */
export interface MessageLogEntry extends Omit<MessageLogPreview, 'preview'> {
  /** Full message text content */
  text: string;
}

interface MessagesResponse {
  messages: MessageLogPreview[];
  total: number;
}

export interface MessageFilters {
  status?: 'queued' | 'delivered' | 'failed';
  agentId?: string;
  source?: string;
}

interface MessageActivityListProps {
  projectId: string;
  filters?: MessageFilters;
  onMessageClick?: (message: MessageLogPreview) => void;
}

interface MessageGroup {
  batchId?: string;
  messages: MessageLogPreview[];
  status: 'queued' | 'delivered' | 'failed';
  timestamp: number;
  agentName: string;
}

async function fetchMessages(
  projectId: string,
  filters?: MessageFilters,
): Promise<MessagesResponse> {
  const params = new URLSearchParams({ projectId });
  if (filters?.status) params.set('status', filters.status);
  if (filters?.agentId) params.set('agentId', filters.agentId);
  if (filters?.source) params.set('source', filters.source);

  const res = await fetch(`/api/sessions/messages?${params.toString()}`);
  if (!res.ok) {
    throw new Error('Failed to fetch messages');
  }
  return res.json();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function groupByBatch(messages: MessageLogPreview[] = []): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const batchMap = new Map<string, MessageLogPreview[]>();

  // First pass: group messages with batchId
  for (const msg of messages) {
    if (msg.batchId) {
      const existing = batchMap.get(msg.batchId) || [];
      existing.push(msg);
      batchMap.set(msg.batchId, existing);
    } else {
      // Single message (no batch)
      groups.push({
        batchId: undefined,
        messages: [msg],
        status: msg.status,
        timestamp: msg.timestamp,
        agentName: msg.agentName,
      });
    }
  }

  // Second pass: add batched groups
  for (const [batchId, batchMessages] of batchMap) {
    const sorted = batchMessages.sort((a, b) => a.timestamp - b.timestamp);
    groups.push({
      batchId,
      messages: sorted,
      status: sorted[0].status,
      timestamp: sorted[0].timestamp,
      agentName: sorted[0].agentName,
    });
  }

  // Sort all groups by timestamp (newest first)
  return groups.sort((a, b) => b.timestamp - a.timestamp);
}

interface StatusBadgeProps {
  status: 'queued' | 'delivered' | 'failed';
}

function StatusBadge({ status }: StatusBadgeProps) {
  const variants = {
    queued: 'bg-muted text-muted-foreground',
    delivered: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/40',
    failed: 'bg-destructive/10 text-destructive border-destructive/40',
  };

  return (
    <Badge variant="outline" className={cn('text-xs uppercase', variants[status])}>
      {status}
    </Badge>
  );
}

interface MessageRowProps {
  message: MessageLogPreview;
  onClick: () => void;
}

function MessageRow({ message, onClick }: MessageRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left pl-4 py-1 rounded text-sm transition-colors',
        'hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      aria-label={`Message from ${message.source}: ${truncate(message.preview, 50)}`}
    >
      <span className="text-muted-foreground">[{message.source}]</span>{' '}
      <span>{truncate(message.preview, 80)}</span>
      {message.error && <div className="text-destructive text-xs mt-1">Error: {message.error}</div>}
    </button>
  );
}

interface BatchGroupProps {
  group: MessageGroup;
  onMessageClick: (message: MessageLogPreview) => void;
}

function BatchGroup({ group, onMessageClick }: BatchGroupProps) {
  const isBatch = group.messages.length > 1;

  return (
    <div className="border-b py-2 last:border-b-0">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={group.status} />
        <span className="text-sm text-muted-foreground">{formatTime(group.timestamp)}</span>
        {isBatch && (
          <Badge variant="outline" className="text-xs">
            batch of {group.messages.length}
          </Badge>
        )}
        <span className="ml-auto text-sm">→ {group.agentName}</span>
      </div>
      <div className="mt-1 space-y-1">
        {group.messages.map((msg) => (
          <MessageRow key={msg.id} message={msg} onClick={() => onMessageClick(msg)} />
        ))}
      </div>
    </div>
  );
}

export function MessageActivityList({
  projectId,
  filters,
  onMessageClick,
}: MessageActivityListProps) {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['messages', projectId, filters],
    queryFn: () => fetchMessages(projectId, filters),
    refetchInterval: 10000, // Poll every 10 seconds as fallback
    staleTime: 2000,
  });

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!envelope) return;
      const { topic } = envelope;
      if (topic === 'messages/activity') {
        queryClient.invalidateQueries({ queryKey: ['messages', projectId] });
      }
    },
    [queryClient, projectId],
  );

  useAppSocket({ message: handleEnvelope }, [handleEnvelope]);

  const groupedMessages = useMemo(() => groupByBatch(data?.messages), [data?.messages]);

  const handleMessageClick = useCallback(
    (message: MessageLogPreview) => {
      onMessageClick?.(message);
    },
    [onMessageClick],
  );

  const filterDescription = useMemo(() => {
    const parts: string[] = [];
    if (filters?.agentId) parts.push('filtered by agent');
    if (filters?.status) parts.push(`status: ${filters.status}`);
    if (filters?.source) parts.push(`source: ${filters.source}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  }, [filters]);

  return (
    <Card className="flex-1 flex flex-col min-h-0">
      <CardHeader className="flex-shrink-0">
        <CardTitle>Activity Log</CardTitle>
        <CardDescription>
          Recent message delivery history{filterDescription}
          {data && ` • ${data.total} total`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        {isLoading && <p className="text-sm text-muted-foreground">Loading messages...</p>}
        {error instanceof Error && (
          <p className="text-sm text-destructive">Failed to load messages: {error.message}</p>
        )}
        {!isLoading && !error && (
          <ScrollArea className="h-full">
            {groupedMessages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages found</p>
            ) : (
              <div className="space-y-0 pr-4">
                {groupedMessages.map((group) => (
                  <BatchGroup
                    key={group.batchId || group.messages[0].id}
                    group={group}
                    onMessageClick={handleMessageClick}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
