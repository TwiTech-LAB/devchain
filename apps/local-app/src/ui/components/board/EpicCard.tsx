import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { EpicTooltipWrapper } from '@/ui/components/shared/EpicTooltipWrapper';
import { cn } from '@/ui/lib/utils';
import type { Epic, Status } from './types';

export interface EpicCardProps {
  epic: Epic;
  onEdit: (epic: Epic) => void;
  onDelete: (epic: Epic) => void;
  onDragStart: (epic: Epic) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  onKeyboardMove: (epic: Epic, direction: 'left' | 'right') => void;
  onToggleParentFilter: (epic: Epic) => void;
  isActiveParent: boolean;
  statuses: Status[];
  renderPreview?: (subCount?: number) => React.ReactNode;
  statusLabel?: string;
  statusColor?: string;
  agentName?: string | null;
  onBulkEdit?: (e: React.MouseEvent) => void;
  onViewDetails?: (e: React.MouseEvent) => void;
  onMoveToWorktree?: (e: React.MouseEvent) => void;
  subEpicCountsByStatus?: Record<string, number>;
}

export function EpicCard({
  epic,
  onEdit,
  onDelete,
  onDragStart,
  onDragEnd,
  isDragging,
  onKeyboardMove,
  onToggleParentFilter,
  isActiveParent,
  statuses,
  renderPreview = () => null,
  statusLabel,
  statusColor,
  agentName,
  onBulkEdit,
  onViewDetails,
  onMoveToWorktree,
  subEpicCountsByStatus,
}: EpicCardProps) {
  const navigate = useNavigate();
  const showFilterToggle = epic.parentId === null;

  const subEpicSummary = useMemo(
    () =>
      statuses
        .map((status) => ({
          status,
          count: subEpicCountsByStatus?.[status.id] ?? 0,
        }))
        .filter(({ count }) => count > 0),
    [statuses, subEpicCountsByStatus],
  );

  const hasSubEpicSummary = subEpicSummary.length > 0;
  const totalSubEpicCount = subEpicSummary.reduce((sum, entry) => sum + entry.count, 0);

  const handleFilterToggle = (event?: React.MouseEvent) => {
    event?.stopPropagation();
    onToggleParentFilter(epic);
  };

  return (
    <Card
      draggable
      onDragStart={() => onDragStart(epic)}
      onDragEnd={onDragEnd}
      tabIndex={0}
      className={cn(
        'cursor-move transition-all duration-200 hover:shadow-md group',
        isDragging && 'opacity-50 scale-95 shadow-lg',
      )}
      role="button"
      aria-label={`Epic: ${epic.title}. Press Enter to open, arrow keys to move between columns, E to edit, Delete to remove.`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          navigate(`/epics/${epic.id}`);
        } else if (e.key === 'e' || e.key === 'E') {
          e.preventDefault();
          onEdit(epic);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          onDelete(epic);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onKeyboardMove(epic, 'left');
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onKeyboardMove(epic, 'right');
        }
      }}
    >
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            {hasSubEpicSummary && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium flex-shrink-0"
                title="Sub-epics"
              >
                <span className="opacity-70">↳</span>
                {totalSubEpicCount}
              </span>
            )}
            <CardTitle
              className={cn(
                'text-sm font-semibold cursor-pointer truncate',
                showFilterToggle
                  ? isActiveParent
                    ? 'text-primary underline decoration-2'
                    : 'text-primary hover:underline'
                  : 'text-primary hover:underline',
              )}
              data-testid={`epic-title-${epic.id}`}
            >
              <EpicTooltipWrapper
                title={epic.title}
                statusLabel={statusLabel}
                statusColor={statusColor}
                agentName={agentName}
                description={epic.description ?? undefined}
                showFilterToggle={showFilterToggle}
                showBulkEdit={showFilterToggle}
                showOpenDetails
                onBulkEdit={onBulkEdit}
                onMoveToWorktree={onMoveToWorktree}
                onEdit={(e) => {
                  e.stopPropagation();
                  onEdit(epic);
                }}
                onDelete={(e) => {
                  e.stopPropagation();
                  onDelete(epic);
                }}
                onViewDetails={onViewDetails}
                onToggleParentFilter={(e) => {
                  e.stopPropagation();
                  onToggleParentFilter(epic);
                }}
                dynamicSide
                dynamicSideThreshold={360}
                delayDuration={120}
                sideOffset={10}
                contentClassName="w-[340px] max-h-[70vh] overflow-auto space-y-2"
              >
                <button
                  className="truncate text-left w-full"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (showFilterToggle) {
                      handleFilterToggle();
                    } else {
                      navigate(`/epics/${epic.id}`);
                    }
                  }}
                  aria-label={`Open epic ${epic.title}`}
                >
                  {epic.title}
                </button>
              </EpicTooltipWrapper>
            </CardTitle>
          </div>
          {/* Controls moved to preview meta row to free title space */}
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2 text-sm">
        {renderPreview(totalSubEpicCount)}
        {showFilterToggle && hasSubEpicSummary && (
          <div className="flex flex-wrap gap-2 pt-1">
            {subEpicSummary.map(({ status, count }) => (
              <div
                key={status.id}
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title={status.label}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />
                <span className="font-medium text-foreground">{count}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
