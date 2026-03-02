import { useNavigate } from 'react-router-dom';
import { AlertCircle, Edit, GitBranch, ListChecks, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import EpicPreview from '@/ui/components/shared/EpicPreview';
import { EpicContextMenu } from '@/ui/components/board/EpicContextMenu';
import { EpicCard } from '@/ui/components/board/EpicCard';
import { cn } from '@/ui/lib/utils';
import type { Epic, Status } from './types';

export interface BoardColumnProps {
  status: Status;
  epics: Epic[];
  onAddEpic: (statusId: string) => void;
  onEditEpic: (epic: Epic) => void;
  onDeleteEpic: (epic: Epic) => void;
  onDragStart: (epic: Epic) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (statusId: string) => void;
  isActiveDrop: boolean;
  draggedEpic: Epic | null;
  onKeyboardMove: (epic: Epic, direction: 'left' | 'right') => void;
  onToggleParentFilter: (epic: Epic) => void;
  activeParentId: string | null;
  statusOrder: Status[];
  getAgentName: (agentId: string | null) => string | null;
  onCollapseColumn: (statusId: string) => void;
  onBulkEdit: (epic: Epic) => void;
  onViewDetails: (epic: Epic) => void;
  onMoveToWorktree?: (epic: Epic) => void;
  hasRunningWorktrees?: boolean;
  isLightColor: (hex: string) => boolean;
  getSubEpicCountsByStatus?: (epicId: string) => Record<string, number> | undefined;
}

export function BoardColumn({
  status,
  epics,
  onAddEpic,
  onEditEpic,
  onDeleteEpic,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  isActiveDrop,
  draggedEpic,
  onKeyboardMove,
  onToggleParentFilter,
  activeParentId,
  statusOrder,
  getAgentName,
  onCollapseColumn,
  onBulkEdit,
  onViewDetails,
  onMoveToWorktree,
  hasRunningWorktrees = false,
  isLightColor,
  getSubEpicCountsByStatus,
}: BoardColumnProps) {
  const navigate = useNavigate();

  return (
    <div
      onDragOver={onDragOver}
      onDrop={() => onDrop(status.id)}
      className={cn(
        'flex flex-col bg-muted/30 rounded-lg border transition-colors snap-start',
        (draggedEpic || isActiveDrop) && 'border-primary/50',
        isActiveDrop && 'bg-primary/5',
      )}
      style={{ minWidth: '280px', maxWidth: '480px', flex: '1 1 300px', height: '100%' }}
    >
      <div
        className="flex items-center justify-between p-3 border-b bg-card rounded-t-lg cursor-pointer select-none"
        onDoubleClick={() => onCollapseColumn(status.id)}
        title="Double-click to collapse this column"
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'rounded-full flex items-center justify-center font-medium',
              epics.length === 0 ? 'h-2.5 w-2.5' : 'h-5 w-5 text-[10px]',
            )}
            style={{
              backgroundColor: status.color,
              color:
                epics.length > 0 ? (isLightColor(status.color) ? '#1f2937' : '#ffffff') : undefined,
            }}
          >
            {epics.length > 0 && epics.length}
          </div>
          <h3 className="font-semibold text-sm">{status.label}</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAddEpic(status.id)}
          className="h-7 w-7 p-0"
          aria-label={`Add epic to ${status.label}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
        {epics.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No epics</p>
            <Button
              variant="link"
              size="sm"
              onClick={() => onAddEpic(status.id)}
              className="text-xs mt-1"
            >
              Add first epic
            </Button>
          </div>
        )}
        {epics.map((epic) => (
          <EpicContextMenu
            key={epic.id}
            epic={epic}
            onMoveToWorktree={onMoveToWorktree ?? (() => {})}
            hasRunningWorktrees={hasRunningWorktrees}
          >
            <EpicCard
              epic={epic}
              onEdit={onEditEpic}
              onDelete={onDeleteEpic}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              isDragging={draggedEpic?.id === epic.id}
              onKeyboardMove={onKeyboardMove}
              onToggleParentFilter={onToggleParentFilter}
              isActiveParent={activeParentId === epic.id}
              statuses={statusOrder}
              subEpicCountsByStatus={getSubEpicCountsByStatus?.(epic.id)}
              renderPreview={() => {
                const agentName = getAgentName(epic.agentId);
                const showFilterToggle = epic.parentId === null;
                const showMoveToWorktree =
                  showFilterToggle && hasRunningWorktrees && onMoveToWorktree;
                const actions = (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      aria-label="Open epic details"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/epics/${epic.id}`);
                      }}
                    >
                      <Search className="h-4 w-4" />
                    </Button>
                    {showFilterToggle && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        title="Bulk edit parent and sub-epic status/assignee"
                        aria-label="Bulk edit parent and sub-epics"
                        onClick={(e) => {
                          e.stopPropagation();
                          onBulkEdit(epic);
                        }}
                      >
                        <ListChecks className="h-3 w-3" />
                      </Button>
                    )}
                    {showMoveToWorktree && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        title="Move to worktree"
                        aria-label="Move to worktree"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveToWorktree(epic);
                        }}
                      >
                        <GitBranch className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      aria-label="Edit epic"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditEpic(epic);
                      }}
                    >
                      <Edit className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                      aria-label="Delete epic"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteEpic(epic);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                );
                return (
                  <EpicPreview
                    agentName={agentName}
                    description={epic.description}
                    tags={epic.tags}
                    maxLines={5}
                    metaRight={actions}
                  />
                );
              }}
              statusLabel={status.label}
              statusColor={status.color}
              agentName={getAgentName(epic.agentId)}
              onBulkEdit={(e) => {
                e.stopPropagation();
                onBulkEdit(epic);
              }}
              onViewDetails={(e) => {
                e.stopPropagation();
                onViewDetails(epic);
              }}
              onMoveToWorktree={
                epic.parentId === null && hasRunningWorktrees && onMoveToWorktree
                  ? (e) => {
                      e.stopPropagation();
                      onMoveToWorktree(epic);
                    }
                  : undefined
              }
            />
          </EpicContextMenu>
        ))}
      </div>
    </div>
  );
}
