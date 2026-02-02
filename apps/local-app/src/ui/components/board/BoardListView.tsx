import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { FolderOpen, Pencil, Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Button } from '@/ui/components/ui/button';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { cn } from '@/ui/lib/utils';
import { EpicTableRow } from './EpicTableRow';
import { PaginationControls } from '@/ui/components/shared/PaginationControls';
import type { Epic, Status, Agent } from './types';

// Re-export types for backwards compatibility
export type { Epic, Status, Agent } from './types';

export interface BoardListViewProps {
  /** List of epics to display (all parent epics - pagination is handled internally) */
  epics: Epic[];
  /** Available statuses for status column display */
  statuses: Status[];
  /** Available agents for agent column display */
  agents: Agent[];
  /** Loading state - shows skeleton rows */
  isLoading?: boolean;
  /** Number of skeleton rows to show when loading */
  skeletonRowCount?: number;
  /** Page size for display */
  pageSize?: number;
  /** Current page (1-indexed) */
  currentPage?: number;
  /** Handler when page changes */
  onPageChange?: (page: number) => void;
  /** Handler when page size changes */
  onPageSizeChange?: (pageSize: number) => void;
  /** Handler when an epic is clicked for editing */
  onEditEpic?: (epic: Epic) => void;
  /** Handler when delete is clicked */
  onDeleteEpic?: (epic: Epic) => void;
  /** Handler for viewing epic details (navigate to epic page) */
  onViewDetails?: (epic: Epic) => void;
  /** Handler for bulk edit on a single epic (parent epics only) */
  onBulkEditEpic?: (epic: Epic) => void;
  /** Handler for toggling parent filter (parent epics only) */
  onToggleParentFilter?: (epic: Epic) => void;
  /** Handler for bulk edit - receives selected epics */
  onBulkEdit?: (epics: Epic[]) => void;
  /** Handler for bulk delete - receives selected epic IDs */
  onBulkDelete?: (epicIds: string[]) => void;
  /** Handler when "view sub-epics" is clicked (placeholder for future implementation) */
  onViewSubEpics?: (epic: Epic) => void;
  /** Handler when status changes (inline editing) */
  onStatusChange?: (epic: Epic, statusId: string) => Promise<void> | void;
  /** Handler when agent changes (inline editing) */
  onAgentChange?: (epic: Epic, agentId: string | null) => Promise<void> | void;
  /** Map of epic ID to sub-epic count (for showing expand button only when has children) */
  subEpicCounts?: Record<string, number>;
  /** Optional className for container */
  className?: string;
}

/**
 * BoardListView - Table view for epics on the Board page
 *
 * Displays epics in a table format with columns for:
 * - Selection checkbox (placeholder)
 * - Expand/collapse toggle (placeholder)
 * - Title
 * - Status
 * - Agent
 * - Tags
 * - Actions
 */
export function BoardListView({
  epics,
  statuses,
  agents,
  isLoading = false,
  skeletonRowCount = 5,
  pageSize = 25,
  currentPage = 1,
  onPageChange,
  onPageSizeChange,
  onEditEpic,
  onDeleteEpic,
  onViewDetails,
  onBulkEditEpic,
  onToggleParentFilter,
  onBulkEdit,
  onBulkDelete,
  onViewSubEpics: _onViewSubEpics,
  onStatusChange,
  onAgentChange,
  subEpicCounts,
  className,
}: BoardListViewProps) {
  // Track which epics are expanded (by epic ID)
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set());
  // Track selected epics (by epic ID) - persists across pagination
  const [selectedEpics, setSelectedEpics] = useState<Set<string>>(new Set());
  // Ref for header checkbox to set indeterminate state
  const headerCheckboxRef = useRef<HTMLButtonElement>(null);

  // Precompute lookup maps once to avoid creating new Maps in each EpicTableRow
  const statusMap = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // Sort epics by updatedAt (most recent first), then status position, then title
  const sortedEpics = useMemo(() => {
    return [...epics].sort((a, b) => {
      // Primary sort: by updatedAt (descending - most recently updated first)
      const timeA = new Date(a.updatedAt).getTime();
      const timeB = new Date(b.updatedAt).getTime();
      if (timeA !== timeB) {
        return timeB - timeA; // Descending
      }

      // Secondary sort: by status position (ascending - matches Kanban left-to-right)
      const statusA = statusMap.get(a.statusId);
      const statusB = statusMap.get(b.statusId);
      const posA = statusA?.position ?? Number.MAX_SAFE_INTEGER;
      const posB = statusB?.position ?? Number.MAX_SAFE_INTEGER;
      if (posA !== posB) {
        return posA - posB;
      }

      // Tertiary sort: by title (alphabetical) for stability
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
  }, [epics, statusMap]);

  const handleToggleExpand = useCallback((epicId: string) => {
    setExpandedEpics((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) {
        next.delete(epicId);
      } else {
        next.add(epicId);
      }
      return next;
    });
  }, []);

  // Toggle selection for a single epic
  const handleToggleSelect = useCallback((epicId: string) => {
    setSelectedEpics((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) {
        next.delete(epicId);
      } else {
        next.add(epicId);
      }
      return next;
    });
  }, []);

  // Select/deselect all visible epics (on current page)
  // Note: visibleIds is computed from paginatedEpics after the pagination calculation
  const handleSelectAll = useCallback(
    (paginatedIds: string[]) => {
      const allSelected = paginatedIds.every((id) => selectedEpics.has(id));

      if (allSelected) {
        // Deselect all visible
        setSelectedEpics((prev) => {
          const next = new Set(prev);
          paginatedIds.forEach((id) => next.delete(id));
          return next;
        });
      } else {
        // Select all visible
        setSelectedEpics((prev) => {
          const next = new Set(prev);
          paginatedIds.forEach((id) => next.add(id));
          return next;
        });
      }
    },
    [selectedEpics],
  );

  // Clear all selections
  const clearSelection = useCallback(() => {
    setSelectedEpics(new Set());
  }, []);

  // Handle bulk edit
  const handleBulkEdit = useCallback(() => {
    const selected = epics.filter((e) => selectedEpics.has(e.id));
    onBulkEdit?.(selected);
  }, [epics, selectedEpics, onBulkEdit]);

  // Handle bulk delete
  const handleBulkDelete = useCallback(() => {
    const selectedIds = Array.from(selectedEpics);
    onBulkDelete?.(selectedIds);
    // Clear selection after triggering delete
    clearSelection();
  }, [selectedEpics, onBulkDelete, clearSelection]);

  // Pagination calculations (use sortedEpics for consistent ordering)
  const totalItems = sortedEpics.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  // Ensure current page is within bounds
  const validPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (validPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

  // Slice sorted epics for current page
  const paginatedEpics = sortedEpics.slice(startIndex, endIndex);
  const displayedCount = paginatedEpics.length;

  // Calculate display info
  const startItem = totalItems === 0 ? 0 : startIndex + 1;
  const endItem = endIndex;

  // Calculate header checkbox state (based on paginated epics)
  const visibleIds = paginatedEpics.map((e) => e.id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedEpics.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;

  // Set indeterminate state on header checkbox
  useEffect(() => {
    if (headerCheckboxRef.current) {
      const input = headerCheckboxRef.current.querySelector('input');
      if (input) {
        input.indeterminate = someVisibleSelected;
      }
    }
  }, [someVisibleSelected]);

  const columnCount = 8; // Checkbox, Expand, Title, Status, Agent, Tags, Created, Actions

  // Handle page change
  const handlePageChange = useCallback(
    (page: number) => {
      onPageChange?.(page);
    },
    [onPageChange],
  );

  // Handle page size change
  const handlePageSizeChange = useCallback(
    (newPageSize: number) => {
      onPageSizeChange?.(newPageSize);
    },
    [onPageSizeChange],
  );

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Toolbar area with selection bar */}
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="text-sm text-muted-foreground">
          {isLoading ? (
            <Skeleton className="h-4 w-32" />
          ) : selectedEpics.size > 0 ? (
            <div className="flex items-center gap-3">
              <span className="font-medium text-foreground">{selectedEpics.size} selected</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1"
                  onClick={handleBulkEdit}
                  disabled={!onBulkEdit}
                >
                  <Pencil className="h-3 w-3" />
                  Bulk Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-destructive hover:text-destructive"
                  onClick={handleBulkDelete}
                  disabled={!onBulkDelete}
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-muted-foreground"
                onClick={clearSelection}
              >
                Clear
              </Button>
            </div>
          ) : (
            <>
              Showing {displayedCount > 0 ? `${startItem}-${endItem}` : '0'} of {totalItems} epics
            </>
          )}
        </div>
      </div>

      {/* Scrollable table container */}
      <div className="flex-1 overflow-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  ref={headerCheckboxRef}
                  checked={allVisibleSelected}
                  onCheckedChange={() => handleSelectAll(visibleIds)}
                  aria-label={allVisibleSelected ? 'Deselect all' : 'Select all'}
                  disabled={paginatedEpics.length === 0}
                />
              </TableHead>
              <TableHead className="w-[40px]" />
              <TableHead className="min-w-[200px]">Title</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[150px]">Agent</TableHead>
              <TableHead className="w-[200px]">Tags</TableHead>
              <TableHead className="w-[120px]">Created</TableHead>
              <TableHead className="w-[80px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              // Loading skeleton rows
              Array.from({ length: skeletonRowCount }).map((_, index) => (
                <TableRow key={`skeleton-${index}`} className="hover:bg-transparent">
                  <TableCell>
                    <Skeleton className="h-4 w-4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-3/4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-6 w-20 rounded-full" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Skeleton className="h-5 w-12 rounded-full" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-8 w-8" />
                  </TableCell>
                </TableRow>
              ))
            ) : paginatedEpics.length === 0 ? (
              // Empty state
              <TableRow>
                <TableCell colSpan={columnCount} className="h-48">
                  <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
                    <FolderOpen className="h-12 w-12 opacity-50" />
                    <div className="text-center">
                      <p className="font-medium">No epics found</p>
                      <p className="text-sm">Create an epic to get started.</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              // Data rows using EpicTableRow component (paginated)
              paginatedEpics.map((epic) => (
                <EpicTableRow
                  key={epic.id}
                  epic={epic}
                  statuses={statuses}
                  agents={agents}
                  statusMap={statusMap}
                  agentMap={agentMap}
                  isExpanded={expandedEpics.has(epic.id)}
                  onToggleExpand={handleToggleExpand}
                  selectedEpics={selectedEpics}
                  onToggleSelect={handleToggleSelect}
                  onEditEpic={onEditEpic}
                  onDeleteEpic={onDeleteEpic}
                  onViewDetails={onViewDetails}
                  onBulkEdit={onBulkEditEpic}
                  onToggleParentFilter={onToggleParentFilter}
                  onStatusChange={onStatusChange}
                  onAgentChange={onAgentChange}
                  subEpicCount={subEpicCounts?.[epic.id] ?? 0}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer with pagination controls */}
      {!isLoading && totalItems > 0 && (
        <div className="mt-4">
          <PaginationControls
            page={validPage}
            pageSize={pageSize}
            totalItems={totalItems}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        </div>
      )}
    </div>
  );
}
