import {
  forwardRef,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { Link2 } from 'lucide-react';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Button } from '@/ui/components/ui/button';
import { EpicTooltipWrapper } from '@/ui/components/shared/EpicTooltipWrapper';
import { EpicExternalSourceNote } from '@/ui/components/board/EpicExternalSourceNote';
import { EpicRelationBadges } from '@/ui/components/board/EpicRelationBadges';
import { EpicTimeBadge } from '@/ui/components/board/EpicTimeBadge';
import { cn } from '@/ui/lib/utils';
import type { EpicRelationCounts } from '@/ui/hooks/useEpicRelationCountsBatch';
import type { BoardRelationQuickLinkBindings } from '@/ui/hooks/useBoardRelationQuickLink';
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
  /** Estimated-time total in whole minutes; rendered for root epics only. */
  timeTotalMinutes?: number;
  /** Typed relation counts for this Epic; zero types never render. */
  relationCounts?: EpicRelationCounts;
  /** Stored external source; renders the linked-task footer beside the card. */
  source?: ExternalTaskSourceSummary;
  /** Quick-link interaction shared by expanded Kanban cards. */
  relationQuickLink?: BoardRelationQuickLinkBindings;
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
    timeTotalMinutes,
    relationCounts,
    source,
    relationQuickLink,
    ...rest
  },
  ref,
) {
  const relationPointerDownRef = useRef(false);
  const showFilterToggle = epic.parentId === null;
  const isRelationSource = relationQuickLink?.selectionSourceId === epic.id;
  const showRelationTarget =
    relationQuickLink?.selectionSourceId !== null &&
    relationQuickLink?.selectionSourceId !== undefined &&
    !isRelationSource;

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
  const showTimeBadge =
    epic.parentId === null && timeTotalMinutes !== undefined && timeTotalMinutes > 0;
  const hasRelationBadges =
    relationCounts !== undefined &&
    (relationCounts.related > 0 || relationCounts.blocks > 0 || relationCounts.blockedBy > 0);
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
          {relationQuickLink ? (
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isRelationSource && 'bg-primary/10 text-primary',
              )}
              aria-label={`Link ${epic.title} to another epic`}
              aria-pressed={isRelationSource}
              data-testid={`epic-relation-handle-${epic.id}`}
              onPointerDown={(event) => {
                relationPointerDownRef.current = true;
                relationQuickLink.pointerDown(epic, event);
              }}
              onPointerMove={relationQuickLink.pointerMove}
              onPointerUp={(event) => {
                relationQuickLink.pointerUp(event);
                relationPointerDownRef.current = false;
              }}
              onPointerCancel={() => {
                relationPointerDownRef.current = false;
                relationQuickLink.pointerCancel();
              }}
              onLostPointerCapture={() => {
                relationPointerDownRef.current = false;
                relationQuickLink.lostPointerCapture();
              }}
              onClick={(event) => {
                event.stopPropagation();
                relationQuickLink.activate(epic, event.currentTarget);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') relationQuickLink.cancel();
              }}
            >
              <Link2 className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2 text-sm">
        {showRelationTarget && relationQuickLink ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-full"
            onClick={(event) => {
              event.stopPropagation();
              relationQuickLink.selectTarget(epic);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') relationQuickLink.cancel();
            }}
          >
            Link here
          </Button>
        ) : null}
        {renderPreview(totalSubEpicCount)}
        {showFilterToggle && (hasSubEpicSummary || showTimeBadge) ? (
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex min-w-0 flex-wrap gap-2">
              {subEpicSummary.map(({ status, count }) => (
                <div
                  key={status.id}
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                  title={status.label}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: status.color }}
                  />
                  <span className="font-medium text-foreground">{count}</span>
                </div>
              ))}
            </div>
            <div className="ml-auto shrink-0 flex items-center gap-1">
              {hasRelationBadges && relationCounts ? (
                <EpicRelationBadges
                  counts={relationCounts}
                  epicId={epic.id}
                  epicTitle={epic.title}
                  focalProjectId={epic.projectId}
                  dragFenceRef={relationPointerDownRef}
                  isDragging={isDragging}
                />
              ) : null}
              {showTimeBadge ? <EpicTimeBadge minutes={timeTotalMinutes} /> : null}
            </div>
          </div>
        ) : hasRelationBadges && relationCounts ? (
          <div className="pt-1">
            <EpicRelationBadges
              counts={relationCounts}
              epicId={epic.id}
              epicTitle={epic.title}
              focalProjectId={epic.projectId}
              dragFenceRef={relationPointerDownRef}
              isDragging={isDragging}
            />
          </div>
        ) : null}
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

  const handleNativeDragStart = (event: DragEvent<HTMLElement>): void => {
    if (relationPointerDownRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onDragStart(epic);
  };

  const cardRootProps = {
    draggable: true,
    onDragStart: handleNativeDragStart,
    onDragEnd: () => {
      relationPointerDownRef.current = false;
      onDragEnd();
    },
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
