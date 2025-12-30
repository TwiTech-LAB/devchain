import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import EpicPreview from '@/ui/components/shared/EpicPreview';
import { EpicTooltipWrapper } from '@/ui/components/shared/EpicTooltipWrapper';
import { BoardListView } from '@/ui/components/board/BoardListView';
import { SavedFiltersSelect } from '@/ui/components/board/SavedFiltersSelect';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Switch } from '@/ui/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { useToast } from '@/ui/hooks/use-toast';
import {
  Plus,
  Edit,
  Trash2,
  AlertCircle,
  FolderOpen,
  Settings2,
  Search,
  ListChecks,
  Loader2,
  LayoutGrid,
  List,
  Filter,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useBoardFilters } from '@/ui/hooks/useBoardFilters';
import {
  parseBoardFilters,
  serializeBoardFilters,
  type BoardFilterParams,
} from '@/ui/lib/url-filters';
import type { Epic, Status, Agent, EpicsQueryData } from '@/ui/components/board/types';

// Helper to determine if a hex color is light (returns true) or dark (returns false)
function isLightColor(hex: string): boolean {
  const color = hex.replace('#', '');
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);
  // Using relative luminance formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

type BulkRow = {
  epic: Epic;
  statusId: string;
  agentId: string | null;
};

interface BoardViewPreferences {
  collapsedStatusIds: string[];
  autoCollapseEmpty: boolean;
  explicitlyExpandedStatusIds: string[];
  viewMode: 'kanban' | 'list';
  listPageSize: number;
}

type EpicEventPayload = {
  epic?: { parentId?: string | null } | null;
  parentId?: string | null;
};

const BOARD_PREFS_KEY_PREFIX = 'devchain:board:columns:';

function getBoardPreferences(projectId: string): BoardViewPreferences {
  const key = `${BOARD_PREFS_KEY_PREFIX}${projectId}`;
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      // Ensure all fields exist for backward compatibility with older stored prefs
      return {
        collapsedStatusIds: parsed.collapsedStatusIds || [],
        autoCollapseEmpty: parsed.autoCollapseEmpty ?? true,
        explicitlyExpandedStatusIds: parsed.explicitlyExpandedStatusIds || [],
        viewMode: parsed.viewMode === 'list' ? 'list' : 'kanban',
        listPageSize: typeof parsed.listPageSize === 'number' ? parsed.listPageSize : 25,
      };
    } catch {
      // Fall through to defaults
    }
  }
  return {
    collapsedStatusIds: [],
    autoCollapseEmpty: true,
    explicitlyExpandedStatusIds: [],
    viewMode: 'kanban',
    listPageSize: 25,
  };
}

function saveBoardPreferences(projectId: string, prefs: BoardViewPreferences): void {
  const key = `${BOARD_PREFS_KEY_PREFIX}${projectId}`;
  localStorage.setItem(key, JSON.stringify(prefs));
}

async function fetchStatuses(projectId: string) {
  const res = await fetch(`/api/statuses?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch statuses');
  return res.json();
}

async function fetchEpics(projectId: string, archived: 'active' | 'archived' | 'all' = 'active') {
  // Board: fetch a larger page of epics based on archived filter
  const params = new URLSearchParams({ projectId, limit: '1000', type: archived });
  const res = await fetch(`/api/epics?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch epics');
  return res.json();
}

async function fetchSubEpics(parentId: string) {
  const res = await fetch(`/api/epics?parentId=${parentId}`);
  if (!res.ok) throw new Error('Failed to fetch sub-epics');
  return res.json();
}

async function fetchSubEpicCounts(epicId: string): Promise<Record<string, number>> {
  const res = await fetch(`/api/epics/${epicId}/sub-epics/counts`);
  if (!res.ok) throw new Error('Failed to fetch sub-epic counts');
  return res.json();
}

async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

async function createEpic(data: Partial<Epic>) {
  const res = await fetch('/api/epics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create epic' }));
    throw new Error(error.message || 'Failed to create epic');
  }
  return res.json();
}

async function updateEpic(id: string, data: Partial<Epic>) {
  const res = await fetch(`/api/epics/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update epic' }));
    throw new Error(error.message || 'Failed to update epic');
  }
  return res.json();
}

async function bulkUpdateEpicsApi(payload: {
  parentId?: string | null;
  updates: Array<{ id: string; statusId?: string; agentId?: string | null; version: number }>;
}) {
  const res = await fetch('/api/epics/bulk-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update epics' }));
    throw new Error(error.message || 'Failed to apply bulk updates');
  }
  return res.json();
}

async function deleteEpic(id: string) {
  const res = await fetch(`/api/epics/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete epic' }));
    throw new Error(error.message || 'Failed to delete epic');
  }
}

// Epic Card Component with keyboard navigation
function EpicCard({
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
  // Tooltip data
  statusLabel,
  statusColor,
  agentName,
  onBulkEdit,
  onViewDetails,
}: {
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
  renderPreview: (subCount?: number) => React.ReactNode;
  // Tooltip data
  statusLabel?: string;
  statusColor?: string;
  agentName?: string | null;
  onBulkEdit?: (e: React.MouseEvent) => void;
  onViewDetails?: (e: React.MouseEvent) => void;
}) {
  const navigate = useNavigate();
  const showFilterToggle = epic.parentId === null;

  const { data: subEpicCounts } = useQuery({
    queryKey: ['epics', epic.id, 'sub-counts'],
    queryFn: () => fetchSubEpicCounts(epic.id),
    enabled: showFilterToggle,
  });

  const subEpicSummary = useMemo(
    () =>
      statuses
        .map((status) => ({
          status,
          count: subEpicCounts?.[status.id] ?? 0,
        }))
        .filter(({ count }) => count > 0),
    [statuses, subEpicCounts],
  );

  const hasSubEpicSummary = subEpicSummary.length > 0;

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
                {subEpicSummary.reduce((sum, entry) => sum + entry.count, 0)}
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
        {renderPreview(subEpicSummary.reduce((sum, entry) => sum + entry.count, 0))}
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

// Collapsed Column Component (Chip/Pill for collapsed columns)
function CollapsedColumn({
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
  // Tooltip helpers
  getAgentName,
  onEpicEdit,
  onEpicDelete,
  onEpicBulkEdit,
  onEpicViewDetails,
  onEpicToggleParentFilter,
}: {
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
  // Tooltip helpers
  getAgentName: (agentId: string | null) => string | null;
  onEpicEdit: (epic: Epic) => void;
  onEpicDelete: (epic: Epic) => void;
  onEpicBulkEdit: (epic: Epic) => void;
  onEpicViewDetails: (epic: Epic) => void;
  onEpicToggleParentFilter: (epic: Epic) => void;
}) {
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
          {epics.map((epic) => (
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
                  {(subEpicCounts?.[epic.id] ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      <span className="opacity-60">↳</span>
                      {subEpicCounts?.[epic.id]}
                    </span>
                  )}
                  {epic.tags?.slice(0, 2).map((tag) => (
                    <span
                      key={`${epic.id}-${tag}`}
                      className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                      title={tag}
                    >
                      {tag}
                    </span>
                  ))}
                  {epic.tags && epic.tags.length > 2 && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      +{epic.tags.length - 2}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

// Column Component
function BoardColumn({
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
}: {
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
}) {
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
          <EpicCard
            key={epic.id}
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
            renderPreview={() => {
              const agentName = getAgentName(epic.agentId);
              const showFilterToggle = epic.parentId === null;
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
          />
        ))}
      </div>
    </div>
  );
}

export function BoardPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingEpic, setEditingEpic] = useState<Epic | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Epic | null>(null);
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null);
  const [selectedStatusId, setSelectedStatusId] = useState<string>('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    tags: '',
    parentId: 'none',
  });
  const [draggedEpic, setDraggedEpic] = useState<Epic | null>(null);
  const [activeParentId, setActiveParentId] = useState<string | null>(null);
  const [expandedEmptyColumns, setExpandedEmptyColumns] = useState<Set<string>>(new Set());
  const [boardPrefs, setBoardPrefs] = useState<BoardViewPreferences>({
    collapsedStatusIds: [],
    autoCollapseEmpty: true,
    explicitlyExpandedStatusIds: [],
    viewMode: 'kanban',
    listPageSize: 25,
  });
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkTarget, setBulkTarget] = useState<Epic | null>(null);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkBaseline, setBulkBaseline] = useState<
    Record<string, { statusId: string; agentId: string | null }>
  >({});
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [activeDropStatusId, setActiveDropStatusId] = useState<string | null>(null);

  // URL → UI hydration (read-only in this epic)
  const { filters } = useBoardFilters();

  const { data: statusesData, isLoading: statusesLoading } = useQuery({
    queryKey: ['statuses', selectedProjectId],
    queryFn: () => fetchStatuses(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  // Query key only includes server-relevant params (projectId, archived type)
  // UI-only params (view, page, pageSize, status) are excluded to prevent unnecessary refetches
  const archivedFilter = filters.archived ?? 'active';
  const epicsKey = useMemo(
    () => ['epics', selectedProjectId, archivedFilter] as const,
    [selectedProjectId, archivedFilter],
  );

  const { data: epicsData } = useQuery({
    // Align cache with URL filters using canonical serialization
    queryKey: epicsKey,
    queryFn: () => fetchEpics(selectedProjectId as string, archivedFilter),
    enabled: !!selectedProjectId,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents', selectedProjectId],
    queryFn: () => fetchAgents(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  useEffect(() => {
    // Only update when URL-derived parent differs
    const nextParent = filters.parent ?? null;
    setActiveParentId((prev) => (prev === nextParent ? prev : nextParent));
  }, [filters.parent]);

  // Track previous status filter to detect changes
  const prevStatusFilterRef = useRef<string[] | undefined>(filters.status);

  // Reset pagination to page 1 when status filter changes
  useEffect(() => {
    const prevStatus = prevStatusFilterRef.current;
    const currStatus = filters.status;

    // Compare arrays by serializing (both could be undefined or arrays)
    const prevKey = prevStatus ? [...prevStatus].sort().join(',') : '';
    const currKey = currStatus ? [...currStatus].sort().join(',') : '';

    if (prevKey !== currKey && filters.page && filters.page > 1) {
      // Status filter changed and we're not on page 1 - reset to page 1
      const newFilters: BoardFilterParams = { ...filters };
      delete newFilters.page;
      const canonical = serializeBoardFilters(newFilters);
      navigate(
        { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
        { replace: true },
      );
    }
    prevStatusFilterRef.current = currStatus;
  }, [filters, location.pathname, navigate]);

  // Initial canonicalization: replace long keys with short keys and normalize ordering
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const hasLongKeys = ['archived', 'status', 'parent', 'agent', 'tags', 'q', 'sub', 'sort'].some(
      (k) => sp.has(k),
    );
    const subVal = sp.get('sub');
    const hasBoolWords = subVal === 'true' || subVal === 'false';
    if (hasLongKeys || hasBoolWords) {
      const canonical = serializeBoardFilters(parseBoardFilters(location.search));
      const current = location.search.startsWith('?') ? location.search.slice(1) : location.search;
      if (canonical !== current) {
        navigate(
          { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
          { replace: true },
        );
      }
    }
  }, [location.key]);

  const { data: subEpicsData, isLoading: subEpicsLoading } = useQuery({
    // Query key only includes parentId - UI params excluded to prevent unnecessary refetches
    queryKey: ['epics', 'parent', filters.parent ?? null],
    queryFn: () => fetchSubEpics((filters.parent as string) ?? ''),
    enabled: !!filters.parent,
  });

  const createMutation = useMutation({
    mutationFn: createEpic,
    onMutate: async (newEpic) => {
      await queryClient.cancelQueries({ queryKey: ['epics'] });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: [
          {
            id: 'temp-' + Date.now(),
            ...newEpic,
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          ...((old?.items ?? []) as Epic[]),
        ],
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      setShowDialog(false);
      setFormData({ title: '', description: '', tags: '', parentId: 'none' });
      toast({
        title: 'Success',
        description: 'Epic created successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(epicsKey, context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create epic',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Epic> }) => updateEpic(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['epics'] });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
          e.id === id ? { ...e, ...data, updatedAt: new Date().toISOString() } : e,
        ),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      if (!draggedEpic) {
        // Only show toast for non-drag operations
        toast({
          title: 'Success',
          description: 'Epic updated successfully',
        });
      }
      setShowDialog(false);
      setEditingEpic(null);
      setFormData({ title: '', description: '', tags: '', parentId: 'none' });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(epicsKey, context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update epic',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteEpic,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['epics'] });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).filter((e: Epic) => e.id !== id),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      setDeleteConfirm(null);
      toast({
        title: 'Success',
        description: 'Epic deleted successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(epicsKey, context.previousData);
      }
      setDeleteConfirm(null);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete epic',
        variant: 'destructive',
      });
    },
  });

  const bulkUpdateMutation = useMutation({
    mutationFn: async ({
      rows,
      baseline,
      parentId,
    }: {
      rows: BulkRow[];
      baseline: Record<string, { statusId: string; agentId: string | null }>;
      parentId?: string | null;
    }) => {
      const updates = rows
        .map((row) => {
          const original = baseline[row.epic.id];
          if (!original) return null;
          const payload: {
            id: string;
            statusId?: string;
            agentId?: string | null;
            version: number;
          } = { id: row.epic.id, version: row.epic.version };
          if (row.statusId !== original.statusId) {
            payload.statusId = row.statusId;
          }
          if ((row.agentId ?? null) !== (original.agentId ?? null)) {
            payload.agentId = row.agentId ?? null;
          }
          return Object.keys(payload).length > 2 ? payload : null; // only id/version present otherwise
        })
        .filter(Boolean) as Array<{
        id: string;
        statusId?: string;
        agentId?: string | null;
        version: number;
      }>;

      if (!updates.length) {
        return { updated: [], parentId };
      }

      const updated = await bulkUpdateEpicsApi({ parentId: parentId ?? null, updates });
      return { updated, parentId };
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      if (variables?.parentId) {
        queryClient.invalidateQueries({ queryKey: ['epics', variables.parentId, 'sub-counts'] });
        queryClient.invalidateQueries({
          queryKey: ['epics', 'parent', variables.parentId],
        });
      }
      toast({
        title: 'Updates applied',
        description: 'Bulk changes saved successfully.',
      });
      handleCloseBulkModal();
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to apply bulk updates';
      setBulkError(message);
      toast({
        title: 'Error',
        description: message,
        variant: 'destructive',
      });
    },
  });

  const sortedStatuses = useMemo(() => {
    return (statusesData?.items || []).sort((a: Status, b: Status) => a.position - b.position);
  }, [statusesData]);

  // Client-side status filtering: filter statuses based on URL filter (for Kanban columns)
  // When filters.status is set, only show those statuses; otherwise show all
  const visibleStatuses = useMemo(() => {
    if (!filters.status || filters.status.length === 0) {
      return sortedStatuses;
    }
    // Create a Set for O(1) lookup - filters.status contains status IDs
    const selectedStatusIds = new Set(filters.status);
    return sortedStatuses.filter((s: Status) => selectedStatusIds.has(s.id));
  }, [sortedStatuses, filters.status]);

  // Client-side epic filtering by status (for List view and general use)
  const filterEpicsByStatus = useCallback(
    (epics: Epic[]): Epic[] => {
      if (!filters.status || filters.status.length === 0) {
        return epics;
      }
      const selectedStatusIds = new Set(filters.status);
      return epics.filter((e: Epic) => selectedStatusIds.has(e.statusId));
    },
    [filters.status],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsData?.items || []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agentsData]);

  const getAgentName = useCallback(
    (agentId: string | null) => {
      if (!agentId) {
        return null;
      }
      return agentMap.get(agentId)?.name ?? null;
    },
    [agentMap],
  );

  const activeParent = useMemo(() => {
    if (!filters.parent) {
      return null;
    }
    return epicsData?.items.find((epic: Epic) => epic.id === filters.parent) ?? null;
  }, [epicsData, filters.parent]);

  // Display name for parent banner: prefer resolved epic title, fallback to id/slug from URL filters
  const activeParentName = useMemo(() => {
    if (activeParent?.title) return activeParent.title;
    return filters.parent ?? null;
  }, [activeParent?.title, filters.parent]);

  const parentCandidates = useMemo(() => {
    const items = (epicsData?.items ?? []) as Epic[];
    return items.filter((epic: Epic) => !epic.parentId);
  }, [epicsData]);

  const getEpicsByStatus = useCallback(
    (statusId: string) => {
      if (filters.parent) {
        return ((subEpicsData?.items ?? []) as Epic[]).filter(
          (epic: Epic) => epic.statusId === statusId,
        );
      }
      return ((epicsData?.items ?? []) as Epic[]).filter(
        (epic: Epic) => epic.statusId === statusId && (!epic.parentId || epic.parentId === null),
      );
    },
    [filters.parent, epicsData, subEpicsData],
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setExpandedEmptyColumns(new Set());
    if (selectedProjectId) {
      setBoardPrefs(getBoardPreferences(selectedProjectId));
    }
    // Preserve activeParentId when deep-linked via URL (filters.parent present)
    if (!filters.parent) {
      setActiveParentId(null);
    }
  }, [selectedProjectId, filters.parent]);

  useEffect(() => {
    if (activeParentId && !epicsData?.items.some((epic: Epic) => epic.id === activeParentId)) {
      setActiveParentId(null);
    }
  }, [activeParentId, epicsData]);

  const handleExpandEmptyColumn = useCallback((statusId: string) => {
    setExpandedEmptyColumns((prev) => new Set(prev).add(statusId));
  }, []);

  const handleToggleColumnCollapse = useCallback(
    (statusId: string) => {
      if (!selectedProjectId) return;

      setBoardPrefs((prev) => {
        const isCurrentlyCollapsed = prev.collapsedStatusIds.includes(statusId);
        const newPrefs = {
          ...prev,
          collapsedStatusIds: isCurrentlyCollapsed
            ? prev.collapsedStatusIds.filter((id) => id !== statusId)
            : [...prev.collapsedStatusIds, statusId],
          // Track explicitly expanded columns (not collapsed)
          explicitlyExpandedStatusIds: isCurrentlyCollapsed
            ? [...prev.explicitlyExpandedStatusIds, statusId]
            : prev.explicitlyExpandedStatusIds.filter((id) => id !== statusId),
        };
        saveBoardPreferences(selectedProjectId, newPrefs);
        return newPrefs;
      });
    },
    [selectedProjectId],
  );

  const handleCollapseAll = useCallback(() => {
    if (!selectedProjectId) return;

    const allIds = sortedStatuses.map((s: Status) => s.id);
    const newPrefs: BoardViewPreferences = {
      collapsedStatusIds: allIds,
      autoCollapseEmpty: boardPrefs.autoCollapseEmpty,
      explicitlyExpandedStatusIds: [],
      viewMode: boardPrefs.viewMode,
      listPageSize: boardPrefs.listPageSize,
    };
    setBoardPrefs(newPrefs);
    saveBoardPreferences(selectedProjectId, newPrefs);
    setExpandedEmptyColumns(new Set());
  }, [
    selectedProjectId,
    sortedStatuses,
    boardPrefs.autoCollapseEmpty,
    boardPrefs.viewMode,
    boardPrefs.listPageSize,
  ]);

  const handleResetDefaults = useCallback(() => {
    if (!selectedProjectId) return;

    const defaultPrefs: BoardViewPreferences = {
      collapsedStatusIds: [],
      autoCollapseEmpty: true,
      explicitlyExpandedStatusIds: [],
      viewMode: 'kanban',
      listPageSize: 25,
    };
    setBoardPrefs(defaultPrefs);
    saveBoardPreferences(selectedProjectId, defaultPrefs);
  }, [selectedProjectId]);

  // Current view mode: URL takes precedence, falls back to localStorage
  const currentViewMode = filters.view ?? boardPrefs.viewMode;

  const handleViewModeChange = useCallback(
    (mode: 'kanban' | 'list') => {
      if (!selectedProjectId) return;
      if (mode === currentViewMode) return;

      // Update localStorage preferences
      const newPrefs: BoardViewPreferences = {
        ...boardPrefs,
        viewMode: mode,
      };
      setBoardPrefs(newPrefs);
      saveBoardPreferences(selectedProjectId, newPrefs);

      // Update URL with new view param
      const newFilters: BoardFilterParams = { ...filters, view: mode };
      const canonical = serializeBoardFilters(newFilters);
      navigate(
        { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
        { replace: true },
      );
    },
    [selectedProjectId, currentViewMode, boardPrefs, filters, navigate, location.pathname],
  );

  // Handler for toggling a status in the filter (multi-select)
  const handleToggleStatusFilter = useCallback(
    (statusId: string) => {
      const currentStatuses = filters.status ?? [];
      const allStatusIds = sortedStatuses.map((s: Status) => s.id);
      let newStatuses: string[];

      if (currentStatuses.length === 0) {
        // No filter active = all selected. Clicking one means "select only others" (deselect this one)
        newStatuses = allStatusIds.filter((id: string) => id !== statusId);
      } else if (currentStatuses.includes(statusId)) {
        // Remove this status from filter
        newStatuses = currentStatuses.filter((id: string) => id !== statusId);
      } else {
        // Add this status to filter
        newStatuses = [...currentStatuses, statusId];
      }

      // If all statuses selected, clear the filter (show all)
      if (newStatuses.length === allStatusIds.length || newStatuses.length === 0) {
        const newFilters: BoardFilterParams = { ...filters };
        delete newFilters.status;
        delete newFilters.page; // Reset pagination
        const canonical = serializeBoardFilters(newFilters);
        navigate(
          { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
          { replace: true },
        );
      } else {
        const newFilters: BoardFilterParams = { ...filters, status: newStatuses };
        delete newFilters.page; // Reset pagination
        const canonical = serializeBoardFilters(newFilters);
        navigate(
          { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
          { replace: true },
        );
      }
    },
    [filters, sortedStatuses, navigate, location.pathname],
  );

  // Handler for "Select All" / "Clear All" status filter
  const handleSelectAllStatuses = useCallback(() => {
    const newFilters: BoardFilterParams = { ...filters };
    delete newFilters.status;
    delete newFilters.page;
    const canonical = serializeBoardFilters(newFilters);
    navigate(
      { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
      { replace: true },
    );
  }, [filters, navigate, location.pathname]);

  // Handler for archived toggle
  const handleToggleArchived = useCallback(
    (showArchived: boolean) => {
      const newFilters: BoardFilterParams = {
        ...filters,
        archived: showArchived ? 'all' : 'active',
      };
      delete newFilters.page; // Reset pagination
      const canonical = serializeBoardFilters(newFilters);
      navigate(
        { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
        { replace: true },
      );
    },
    [filters, navigate, location.pathname],
  );

  // Handler for applying saved filters (replaces current filters, doesn't merge)
  const handleApplySavedFilter = useCallback(
    (qs: string) => {
      // Parse saved query string
      const saved = parseBoardFilters(qs);
      // Remove pagination (always start fresh)
      delete saved.page;
      delete saved.pageSize;
      // Replace current URL with saved filters
      const newQs = serializeBoardFilters(saved);
      navigate({ pathname: location.pathname, search: newQs ? `?${newQs}` : '' });
    },
    [navigate, location.pathname],
  );

  // Check if any filters are active (for visual indication)
  const hasActiveFilters =
    (filters.status && filters.status.length > 0) || filters.archived === 'all';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      toast({
        title: 'Error',
        description: 'Please select a project first',
        variant: 'destructive',
      });
      return;
    }

    const tags = formData.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (editingEpic) {
      updateMutation.mutate({
        id: editingEpic.id,
        data: {
          title: formData.title,
          description: formData.description || null,
          tags,
          version: editingEpic.version,
        },
      });
    } else {
      createMutation.mutate({
        projectId: selectedProjectId,
        statusId: selectedStatusId,
        title: formData.title,
        description: formData.description || null,
        tags,
        parentId: formData.parentId === 'none' ? null : formData.parentId,
      });
    }
  };

  const handleEdit = (epic: Epic) => {
    navigate(`/epics/${epic.id}?edit=1`);
  };

  const handleDelete = (epic: Epic) => {
    setDeleteConfirm(epic);
  };

  const handleToggleParentFilter = useCallback(
    (epic: Epic) => {
      if (epic.parentId) return; // only top-level epics can be parent filters
      const base = parseBoardFilters(location.search);
      const next: BoardFilterParams = { ...base };
      if (filters.parent === epic.id) {
        delete next.parent; // clear filter
      } else {
        next.parent = epic.id;
      }
      // Reset page to 1 when filter changes
      delete next.page;
      const qs = serializeBoardFilters(next);
      navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }); // push
    },
    [filters.parent, location.pathname, location.search, navigate],
  );

  const clearParentFilter = useCallback(() => {
    const base = parseBoardFilters(location.search);
    const next: BoardFilterParams = { ...base };
    delete next.parent;
    // Reset page to 1 when filter changes
    delete next.page;
    const qs = serializeBoardFilters(next);
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' });
  }, [location.pathname, location.search, navigate]);

  const handleOpenBulkModal = useCallback((epic: Epic) => {
    if (epic.parentId) return; // Only parent epics get bulk edit
    setBulkTarget(epic);
    setBulkModalOpen(true);
  }, []);

  const handleCloseBulkModal = useCallback(() => {
    setBulkModalOpen(false);
    setBulkTarget(null);
    setBulkRows([]);
    setBulkBaseline({});
    setBulkError(null);
    setBulkLoading(false);
  }, []);

  const handleBulkRowChange = useCallback(
    (epicId: string, field: 'statusId' | 'agentId', value: string | null) => {
      setBulkRows((prev) =>
        prev.map((row) =>
          row.epic.id === epicId
            ? { ...row, [field]: field === 'agentId' ? value : (value as string) }
            : row,
        ),
      );
    },
    [],
  );

  const bulkHasChanges = useMemo(
    () =>
      bulkRows.some((row) => {
        const baseline = bulkBaseline[row.epic.id];
        if (!baseline) return false;
        return (
          baseline.statusId !== row.statusId || (baseline.agentId ?? null) !== (row.agentId ?? null)
        );
      }),
    [bulkRows, bulkBaseline],
  );

  // Build a map of sub-epic counts (children of each epic) from the currently loaded epics
  const subEpicCountsMap = useMemo(() => {
    const map: Record<string, number> = {};
    const items = (epicsData?.items as Epic[] | undefined) ?? [];
    items.forEach((epic) => {
      if (epic.parentId) {
        map[epic.parentId] = (map[epic.parentId] ?? 0) + 1;
      }
    });
    return map;
  }, [epicsData]);

  useEffect(() => {
    if (!bulkTarget) return;

    let cancelled = false;
    setBulkLoading(true);
    setBulkError(null);

    const resolvedParent =
      epicsData?.items.find((item: Epic) => item.id === bulkTarget.id) ?? bulkTarget;

    (async () => {
      try {
        const subEpics = await fetchSubEpics(bulkTarget.id);
        if (cancelled) return;
        const children = Array.isArray(subEpics?.items) ? (subEpics.items as Epic[]) : [];
        const rows: BulkRow[] = [
          {
            epic: resolvedParent,
            statusId: resolvedParent.statusId,
            agentId: resolvedParent.agentId ?? null,
          },
          ...children.map((child: Epic) => ({
            epic: child,
            statusId: child.statusId,
            agentId: child.agentId ?? null,
          })),
        ];
        setBulkRows(rows);
        const baseline = Object.fromEntries(
          rows.map((row) => [
            row.epic.id,
            { statusId: row.statusId, agentId: row.agentId ?? null },
          ]),
        );
        setBulkBaseline(baseline);
      } catch (error) {
        if (cancelled) return;
        setBulkError(error instanceof Error ? error.message : 'Failed to load sub-epics');
      } finally {
        if (!cancelled) {
          setBulkLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bulkTarget?.id, epicsData?.items]);

  const handleBulkSubmit = useCallback(() => {
    if (!bulkTarget) return;
    if (!bulkHasChanges) {
      toast({
        title: 'No changes',
        description: 'Update at least one epic before saving.',
      });
      return;
    }

    bulkUpdateMutation.mutate({
      rows: bulkRows,
      baseline: bulkBaseline,
      parentId: bulkTarget.id,
    });
  }, [bulkTarget, bulkHasChanges, bulkRows, bulkBaseline, bulkUpdateMutation, toast]);

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  // Bulk delete handlers for list view multi-select
  const handleBulkDelete = useCallback((epicIds: string[]) => {
    if (epicIds.length === 0) return;
    setBulkDeleteIds(epicIds);
  }, []);

  const confirmBulkDelete = async () => {
    if (!bulkDeleteIds || bulkDeleteIds.length === 0) return;
    // Delete each epic sequentially; clear modal after all complete
    for (const id of bulkDeleteIds) {
      await deleteMutation.mutateAsync(id);
    }
    setBulkDeleteIds(null);
    toast({
      title: 'Success',
      description: `Deleted ${bulkDeleteIds.length} epic${bulkDeleteIds.length > 1 ? 's' : ''} successfully`,
    });
  };

  // Realtime: subscribe to project-scoped epic events and invalidate caches
  const handleBoardEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!selectedProjectId || !envelope) return;
      const topic = `project/${selectedProjectId}/epics` as const;
      if (envelope.topic !== topic) return;
      const lifecycle =
        envelope.type === 'created' || envelope.type === 'updated' || envelope.type === 'deleted';
      if (!lifecycle) return;

      // Always refresh project epics list for all filter variants
      queryClient.invalidateQueries({ queryKey: ['epics', selectedProjectId] });

      const payload = (envelope.payload ?? {}) as EpicEventPayload;
      const parentId = payload.epic?.parentId ?? payload.parentId ?? null;

      // If a sub-epic changed, refresh its parent's sub-epic counts and list (when filtered)
      if (parentId) {
        queryClient.invalidateQueries({ queryKey: ['epics', parentId, 'sub-counts'] });
        if (filters.parent === parentId) {
          queryClient.invalidateQueries({ queryKey: ['epics', 'parent', filters.parent] });
        }
      } else if (filters.parent) {
        // Fallback: if parent filter is active, ensure its list stays fresh
        queryClient.invalidateQueries({ queryKey: ['epics', 'parent', filters.parent] });
      }
    },
    [queryClient, selectedProjectId, filters.parent],
  );

  const handleSocketConnect = useCallback(() => {
    if (!selectedProjectId) return;
    queryClient.invalidateQueries({ queryKey: ['epics', selectedProjectId] });
    if (filters.parent) {
      queryClient.invalidateQueries({ queryKey: ['epics', 'parent', filters.parent] });
    }
  }, [queryClient, selectedProjectId, filters.parent]);

  useAppSocket({ message: handleBoardEnvelope, connect: handleSocketConnect }, [
    handleBoardEnvelope,
    handleSocketConnect,
  ]);

  // Safety net: periodic refresh to recover from missed envelopes during reconnects
  useEffect(() => {
    if (!selectedProjectId) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['epics', selectedProjectId] });
      if (filters.parent) {
        queryClient.invalidateQueries({ queryKey: ['epics', 'parent', filters.parent] });
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [queryClient, selectedProjectId, filters.parent]);

  const handleDragStart = (epic: Epic) => {
    setDraggedEpic(epic);
    setActiveDropStatusId(epic.statusId ?? null);
  };

  const handleDragEnd = () => {
    setDraggedEpic(null);
    setActiveDropStatusId(null);
  };

  const handleDragOverStatus = useCallback(
    (statusId: string, e: React.DragEvent) => {
      e.preventDefault();
      if (activeDropStatusId !== statusId) {
        setActiveDropStatusId(statusId);
      }
    },
    [activeDropStatusId],
  );

  // Debounced drop handler
  const handleDrop = useCallback(
    (statusId: string) => {
      if (!draggedEpic || draggedEpic.statusId === statusId) {
        setDraggedEpic(null);
        setActiveDropStatusId(null);
        return;
      }

      const epicToUpdate = draggedEpic;

      // Optimistically update UI for current filter scope
      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
          e.id === epicToUpdate.id ? { ...e, statusId, updatedAt: new Date().toISOString() } : e,
        ),
      }));

      if (filters.parent && epicToUpdate.parentId === filters.parent) {
        queryClient.setQueryData(
          ['epics', 'parent', filters.parent],
          (old: EpicsQueryData | undefined) => ({
            ...old,
            items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
              e.id === epicToUpdate.id
                ? { ...e, statusId, updatedAt: new Date().toISOString() }
                : e,
            ),
          }),
        );
      }

      setDraggedEpic(null);
      setActiveDropStatusId(null);

      // Debounce the actual API call
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }

      updateTimeoutRef.current = setTimeout(() => {
        updateMutation.mutate({
          id: epicToUpdate.id,
          data: { statusId, version: epicToUpdate.version },
        });
      }, 300);
    },
    [draggedEpic, epicsKey, queryClient, updateMutation, filters.parent],
  );

  // Keyboard navigation between columns
  const handleKeyboardMove = useCallback(
    (epic: Epic, direction: 'left' | 'right') => {
      const currentIndex = sortedStatuses.findIndex((s: Status) => s.id === epic.statusId);
      if (currentIndex === -1) return;

      const targetIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= sortedStatuses.length) {
        toast({
          title: 'Info',
          description: `Cannot move ${direction}. Already at the ${direction === 'left' ? 'first' : 'last'} column.`,
        });
        return;
      }

      const targetStatusId = sortedStatuses[targetIndex].id;
      updateMutation.mutate({
        id: epic.id,
        data: { statusId: targetStatusId, version: epic.version },
      });

      toast({
        title: 'Moved',
        description: `Epic moved to ${sortedStatuses[targetIndex].label}`,
      });
    },
    [sortedStatuses, updateMutation, toast],
  );

  const handleAddEpic = (statusId: string) => {
    setSelectedStatusId(statusId);
    setEditingEpic(null);
    setFormData({
      title: '',
      description: '',
      tags: '',
      parentId: filters.parent ?? 'none',
    });
    setShowDialog(true);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="mb-4 flex items-start justify-between gap-4 flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold">Epic Board</h1>
          {selectedProjectId ? (
            <p className="text-muted-foreground">
              Organize epics for{' '}
              <span className="font-semibold text-foreground">
                {activeProject?.name ?? 'the selected project'}
              </span>
              .
            </p>
          ) : (
            <p className="text-muted-foreground">
              Select a project from the header to view its Kanban board.
            </p>
          )}
        </div>

        {selectedProjectId && !statusesLoading && sortedStatuses.length > 0 && (
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex items-center border rounded-md">
              <Button
                variant={currentViewMode === 'kanban' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => handleViewModeChange('kanban')}
                aria-label="Kanban view"
                aria-pressed={currentViewMode === 'kanban'}
                className="rounded-r-none"
              >
                <LayoutGrid className="h-4 w-4 mr-1.5" />
                Kanban
              </Button>
              <Button
                variant={currentViewMode === 'list' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => handleViewModeChange('list')}
                aria-label="List view"
                aria-pressed={currentViewMode === 'list'}
                className="rounded-l-none"
              >
                <List className="h-4 w-4 mr-1.5" />
                List
              </Button>
            </div>

            {/* Saved Filters Select */}
            {selectedProjectId && (
              <SavedFiltersSelect
                projectId={selectedProjectId}
                currentFilters={filters}
                onApply={handleApplySavedFilter}
              />
            )}

            {/* Filter popover for status and archived filtering */}
            <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant={hasActiveFilters ? 'default' : 'outline'}
                  size="sm"
                  aria-label="Filter epics"
                  className={cn(hasActiveFilters && 'bg-primary text-primary-foreground')}
                >
                  <Filter className="h-4 w-4 mr-1.5" />
                  Filter
                  {hasActiveFilters && (
                    <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-xs">
                      {(filters.status?.length ?? 0) + (filters.archived === 'all' ? 1 : 0)}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-3" align="end">
                <div className="space-y-4">
                  <div className="font-semibold text-sm">Filter Board</div>

                  {/* Status multi-select */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Status</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs px-2"
                        onClick={handleSelectAllStatuses}
                        disabled={!filters.status || filters.status.length === 0}
                      >
                        Clear
                      </Button>
                    </div>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {sortedStatuses.map((status: Status) => {
                        const isChecked =
                          !filters.status ||
                          filters.status.length === 0 ||
                          filters.status.includes(status.id);
                        return (
                          <div key={status.id} className="flex items-center gap-2">
                            <Checkbox
                              id={`filter-st-${status.id}`}
                              checked={isChecked}
                              onCheckedChange={() => handleToggleStatusFilter(status.id)}
                              aria-label={`Filter by ${status.label}`}
                            />
                            <label
                              htmlFor={`filter-st-${status.id}`}
                              className="text-sm flex items-center gap-1.5 flex-1 cursor-pointer"
                            >
                              <div
                                className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: status.color }}
                              />
                              <span className="flex-1">{status.label}</span>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Archived toggle */}
                  <div className="pt-3 border-t">
                    <div className="flex items-center justify-between">
                      <label htmlFor="filter-archived" className="text-sm cursor-pointer flex-1">
                        Show Archived
                      </label>
                      <Switch
                        id="filter-archived"
                        checked={filters.archived === 'all'}
                        onCheckedChange={handleToggleArchived}
                        aria-label="Show archived epics"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Include archived epics in the board view
                    </p>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Popover open={columnPickerOpen} onOpenChange={setColumnPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Collapse columns">
                  <Settings2 className="h-4 w-4 mr-1.5" />
                  Columns
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-3" align="end">
                <div className="space-y-3">
                  <div className="font-semibold text-sm">Collapse Columns</div>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {sortedStatuses.map((status: Status) => {
                      const epics = getEpicsByStatus(status.id);
                      const isManuallyCollapsed = boardPrefs.collapsedStatusIds.includes(status.id);
                      return (
                        <div key={status.id} className="flex items-center gap-2">
                          <Checkbox
                            id={`col-${status.id}`}
                            checked={!isManuallyCollapsed}
                            onCheckedChange={() => handleToggleColumnCollapse(status.id)}
                          />
                          <label
                            htmlFor={`col-${status.id}`}
                            className="text-sm flex items-center gap-1.5 flex-1 cursor-pointer"
                          >
                            <div
                              className="h-2 w-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: status.color }}
                            />
                            <span className="flex-1">{status.label}</span>
                            <Badge variant="secondary" className="text-xs">
                              {epics.length}
                            </Badge>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-2 pt-2 border-t">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCollapseAll}
                      className="flex-1 text-xs"
                    >
                      Collapse All
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetDefaults}
                      className="flex-1 text-xs"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>

      {filters.parent && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
          data-testid="parent-banner"
        >
          <div className="text-sm text-muted-foreground">
            Showing sub-epics for{' '}
            <span className="font-semibold text-foreground">{activeParentName}</span>
          </div>
          <div className="flex items-center gap-2">
            {subEpicsLoading && (
              <span className="text-xs text-muted-foreground">Loading sub-epics…</span>
            )}
            <Button variant="outline" size="sm" onClick={clearParentFilter}>
              Clear filter
            </Button>
          </div>
        </div>
      )}

      {!selectedProjectId && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Project Selected</h2>
          <p className="text-muted-foreground mb-4">
            Use the project selector in the header to open a project board.
          </p>
        </div>
      )}

      {selectedProjectId && statusesLoading && (
        <div className="flex justify-center py-8">
          <p className="text-muted-foreground">Loading board...</p>
        </div>
      )}

      {selectedProjectId && !statusesLoading && sortedStatuses.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center border rounded-lg">
          <AlertCircle className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Statuses Configured</h2>
          <p className="text-muted-foreground mb-4">
            This project doesn't have any statuses yet. Create statuses to organize your epics.
          </p>
          <Button onClick={() => navigate('/statuses')}>Go to Status Management</Button>
        </div>
      )}

      {selectedProjectId &&
        !statusesLoading &&
        sortedStatuses.length > 0 &&
        currentViewMode === 'kanban' && (
          <div className="overflow-x-auto flex-1 min-h-0 snap-x snap-mandatory">
            <div className="flex gap-4 sidebar-collapsed:gap-3 w-full h-full">
              {visibleStatuses.map((status: Status) => {
                const epics = getEpicsByStatus(status.id);
                const isEmpty = epics.length === 0;
                const isManuallyCollapsed = boardPrefs.collapsedStatusIds.includes(status.id);
                const isExplicitlyExpanded = boardPrefs.explicitlyExpandedStatusIds.includes(
                  status.id,
                );
                const isAutoCollapsed = isEmpty && boardPrefs.autoCollapseEmpty;
                const isSessionExpanded = expandedEmptyColumns.has(status.id);

                // Show collapsed chip if: manually collapsed OR (auto-collapsed AND not explicitly expanded AND not session-expanded)
                const shouldCollapse =
                  isManuallyCollapsed ||
                  (isAutoCollapsed && !isExplicitlyExpanded && !isSessionExpanded);

                if (shouldCollapse) {
                  return (
                    <CollapsedColumn
                      key={status.id}
                      status={status}
                      count={epics.length}
                      epics={epics}
                      subEpicCounts={subEpicCountsMap}
                      getAgentName={getAgentName}
                      onEpicEdit={handleEdit}
                      onEpicDelete={handleDelete}
                      onEpicBulkEdit={handleOpenBulkModal}
                      onEpicViewDetails={(epic) => navigate(`/epics/${epic.id}`)}
                      onEpicToggleParentFilter={handleToggleParentFilter}
                      onExpand={() => {
                        // If manually collapsed, toggle it in preferences
                        // If auto-collapsed, just expand it for this session
                        if (isManuallyCollapsed) {
                          handleToggleColumnCollapse(status.id);
                        } else {
                          handleExpandEmptyColumn(status.id);
                        }
                      }}
                      onAddEpic={handleAddEpic}
                      onDragOver={(e) => handleDragOverStatus(status.id, e)}
                      onDrop={() => handleDrop(status.id)}
                      isActiveDrop={activeDropStatusId === status.id}
                      onDragStartEpic={handleDragStart}
                      onDragEndEpic={handleDragEnd}
                    />
                  );
                }

                // Show full column otherwise
                return (
                  <BoardColumn
                    key={status.id}
                    status={status}
                    epics={epics}
                    onAddEpic={handleAddEpic}
                    onEditEpic={handleEdit}
                    onDeleteEpic={handleDelete}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleDragOverStatus(status.id, e)}
                    onDrop={handleDrop}
                    isActiveDrop={activeDropStatusId === status.id}
                    draggedEpic={draggedEpic}
                    onKeyboardMove={handleKeyboardMove}
                    onToggleParentFilter={handleToggleParentFilter}
                    activeParentId={filters.parent ?? null}
                    statusOrder={sortedStatuses}
                    getAgentName={getAgentName}
                    onCollapseColumn={handleToggleColumnCollapse}
                    onBulkEdit={handleOpenBulkModal}
                    onViewDetails={(epic) => navigate(`/epics/${epic.id}`)}
                  />
                );
              })}
            </div>
          </div>
        )}

      {selectedProjectId &&
        !statusesLoading &&
        sortedStatuses.length > 0 &&
        currentViewMode === 'list' && (
          <BoardListView
            epics={filterEpicsByStatus(
              filters.parent
                ? ((subEpicsData?.items ?? []) as Epic[])
                : ((epicsData?.items ?? []) as Epic[]).filter((e: Epic) => !e.parentId),
            )}
            statuses={sortedStatuses}
            agents={(agentsData?.items ?? []) as Agent[]}
            isLoading={false}
            pageSize={filters.pageSize ?? boardPrefs.listPageSize}
            currentPage={filters.page ?? 1}
            onPageChange={(page) => {
              const newFilters: BoardFilterParams = { ...filters, page };
              const canonical = serializeBoardFilters(newFilters);
              navigate(
                { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
                { replace: true },
              );
            }}
            onPageSizeChange={(newPageSize) => {
              // Persist to localStorage
              if (selectedProjectId) {
                const newPrefs: BoardViewPreferences = {
                  ...boardPrefs,
                  listPageSize: newPageSize,
                };
                setBoardPrefs(newPrefs);
                saveBoardPreferences(selectedProjectId, newPrefs);
              }
              // Update URL with new page size, reset to page 1
              const newFilters: BoardFilterParams = { ...filters, pageSize: newPageSize, page: 1 };
              const canonical = serializeBoardFilters(newFilters);
              navigate(
                { pathname: location.pathname, search: canonical ? `?${canonical}` : '' },
                { replace: true },
              );
            }}
            onEditEpic={handleEdit}
            onDeleteEpic={handleDelete}
            onBulkDelete={handleBulkDelete}
            onViewDetails={(epic) => navigate(`/epics/${epic.id}`)}
            onBulkEditEpic={handleOpenBulkModal}
            onToggleParentFilter={handleToggleParentFilter}
            onViewSubEpics={(epic) => handleToggleParentFilter(epic)}
            onStatusChange={async (epic, statusId) => {
              await updateMutation.mutateAsync({
                id: epic.id,
                data: { statusId, version: epic.version },
              });
            }}
            onAgentChange={async (epic, agentId) => {
              await updateMutation.mutateAsync({
                id: epic.id,
                data: { agentId, version: epic.version },
              });
            }}
            className="flex-1 min-h-0"
          />
        )}

      {/* Parent + Sub-epics Bulk Edit Dialog */}
      <Dialog
        open={bulkModalOpen}
        onOpenChange={(open) => {
          if (open) {
            setBulkModalOpen(true);
          } else {
            handleCloseBulkModal();
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Bulk edit parent & sub-epics</DialogTitle>
            <DialogDescription>
              Update status and assignees for the parent epic and its sub-epics in one place.
              Triggered from the list-checks icon on parent cards.
            </DialogDescription>
          </DialogHeader>

          {bulkError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm p-3">
              {bulkError}
            </div>
          )}

          {bulkLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading parent and sub-epics…
            </div>
          )}

          {!bulkLoading && bulkRows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Select a parent epic to bulk edit its sub-epics.
            </p>
          )}

          {!bulkLoading && bulkRows.length > 0 && (
            <div className="rounded-md border divide-y overflow-y-auto flex-1 min-h-0">
              {bulkRows.map((row) => {
                const statusSelectId = `bulk-status-${row.epic.id}`;
                const agentSelectId = `bulk-agent-${row.epic.id}`;
                const isParent = !row.epic.parentId;
                const rowStatus = sortedStatuses.find((s: Status) => s.id === row.statusId);
                const subBadgeStyle =
                  !isParent && rowStatus?.color
                    ? {
                        backgroundColor: rowStatus.color,
                        color: isLightColor(rowStatus.color) ? '#1f2937' : '#ffffff',
                        borderColor: 'transparent',
                      }
                    : undefined;
                return (
                  <div
                    key={row.epic.id}
                    className="grid gap-3 p-3 sm:grid-cols-[2fr,1.2fr,1.2fr]"
                    data-testid={`bulk-row-${row.epic.id}`}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge
                          variant={isParent ? 'secondary' : 'outline'}
                          className="text-[11px] shrink-0"
                          style={subBadgeStyle}
                        >
                          {isParent ? 'Parent' : 'Sub'}
                        </Badge>
                        <span className="font-semibold text-sm break-all">{row.epic.title}</span>
                      </div>
                      {row.epic.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {row.epic.description}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor={statusSelectId}>Status</Label>
                      <Select
                        value={row.statusId}
                        onValueChange={(value) =>
                          handleBulkRowChange(row.epic.id, 'statusId', value)
                        }
                      >
                        <SelectTrigger id={statusSelectId}>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                        <SelectContent>
                          {sortedStatuses.map((status: Status) => (
                            <SelectItem key={status.id} value={status.id}>
                              {status.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor={agentSelectId}>Assignee</Label>
                      <Select
                        value={row.agentId ?? 'none'}
                        onValueChange={(value) =>
                          handleBulkRowChange(
                            row.epic.id,
                            'agentId',
                            value === 'none' ? null : value,
                          )
                        }
                      >
                        <SelectTrigger id={agentSelectId}>
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {(agentsData?.items ?? []).map((agent: Agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={handleCloseBulkModal}>
              Cancel
            </Button>
            <Button
              onClick={handleBulkSubmit}
              disabled={
                bulkLoading || bulkUpdateMutation.isPending || !bulkHasChanges || !bulkTarget
              }
            >
              {bulkUpdateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Epic Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingEpic ? 'Edit Epic' : 'Create Epic'}</DialogTitle>
            <DialogDescription>
              {editingEpic
                ? 'Update the epic details'
                : `Create a new epic for ${activeProject?.name ?? 'this project'}`}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="epic-title">Title *</Label>
              <Input
                id="epic-title"
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                required
                placeholder="Enter epic title"
              />
            </div>

            <div>
              <Label htmlFor="epic-description">Description</Label>
              <Textarea
                id="epic-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Optional description"
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="epic-tags">Tags</Label>
              <Input
                id="epic-tags"
                type="text"
                value={formData.tags}
                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                placeholder="tag1, tag2, tag3"
              />
              <p className="text-xs text-muted-foreground mt-1">Separate tags with commas</p>
            </div>

            {parentCandidates.length > 0 && (filters.parent || formData.parentId !== 'none') && (
              <div>
                <Label htmlFor="epic-parent">Parent</Label>
                <Select
                  value={formData.parentId}
                  onValueChange={(value) => setFormData({ ...formData, parentId: value })}
                >
                  <SelectTrigger id="epic-parent">
                    <SelectValue placeholder="Select parent epic" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No parent</SelectItem>
                    {parentCandidates.map((candidate: Epic) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {activeParent && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Prefilled with{' '}
                    <span className="font-medium text-foreground">{activeParent.title}</span>
                    {' from the current filter.'}
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingEpic(null);
                  setFormData({ title: '', description: '', tags: '', parentId: 'none' });
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {editingEpic ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Epic</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.title}</strong>? This action
              cannot be undone and will also delete all associated records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog open={!!bulkDeleteIds} onOpenChange={(open) => !open && setBulkDeleteIds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {bulkDeleteIds?.length ?? 0} Epic{(bulkDeleteIds?.length ?? 0) > 1 ? 's' : ''}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <strong>
                {bulkDeleteIds?.length ?? 0} epic{(bulkDeleteIds?.length ?? 0) > 1 ? 's' : ''}
              </strong>
              ? This action cannot be undone and will also delete all associated records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteIds(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmBulkDelete}
              disabled={deleteMutation.isPending}
            >
              Delete All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
