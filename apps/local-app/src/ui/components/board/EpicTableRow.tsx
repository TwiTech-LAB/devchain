import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MoreHorizontal, Loader2 } from 'lucide-react';
import { TableCell, TableRow } from '@/ui/components/ui/table';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { cn } from '@/ui/lib/utils';
import { EpicTooltipWrapper } from '@/ui/components/shared/EpicTooltipWrapper';
import { InlineStatusSelect } from './InlineStatusSelect';
import { InlineAgentSelect } from './InlineAgentSelect';
import type { Epic, Status, Agent } from './types';

/** Response shape from sub-epics API */
interface SubEpicsResponse {
  items: Epic[];
  total?: number;
}

/**
 * Fetch sub-epics for a parent epic.
 * Note: This function is called lazily by React Query only when a parent epic row is expanded.
 * Results are cached for 30 seconds (staleTime) to prevent duplicate fetches.
 */
async function fetchSubEpics(parentId: string): Promise<SubEpicsResponse> {
  const res = await fetch(`/api/epics?parentId=${encodeURIComponent(parentId)}`);
  if (!res.ok) throw new Error('Failed to fetch sub-epics');
  return res.json();
}

export interface EpicTableRowProps {
  /** The epic to display */
  epic: Epic;
  /** Available statuses for display */
  statuses: Status[];
  /** Available agents for display */
  agents: Agent[];
  /** Precomputed status lookup map (optimization - avoids Map creation per row) */
  statusMap?: Map<string, Status>;
  /** Precomputed agent lookup map (optimization - avoids Map creation per row) */
  agentMap?: Map<string, Agent>;
  /** Whether this row is currently expanded (controlled) */
  isExpanded?: boolean;
  /** Callback when expand/collapse is toggled */
  onToggleExpand?: (epicId: string) => void;
  /** Set of selected epic IDs (for checking selection state) */
  selectedEpics?: Set<string>;
  /** Callback when selection is toggled */
  onToggleSelect?: (epicId: string) => void;
  /** Handler when an epic is clicked for editing */
  onEditEpic?: (epic: Epic) => void;
  /** Handler when delete is clicked */
  onDeleteEpic?: (epic: Epic) => void;
  /** Handler for viewing epic details (navigate to epic page) */
  onViewDetails?: (epic: Epic) => void;
  /** Handler for bulk edit (parent epics only) */
  onBulkEdit?: (epic: Epic) => void;
  /** Handler for toggling parent filter (parent epics only) */
  onToggleParentFilter?: (epic: Epic) => void;
  /** Handler when status changes (inline editing) */
  onStatusChange?: (epic: Epic, statusId: string) => Promise<void> | void;
  /** Handler when agent changes (inline editing) */
  onAgentChange?: (epic: Epic, agentId: string | null) => Promise<void> | void;
  /** Depth level for indentation (0 = root, 1 = sub-epic, etc.) */
  depth?: number;
  /** Whether this is a sub-epic row (for styling) */
  isSubEpic?: boolean;
}

/**
 * EpicTableRow - A table row for displaying an epic with expandable sub-epics
 *
 * Features:
 * - Expand/collapse chevron for parent epics
 * - Lazy-loads sub-epics when expanded
 * - Sub-epic rows shown with indentation and muted background
 * - Keyboard accessible (Enter/Space to toggle)
 */
export function EpicTableRow({
  epic,
  statuses,
  agents,
  statusMap: statusMapProp,
  agentMap: agentMapProp,
  isExpanded = false,
  onToggleExpand,
  selectedEpics,
  onToggleSelect,
  onEditEpic,
  onDeleteEpic,
  onViewDetails,
  onBulkEdit,
  onToggleParentFilter,
  onStatusChange,
  onAgentChange,
  depth = 0,
  isSubEpic = false,
}: EpicTableRowProps) {
  // Check if this epic is selected
  const isSelected = selectedEpics?.has(epic.id) ?? false;
  // Internal expanded state if not controlled
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = onToggleExpand ? isExpanded : internalExpanded;
  // Loading states for inline editing
  const [statusLoading, setStatusLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);

  // Use precomputed maps if provided, otherwise create them (fallback for sub-epics)
  const statusMap = statusMapProp ?? new Map(statuses.map((s) => [s.id, s]));
  const agentMap = agentMapProp ?? new Map(agents.map((a) => [a.id, a]));

  const getStatusLabel = (statusId: string) => {
    const status = statusMap.get(statusId);
    return status?.label ?? 'Unknown';
  };

  const getStatusColor = (statusId: string) => {
    const status = statusMap.get(statusId);
    return status?.color ?? '#6b7280';
  };

  const getAgentName = (agentId: string | null) => {
    if (!agentId) return null;
    return agentMap.get(agentId)?.name ?? null;
  };

  // Only parent epics (parentId === null) can be expanded
  const isParentEpic = epic.parentId === null;

  // Lazy-load sub-epics only when expanded.
  // Fetch triggers: when isParentEpic && expanded becomes true (user clicks expand chevron).
  // Caching: React Query caches results by ['sub-epics', epic.id] for 30s (staleTime),
  // preventing duplicate fetches when collapsing/re-expanding the same row.
  const {
    data: subEpicsData,
    isLoading: subEpicsLoading,
    isError: subEpicsError,
  } = useQuery({
    queryKey: ['sub-epics', epic.id],
    queryFn: () => fetchSubEpics(epic.id),
    enabled: isParentEpic && expanded,
    staleTime: 30000,
  });

  const subEpics = subEpicsData?.items ?? [];

  const handleToggleExpand = useCallback(() => {
    if (onToggleExpand) {
      onToggleExpand(epic.id);
    } else {
      setInternalExpanded((prev) => !prev);
    }
  }, [epic.id, onToggleExpand]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleToggleExpand();
      }
    },
    [handleToggleExpand],
  );

  // Handle inline status change
  const handleStatusChange = useCallback(
    async (statusId: string) => {
      if (!onStatusChange || statusId === epic.statusId) return;
      setStatusLoading(true);
      try {
        await onStatusChange(epic, statusId);
      } finally {
        setStatusLoading(false);
      }
    },
    [epic, onStatusChange],
  );

  // Handle inline agent change
  const handleAgentChange = useCallback(
    async (agentId: string | null) => {
      if (!onAgentChange || agentId === epic.agentId) return;
      setAgentLoading(true);
      try {
        await onAgentChange(epic, agentId);
      } finally {
        setAgentLoading(false);
      }
    },
    [epic, onAgentChange],
  );

  const agentName = getAgentName(epic.agentId);

  return (
    <>
      {/* Main row */}
      <TableRow className={cn(isSubEpic && 'bg-muted/20')}>
        {/* Selection checkbox */}
        <TableCell>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect?.(epic.id)}
            aria-label={`Select ${epic.title}`}
          />
        </TableCell>

        {/* Expand/collapse toggle */}
        <TableCell>
          {isParentEpic && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleToggleExpand}
              onKeyDown={handleKeyDown}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse sub-epics' : 'Expand sub-epics'}
            >
              {subEpicsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ChevronRight
                  className={cn(
                    'h-4 w-4 transition-transform duration-200',
                    expanded && 'rotate-90',
                  )}
                />
              )}
            </Button>
          )}
        </TableCell>

        {/* Title with indentation for sub-epics and tooltip */}
        <TableCell className="font-medium">
          <div className="flex items-center gap-1">
            {/* Indentation and visual hierarchy indicator for sub-epics */}
            {isSubEpic && (
              <span
                className="text-muted-foreground select-none"
                style={{ paddingLeft: `${(depth - 1) * 16}px` }}
              >
                └─
              </span>
            )}
            <EpicTooltipWrapper
              title={epic.title}
              statusLabel={getStatusLabel(epic.statusId)}
              statusColor={getStatusColor(epic.statusId)}
              agentName={agentName ?? undefined}
              description={epic.description ?? undefined}
              showFilterToggle={isParentEpic && !!onToggleParentFilter}
              showBulkEdit={isParentEpic && !!onBulkEdit}
              showOpenDetails={!!onViewDetails}
              onEdit={
                onEditEpic
                  ? (e) => {
                      e.stopPropagation();
                      onEditEpic(epic);
                    }
                  : undefined
              }
              onDelete={
                onDeleteEpic
                  ? (e) => {
                      e.stopPropagation();
                      onDeleteEpic(epic);
                    }
                  : undefined
              }
              onViewDetails={onViewDetails ? () => onViewDetails(epic) : undefined}
              onBulkEdit={onBulkEdit ? () => onBulkEdit(epic) : undefined}
              onToggleParentFilter={
                onToggleParentFilter
                  ? (e) => {
                      e.stopPropagation();
                      onToggleParentFilter(epic);
                    }
                  : undefined
              }
              dynamicSide
              dynamicSideThreshold={360}
              delayDuration={200}
              sideOffset={8}
              contentClassName="w-[340px] max-h-[70vh] overflow-auto space-y-2"
            >
              <button
                type="button"
                className="text-left hover:underline focus:outline-none focus:underline cursor-pointer"
                onClick={() => onEditEpic?.(epic)}
              >
                {epic.title}
              </button>
            </EpicTooltipWrapper>
          </div>
        </TableCell>

        {/* Status - Inline editable */}
        <TableCell onClick={(e) => e.stopPropagation()}>
          <InlineStatusSelect
            value={epic.statusId}
            statuses={statuses.map((s) => ({ id: s.id, label: s.label, color: s.color }))}
            onChange={handleStatusChange}
            loading={statusLoading}
            disabled={!onStatusChange}
          />
        </TableCell>

        {/* Agent - Inline editable */}
        <TableCell onClick={(e) => e.stopPropagation()}>
          <InlineAgentSelect
            value={epic.agentId}
            agents={agents.map((a) => ({ id: a.id, name: a.name }))}
            onChange={handleAgentChange}
            loading={agentLoading}
            disabled={!onAgentChange}
          />
        </TableCell>

        {/* Tags */}
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {epic.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
            {epic.tags.length > 3 && (
              <Badge variant="secondary" className="text-xs">
                +{epic.tags.length - 3}
              </Badge>
            )}
          </div>
        </TableCell>

        {/* Actions */}
        <TableCell>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="More actions"
            onClick={() => onEditEpic?.(epic)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </TableCell>
      </TableRow>

      {/* Sub-epic rows (rendered when expanded) */}
      {expanded && isParentEpic && (
        <>
          {subEpicsLoading && (
            <TableRow className="bg-muted/20">
              <TableCell colSpan={7} className="py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground pl-8">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading sub-epics...
                </div>
              </TableCell>
            </TableRow>
          )}

          {subEpicsError && (
            <TableRow className="bg-muted/20">
              <TableCell colSpan={7} className="py-3">
                <div className="text-sm text-destructive pl-8">Failed to load sub-epics</div>
              </TableCell>
            </TableRow>
          )}

          {!subEpicsLoading && !subEpicsError && subEpics.length === 0 && (
            <TableRow className="bg-muted/20">
              <TableCell colSpan={7} className="py-3">
                <div className="text-sm text-muted-foreground pl-8">No sub-epics</div>
              </TableCell>
            </TableRow>
          )}

          {!subEpicsLoading &&
            !subEpicsError &&
            subEpics.map((subEpic) => (
              <EpicTableRow
                key={subEpic.id}
                epic={subEpic}
                statuses={statuses}
                agents={agents}
                statusMap={statusMap}
                agentMap={agentMap}
                selectedEpics={selectedEpics}
                onToggleSelect={onToggleSelect}
                onEditEpic={onEditEpic}
                onDeleteEpic={onDeleteEpic}
                onViewDetails={onViewDetails}
                onStatusChange={onStatusChange}
                onAgentChange={onAgentChange}
                depth={depth + 1}
                isSubEpic
              />
            ))}
        </>
      )}
    </>
  );
}
