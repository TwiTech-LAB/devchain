import { AlertCircle, FolderOpen } from 'lucide-react';
import { BoardColumn } from '@/ui/components/board/BoardColumn';
import { BoardListView } from '@/ui/components/board/BoardListView';
import { BoardToolbar } from '@/ui/components/board/BoardToolbar';
import { BulkEditDialog } from '@/ui/components/board/BulkEditDialog';
import { CollapsedColumn } from '@/ui/components/board/CollapsedColumn';
import { EpicFormDialog } from '@/ui/components/board/EpicFormDialog';
import { MoveToWorktreeDialog } from '@/ui/components/board/MoveToWorktreeDialog';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import type {
  BoardContentModel,
  BoardPagePresentation,
} from '@/ui/pages/board/board-page-presentation';

function isLightColor(hex: string): boolean {
  const color = hex.replace('#', '');
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

export interface BoardPageViewProps {
  presentation: BoardPagePresentation;
}

function BoardContent({ content }: { content: BoardContentModel }) {
  switch (content.kind) {
    case 'no-project':
      return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Project Selected</h2>
          <p className="text-muted-foreground mb-4">
            Use the project selector in the header to open a project board.
          </p>
        </div>
      );
    case 'loading':
      return (
        <div className="flex justify-center py-8">
          <p className="text-muted-foreground">Loading board...</p>
        </div>
      );
    case 'no-statuses':
      return (
        <div className="flex flex-col items-center justify-center py-16 text-center border rounded-lg">
          <AlertCircle className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Statuses Configured</h2>
          <p className="text-muted-foreground mb-4">
            This project doesn't have any statuses yet. Create statuses to organize your epics.
          </p>
          <Button onClick={content.openStatusManagement}>Go to Status Management</Button>
        </div>
      );
    case 'kanban':
      return (
        <div className="overflow-x-auto flex-1 min-h-0 snap-x snap-mandatory">
          <div className="flex gap-4 sidebar-collapsed:gap-3 w-full h-full">
            {content.columns.map((column) =>
              column.kind === 'collapsed' ? (
                <CollapsedColumn
                  key={column.status.id}
                  status={column.status}
                  count={column.epics.length}
                  epics={column.epics}
                  subEpicCounts={column.subEpicCounts}
                  isLightColor={isLightColor}
                  getAgentName={column.getAgentName}
                  onEpicEdit={column.editEpic}
                  onEpicDelete={column.deleteEpic}
                  onEpicBulkEdit={column.openBulkEdit}
                  onEpicViewDetails={column.openEpicDetails}
                  onEpicToggleParentFilter={column.toggleParentFilter}
                  onExpand={column.expand}
                  onAddEpic={column.addEpic}
                  onDragOver={column.dragOver}
                  onDrop={column.drop}
                  isActiveDrop={column.isActiveDrop}
                  onDragStartEpic={column.dragStart}
                  onDragEndEpic={column.dragEnd}
                />
              ) : (
                <BoardColumn
                  key={column.status.id}
                  status={column.status}
                  epics={column.epics}
                  onAddEpic={column.addEpic}
                  onEditEpic={column.editEpic}
                  onDeleteEpic={column.deleteEpic}
                  onDragStart={column.dragStart}
                  onDragEnd={column.dragEnd}
                  onDragOver={column.dragOver}
                  onDrop={column.drop}
                  isActiveDrop={column.isActiveDrop}
                  draggedEpic={column.draggedEpic}
                  onKeyboardMove={column.keyboardMove}
                  onToggleParentFilter={column.toggleParentFilter}
                  activeParentId={column.activeParentId}
                  statusOrder={column.statusOrder}
                  getAgentName={column.getAgentName}
                  onCollapseColumn={column.collapse}
                  onBulkEdit={column.openBulkEdit}
                  onOpenEpicDetails={column.openEpicDetails}
                  onMoveToWorktree={column.hasRunningWorktrees ? column.moveToWorktree : undefined}
                  hasRunningWorktrees={column.hasRunningWorktrees}
                  isLightColor={isLightColor}
                  getSubEpicCountsByStatus={(epicId) => column.subEpicStatusCountsByEpicId[epicId]}
                  externalSources={column.externalSources}
                />
              ),
            )}
          </div>
        </div>
      );
    case 'list':
      return (
        <BoardListView
          epics={content.epics}
          statuses={content.statuses}
          agents={content.agents}
          isLoading={false}
          pageSize={content.pageSize}
          currentPage={content.currentPage}
          onPageChange={content.changePage}
          onPageSizeChange={content.changePageSize}
          onEditEpic={content.editEpic}
          onDeleteEpic={content.deleteEpic}
          onBulkDelete={content.deleteEpics}
          onViewDetails={content.openEpicDetails}
          onBulkEditEpic={content.openBulkEdit}
          onToggleParentFilter={content.toggleParentFilter}
          onStatusChange={content.changeStatus}
          onAgentChange={content.changeAgent}
          subEpicCounts={content.subEpicCounts}
          onMoveToWorktree={content.hasRunningWorktrees ? content.moveToWorktree : undefined}
          hasRunningWorktrees={content.hasRunningWorktrees}
          externalSources={content.externalSources}
          className="flex-1 min-h-0"
        />
      );
  }
}

export function BoardPageView({ presentation }: BoardPageViewProps) {
  const { header, toolbar, parentBanner, content, dialogs } = presentation;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="mb-4 flex items-start justify-between gap-4 flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold">Epic Board</h1>
          {header.hasProject ? (
            <p className="text-muted-foreground">
              Organize epics for{' '}
              <span className="font-semibold text-foreground">
                {header.projectName ?? 'the selected project'}
              </span>
              .
            </p>
          ) : (
            <p className="text-muted-foreground">
              Select a project from the header to view its Kanban board.
            </p>
          )}
        </div>

        {toolbar && (
          <BoardToolbar
            projectId={toolbar.projectId}
            currentViewMode={toolbar.currentViewMode}
            onViewModeChange={toolbar.changeViewMode}
            filters={toolbar.filters}
            onApplySavedFilter={toolbar.applySavedFilter}
            hasActiveFilters={toolbar.hasActiveFilters}
            filterPopoverOpen={toolbar.filterPopoverOpen}
            onFilterPopoverOpenChange={toolbar.changeFilterPopoverOpen}
            statuses={toolbar.statuses}
            onSelectAllStatuses={toolbar.clearStatuses}
            onToggleStatusFilter={toolbar.toggleStatus}
            onToggleArchived={toolbar.changeArchivedVisible}
            columnPickerOpen={toolbar.columnPickerOpen}
            onColumnPickerOpenChange={toolbar.changeColumnPickerOpen}
            collapsedStatusIds={toolbar.collapsedStatusIds}
            getStatusEpicCount={(statusId) => toolbar.statusEpicCounts[statusId] ?? 0}
            onToggleColumnCollapse={toolbar.toggleColumn}
            onCollapseAll={toolbar.collapseAll}
            onResetDefaults={toolbar.resetDefaults}
          />
        )}
      </div>

      {parentBanner && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
          data-testid="parent-banner"
        >
          <div className="text-sm text-muted-foreground">
            Showing sub-epics for{' '}
            <span className="font-semibold text-foreground">{parentBanner.parentName}</span>
          </div>
          <div className="flex items-center gap-2">
            {parentBanner.isLoading && (
              <span className="text-xs text-muted-foreground">Loading sub-epics…</span>
            )}
            <Button variant="outline" size="sm" onClick={parentBanner.clear}>
              Clear filter
            </Button>
          </div>
        </div>
      )}

      <BoardContent content={content} />

      <BulkEditDialog
        controller={dialogs.bulkEdit.controller}
        statuses={dialogs.bulkEdit.statuses}
        agents={dialogs.bulkEdit.agents}
        isLightColor={isLightColor}
      />

      <EpicFormDialog
        open={dialogs.create.isOpen}
        onOpenChange={dialogs.create.changeOpen}
        activeProjectName={dialogs.create.activeProjectName}
        formData={dialogs.create.formData}
        onFormDataChange={dialogs.create.changeForm}
        parentCandidates={dialogs.create.parentCandidates}
        hasParentFilter={dialogs.create.hasParentFilter}
        activeParent={dialogs.create.activeParent}
        onSubmit={dialogs.create.submit}
        onCancel={dialogs.create.cancel}
        isSubmitting={dialogs.create.isSubmitting}
      />

      <Dialog open={dialogs.deleteEpic.epic !== null} onOpenChange={dialogs.deleteEpic.changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Epic</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{dialogs.deleteEpic.epic?.title}</strong>?
              This action cannot be undone and will also delete all associated records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dialogs.deleteEpic.close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={dialogs.deleteEpic.confirm}
              disabled={dialogs.deleteEpic.isSubmitting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogs.bulkDelete.isOpen} onOpenChange={dialogs.bulkDelete.changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {dialogs.bulkDelete.epicCount} Epic
              {dialogs.bulkDelete.epicCount > 1 ? 's' : ''}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <strong>
                {dialogs.bulkDelete.epicCount} epic
                {dialogs.bulkDelete.epicCount > 1 ? 's' : ''}
              </strong>
              ? This action cannot be undone and will also delete all associated records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dialogs.bulkDelete.close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={dialogs.bulkDelete.confirm}
              disabled={dialogs.bulkDelete.isSubmitting}
            >
              Delete All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MoveToWorktreeDialog
        epic={dialogs.moveToWorktree.epic}
        open={dialogs.moveToWorktree.epic !== null}
        onOpenChange={dialogs.moveToWorktree.changeOpen}
        sourceStatuses={dialogs.moveToWorktree.statuses}
        sourceAgents={dialogs.moveToWorktree.agents}
      />
    </div>
  );
}
