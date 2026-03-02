import { EpicTooltipWrapper } from '@/ui/components/shared/EpicTooltipWrapper';
import { cn } from '@/ui/lib/utils';
import { getMergedWorktree, isMergedTag } from '@/ui/lib/epic-tags';
import type { Epic, Status } from './types';

export interface CollapsedColumnProps {
  status: Status;
  count: number;
  epics: Epic[];
  subEpicCounts?: Record<string, number>;
  onExpand: () => void;
  onAddEpic: (statusId: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  isActiveDrop: boolean;
  onDragStartEpic: (epic: Epic) => void;
  onDragEndEpic: () => void;
  getAgentName: (agentId: string | null) => string | null;
  onEpicEdit: (epic: Epic) => void;
  onEpicDelete: (epic: Epic) => void;
  onEpicBulkEdit: (epic: Epic) => void;
  onEpicViewDetails: (epic: Epic) => void;
  onEpicToggleParentFilter: (epic: Epic) => void;
  isLightColor: (hex: string) => boolean;
}

export function CollapsedColumn({
  status,
  count,
  epics,
  subEpicCounts,
  onExpand,
  onAddEpic,
  onDragOver,
  onDrop,
  isActiveDrop,
  onDragStartEpic,
  onDragEndEpic,
  getAgentName,
  onEpicEdit,
  onEpicDelete,
  onEpicBulkEdit,
  onEpicViewDetails,
  onEpicToggleParentFilter,
  isLightColor,
}: CollapsedColumnProps) {
  return (
    <button
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onExpand();
        } else if (e.key === '+') {
          e.preventDefault();
          onAddEpic(status.id);
        }
      }}
      className={cn(
        'flex flex-col items-start gap-1.5 p-2 rounded-lg border bg-muted/20',
        'hover:bg-muted/40 transition-colors cursor-pointer',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        'snap-start w-[160px] flex-shrink-0',
        isActiveDrop && 'border-primary/60 bg-primary/5',
      )}
      style={{ height: '100%' }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      aria-label={`${status.label} column (${count} epic${count !== 1 ? 's' : ''}). Press Enter or Space to expand, + to add epic.`}
      tabIndex={0}
    >
      <div className="flex items-center gap-1.5">
        <div
          className={cn(
            'rounded-full flex-shrink-0 flex items-center justify-center font-medium',
            count === 0 ? 'h-2.5 w-2.5' : 'h-5 w-5 text-[10px]',
          )}
          style={{
            backgroundColor: status.color,
            color: count > 0 ? (isLightColor(status.color) ? '#1f2937' : '#ffffff') : undefined,
          }}
        >
          {count > 0 && count}
        </div>
        <span className="text-xs font-medium">{status.label}</span>
      </div>
      {epics.length > 0 && (
        <div className="w-full flex-1 space-y-1 text-left overflow-y-auto min-h-0">
          {epics.map((epic) => {
            const mergedFromWorktree = getMergedWorktree(epic.tags ?? []);
            const visibleTags = (epic.tags ?? []).filter((tag) => !isMergedTag(tag));

            return (
              <div
                key={epic.id}
                className="truncate rounded border bg-background px-2 py-1 text-xs text-foreground"
                draggable
                onDragStart={() => onDragStartEpic(epic)}
                onDragEnd={onDragEndEpic}
              >
                <EpicTooltipWrapper
                  title={epic.title || 'Untitled'}
                  statusLabel={status.label}
                  statusColor={status.color}
                  agentName={getAgentName(epic.agentId)}
                  description={epic.description ?? undefined}
                  showFilterToggle={epic.parentId === null}
                  showBulkEdit={epic.parentId === null}
                  showOpenDetails
                  onBulkEdit={(e) => {
                    e.stopPropagation();
                    onEpicBulkEdit(epic);
                  }}
                  onEdit={(e) => {
                    e.stopPropagation();
                    onEpicEdit(epic);
                  }}
                  onDelete={(e) => {
                    e.stopPropagation();
                    onEpicDelete(epic);
                  }}
                  onViewDetails={(e) => {
                    e.stopPropagation();
                    onEpicViewDetails(epic);
                  }}
                  onToggleParentFilter={(e) => {
                    e.stopPropagation();
                    onEpicToggleParentFilter(epic);
                  }}
                  dynamicSide
                  dynamicSideThreshold={360}
                  delayDuration={100}
                  sideOffset={10}
                  contentClassName="w-[340px] max-h-[70vh] overflow-auto space-y-2"
                >
                  <div className="truncate font-semibold cursor-pointer">
                    {epic.title || 'Untitled'}
                  </div>
                </EpicTooltipWrapper>
                {((subEpicCounts?.[epic.id] ?? 0) > 0 || (epic.tags && epic.tags.length > 0)) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {mergedFromWorktree && (
                      <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
                        Merged from {mergedFromWorktree}
                      </span>
                    )}
                    {visibleTags.slice(0, 2).map((tag) => (
                      <span
                        key={`${epic.id}-${tag}`}
                        className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                        title={tag}
                      >
                        {tag}
                      </span>
                    ))}
                    {visibleTags.length > 2 && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        +{visibleTags.length - 2}
                      </span>
                    )}
                    {(subEpicCounts?.[epic.id] ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        <span className="opacity-60">↳</span>
                        {subEpicCounts?.[epic.id]}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </button>
  );
}
