import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { BoardListView } from '@/ui/components/board/BoardListView';
import { BoardColumn } from '@/ui/components/board/BoardColumn';
import { CollapsedColumn } from '@/ui/components/board/CollapsedColumn';
import { BoardToolbar } from '@/ui/components/board/BoardToolbar';
import { BulkEditDialog } from '@/ui/components/board/BulkEditDialog';
import { EpicFormDialog } from '@/ui/components/board/EpicFormDialog';
import { MoveToWorktreeDialog } from '@/ui/components/board/MoveToWorktreeDialog';
import { AlertCircle, FolderOpen } from 'lucide-react';
import { serializeBoardFilters, type BoardFilterParams } from '@/ui/lib/url-filters';
import type { Agent, Epic, Status } from '@/ui/types';
import type { BoardPageController } from '@/ui/hooks/useBoardPageController';

// Helper to determine if a hex color is light (returns true) or dark (returns false)
function isLightColor(hex: string): boolean {
  const color = hex.replace('#', '');
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

interface BoardViewPreferences {
  collapsedStatusIds: string[];
  autoCollapseEmpty: boolean;
  explicitlyExpandedStatusIds: string[];
  viewMode: 'kanban' | 'list';
  listPageSize: number;
}

interface BoardPageViewProps {
  controller: BoardPageController;
}

export function BoardPageView({ controller }: BoardPageViewProps) {
  const {
    navigate,
    location,
    selectedProjectId,
    activeProject,
    hasRunningWorktrees,
    showDialog,
    setShowDialog,
    editingEpic,
    setEditingEpic,
    deleteConfirm,
    setDeleteConfirm,
    moveToWorktreeEpic,
    setMoveToWorktreeEpic,
    bulkDeleteIds,
    setBulkDeleteIds,
    formData,
    setFormData,
    boardPrefs,
    setBoardPrefs,
    filterPopoverOpen,
    setFilterPopoverOpen,
    columnPickerOpen,
    setColumnPickerOpen,
    bulkModalOpen,
    setBulkModalOpen,
    bulkTarget,
    bulkRows,
    bulkError,
    bulkLoading,
    expandedEmptyColumns,
    filters,
    statusesLoading,
    epicsData,
    agentsData,
    subEpicsData,
    subEpicsLoading,
    sortedStatuses,
    visibleStatuses,
    getAgentName,
    activeParent,
    parentCandidates,
    getEpicsByStatus,
    subEpicStatusCountsByEpicId,
    subEpicCountsMap,
    createMutation,
    updateMutation,
    deleteMutation,
    bulkUpdateMutation,
    mutateUpdateEpicStatusAsync,
    mutateUpdateEpicAgentAsync,
    draggedEpic,
    activeDropStatusId,
    activeParentName,
    currentViewMode,
    hasActiveFilters,
    bulkHasChanges,
    filterEpicsByStatus,
    handleViewModeChange,
    handleApplySavedFilter,
    handleSelectAllStatuses,
    handleToggleStatusFilter,
    handleToggleArchived,
    handleToggleColumnCollapse,
    handleCollapseAll,
    handleResetDefaults,
    clearParentFilter,
    handleEdit,
    handleDelete,
    handleMoveToWorktree,
    handleToggleParentFilter,
    handleOpenBulkModal,
    handleCloseBulkModal,
    handleBulkRowChange,
    handleBulkSubmit,
    confirmDelete,
    handleBulkDelete,
    confirmBulkDelete,
    handleDragStart,
    handleDragEnd,
    handleDragOverStatus,
    handleDrop,
    handleKeyboardMove,
    handleAddEpic,
    handleSubmit,
    handleExpandEmptyColumn,
    saveBoardPreferences,
  } = controller;
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
          <BoardToolbar
            projectId={selectedProjectId}
            currentViewMode={currentViewMode}
            onViewModeChange={handleViewModeChange}
            filters={filters}
            onApplySavedFilter={handleApplySavedFilter}
            hasActiveFilters={hasActiveFilters}
            filterPopoverOpen={filterPopoverOpen}
            onFilterPopoverOpenChange={setFilterPopoverOpen}
            statuses={sortedStatuses}
            onSelectAllStatuses={handleSelectAllStatuses}
            onToggleStatusFilter={handleToggleStatusFilter}
            onToggleArchived={handleToggleArchived}
            columnPickerOpen={columnPickerOpen}
            onColumnPickerOpenChange={setColumnPickerOpen}
            collapsedStatusIds={boardPrefs.collapsedStatusIds}
            getStatusEpicCount={(statusId) => getEpicsByStatus(statusId).length}
            onToggleColumnCollapse={handleToggleColumnCollapse}
            onCollapseAll={handleCollapseAll}
            onResetDefaults={handleResetDefaults}
          />
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
                      isLightColor={isLightColor}
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
                    onMoveToWorktree={hasRunningWorktrees ? handleMoveToWorktree : undefined}
                    hasRunningWorktrees={hasRunningWorktrees}
                    isLightColor={isLightColor}
                    getSubEpicCountsByStatus={(epicId) => subEpicStatusCountsByEpicId[epicId]}
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
              await mutateUpdateEpicStatusAsync(epic, statusId);
            }}
            onAgentChange={async (epic, agentId) => {
              await mutateUpdateEpicAgentAsync(epic, agentId);
            }}
            subEpicCounts={subEpicCountsMap}
            onMoveToWorktree={hasRunningWorktrees ? handleMoveToWorktree : undefined}
            hasRunningWorktrees={hasRunningWorktrees}
            className="flex-1 min-h-0"
          />
        )}

      <BulkEditDialog
        open={bulkModalOpen}
        onOpenChange={(open) => {
          if (open) {
            setBulkModalOpen(true);
          } else {
            handleCloseBulkModal();
          }
        }}
        bulkError={bulkError}
        bulkLoading={bulkLoading}
        rows={bulkRows}
        statuses={sortedStatuses}
        agents={(agentsData?.items ?? []) as Agent[]}
        onRowChange={handleBulkRowChange}
        onClose={handleCloseBulkModal}
        onSubmit={handleBulkSubmit}
        isSubmitting={bulkUpdateMutation.isPending}
        canSubmit={!(bulkLoading || bulkUpdateMutation.isPending || !bulkHasChanges || !bulkTarget)}
        isLightColor={isLightColor}
      />

      <EpicFormDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        editingEpic={editingEpic}
        activeProjectName={activeProject?.name}
        formData={formData}
        onFormDataChange={setFormData}
        parentCandidates={parentCandidates}
        hasParentFilter={!!filters.parent}
        activeParent={activeParent}
        onSubmit={handleSubmit}
        onCancel={() => {
          setShowDialog(false);
          setEditingEpic(null);
          setFormData({ title: '', description: '', tags: '', parentId: 'none' });
        }}
        isSubmitting={createMutation.isPending || updateMutation.isPending}
      />

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

      {/* Move to Worktree Dialog */}
      <MoveToWorktreeDialog
        epic={moveToWorktreeEpic}
        open={!!moveToWorktreeEpic}
        onOpenChange={(open) => !open && setMoveToWorktreeEpic(null)}
        sourceStatuses={sortedStatuses}
        sourceAgents={(agentsData?.items ?? []) as Agent[]}
      />
    </div>
  );
}
