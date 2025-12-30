import { useQuery } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Button } from '@/ui/components/ui/button';
import { X } from 'lucide-react';
import type { MessageFilters } from './MessageActivityList';

interface Agent {
  id: string;
  name: string;
}

interface MessageFiltersPanelProps {
  projectId: string;
  filters: MessageFilters;
  onChange: (filters: MessageFilters) => void;
}

const KNOWN_SOURCES = [
  { value: 'epic.assigned', label: 'Epic Assignment' },
  { value: 'chat.message', label: 'Chat Message' },
  { value: 'mcp.send_message', label: 'MCP Tool Call' },
  { value: 'subscriber.action', label: 'Subscriber Action' },
  { value: 'pool.failure_notice', label: 'Failure Notice' },
];

async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

function hasActiveFilters(filters: MessageFilters): boolean {
  return !!(filters.status || filters.agentId || filters.source);
}

export function MessageFiltersPanel({ projectId, filters, onChange }: MessageFiltersPanelProps) {
  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => fetchAgents(projectId),
    enabled: !!projectId,
    staleTime: 30000,
  });

  const agents = agentsData?.items ?? [];

  const handleStatusChange = (value: string) => {
    onChange({
      ...filters,
      status: value === 'all' ? undefined : (value as MessageFilters['status']),
    });
  };

  const handleAgentChange = (value: string) => {
    onChange({
      ...filters,
      agentId: value === 'all' ? undefined : value,
    });
  };

  const handleSourceChange = (value: string) => {
    onChange({
      ...filters,
      source: value === 'all' ? undefined : value,
    });
  };

  const handleClear = () => {
    onChange({});
  };

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* Status Filter */}
      <Select value={filters.status || 'all'} onValueChange={handleStatusChange}>
        <SelectTrigger className="w-32" aria-label="Filter by status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="queued">Queued</SelectItem>
          <SelectItem value="delivered">Delivered</SelectItem>
          <SelectItem value="failed">Failed</SelectItem>
        </SelectContent>
      </Select>

      {/* Agent Filter */}
      <Select value={filters.agentId || 'all'} onValueChange={handleAgentChange}>
        <SelectTrigger className="w-40" aria-label="Filter by agent">
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Agents</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Source Filter */}
      <Select value={filters.source || 'all'} onValueChange={handleSourceChange}>
        <SelectTrigger className="w-44" aria-label="Filter by source">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Sources</SelectItem>
          {KNOWN_SOURCES.map((source) => (
            <SelectItem key={source.value} value={source.value}>
              {source.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear Filters */}
      {hasActiveFilters(filters) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClear}
          className="gap-1"
          aria-label="Clear all filters"
        >
          <X className="h-4 w-4" />
          Clear
        </Button>
      )}
    </div>
  );
}
