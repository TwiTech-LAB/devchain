import { forwardRef, useMemo, type ComponentPropsWithoutRef, type KeyboardEvent } from 'react';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { EpicTooltipWrapper } from '@/ui/components/shared/EpicTooltipWrapper';
import { EpicExternalSourceNote } from '@/ui/components/board/EpicExternalSourceNote';
import { cn } from '@/ui/lib/utils';
import type { Epic, Status } from './types';

export interface EpicCardProps
  extends Omit<ComponentPropsWithoutRef<'div'>, 'onDragStart' | 'onDragEnd' | 'children'> {
  epic: Epic;
  onEdit: (epic: Epic) => void;
  onDelete: (epic: Epic) => void;
  onDragStart: (epic: Epic) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  onKeyboardMove: (epic: Epic, direction: 'left' | 'right') => void;
  onToggleParentFilter: (epic: Epic) => void;
  isActiveParent: boolean;
  onOpenEpicDetails: (epic: Epic) => void;
  statuses: Status[];
  renderPreview?: (subCount?: number) => React.ReactNode;
  statusLabel?: string;
  statusColor?: string;
  agentName?: string | null;
  onBulkEdit?: (e: React.MouseEvent) => void;
  onMoveToWorktree?: (e: React.MouseEvent) => void;
  subEpicCountsByStatus?: Record<string, number>;
  /** Stored external source; renders the linked-task footer beside the card. */
  source?: ExternalTaskSourceSummary;
}

/**
 * Root shortcuts run only for direct card interaction: descendants (title
 * button, source link, tooltip actions) own their keys, so the group never
 * double-handles a nested Enter or arrow.
 */
function isDirectCardEvent(event: KeyboardEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget;
}

export const EpicCard = forwardRef<HTMLDivElement, EpicCardProps>(function EpicCard(
  {
    epic,
    onEdit,
    onDelete,
    onDragStart,
    onDragEnd,
    isDragging,
    onKeyboardMove,
    onToggleParentFilter,
    isActiveParent,
    onOpenEpicDetails,
    statuses,
    renderPreview = () => null,
    statusLabel,
    statusColor,
    agentName,
    onBulkEdit,
    onMoveToWorktree,
    subEpicCountsByStatus,
    source,
    ...rest
  },
  ref,
) {
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
  const titleClassName =
    showFilterToggle && isActiveParent
      ? 'text-primary underline decoration-2'
      : 'text-primary hover:underline';

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isDirectCardEvent(event)) return;
    if (event.key === 'Enter') {
      onOpenEpicDetails(epic);
    } else if (event.key === 'e' || event.key === 'E') {
      event.preventDefault();
      onEdit(epic);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onDelete(epic);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onKeyboardMove(epic, 'left');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onKeyboardMove(epic, 'right');
    }
  };

  const ariaLabel = `Epic: ${epic.title}. Press Enter to open, arrow keys to move between columns, E to edit, Delete to remove.`;

  const cardChildren = (
    <>
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
              className={cn('text-sm font-semibold cursor-pointer truncate', titleClassName)}
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
                onViewDetails={(e) => {
                  e.stopPropagation();
                  onOpenEpicDetails(epic);
                }}
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
                      onToggleParentFilter(epic);
                    } else {
                      onOpenEpicDetails(epic);
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
    </>
  );

  const cardClassName = cn(
    'cursor-move transition-all duration-200 hover:shadow-md group',
    !source && isDragging && 'opacity-50 scale-95 shadow-lg',
    // The wrapper carries the joined border for sourced cards; the card keeps
    // its top corners only.
    source && 'rounded-b-none border-b-0',
  );

  const cardRootProps = {
    draggable: true,
    onDragStart: () => onDragStart(epic),
    onDragEnd,
    tabIndex: 0,
    role: 'group' as const,
    'aria-label': ariaLabel,
    onKeyDown: handleKeyDown,
    className: cardClassName,
  };

  if (!source) {
    return (
      <Card ref={ref} {...rest} {...cardRootProps}>
        {cardChildren}
      </Card>
    );
  }

  // Sourced card: one neutral wrapper (the Radix context-menu trigger target)
  // with the draggable group and the source footer as siblings. Drag visuals
  // apply to the complete card so the footer never detaches from it.
  return (
    <div
      ref={ref}
      {...rest}
      className={cn('transition-all duration-200', isDragging && 'opacity-50 scale-95 shadow-lg')}
    >
      <Card {...cardRootProps}>{cardChildren}</Card>
      <EpicExternalSourceNote source={source} epicId={epic.id} />
    </div>
  );
});
