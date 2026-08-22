import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EpicFormData } from '@/ui/components/board/EpicFormDialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { useBoardData } from '@/ui/hooks/useBoardData';
import { useBoardSync } from '@/ui/hooks/useBoardSync';
import { useBoardMutations } from '@/ui/hooks/useBoardMutations';
import { useBoardDragDrop } from '@/ui/hooks/useBoardDragDrop';
import { useEpicExternalSourcesBatch } from '@/ui/hooks/useEpicExternalSourcesBatch';
import { useBoardBulkEdit } from '@/ui/hooks/board/useBoardBulkEdit';
import { useBoardRouteState } from '@/ui/hooks/board/useBoardRouteState';
import { useBoardViewPreferences } from '@/ui/hooks/board/useBoardViewPreferences';
import type { Agent, Epic, Status } from '@/ui/types';
import type {
  BoardContentModel,
  BoardKanbanColumnModel,
  BoardPagePresentation,
} from '@/ui/pages/board/board-page-presentation';

export function useBoardPageController(): BoardPagePresentation {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();
  const { activeWorktree, worktrees } = useOptionalWorktreeTab();
  const hasRunningWorktrees =
    activeWorktree === null && worktrees.some((wt) => wt.status === 'running');
  const [showDialog, setShowDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Epic | null>(null);
  const [moveToWorktreeEpic, setMoveToWorktreeEpic] = useState<Epic | null>(null);
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null);
  const [selectedStatusId, setSelectedStatusId] = useState<string>('');
  const [formData, setFormData] = useState<EpicFormData>({
    title: '',
    description: '',
    tags: '',
    parentId: 'none',
  });
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const bulkEdit = useBoardBulkEdit({ selectedProjectId });
  const integrationAvailability = useIntegrationAvailability();

  const routeState = useBoardRouteState({ selectedProjectId });
  const { filters } = routeState;
  const {
    epicsKey,
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
  } = useBoardData({ selectedProjectId, filters });

  const viewPreferences = useBoardViewPreferences({
    selectedProjectId,
    parentFilter: filters.parent,
    routeView: filters.view,
    routePageSize: filters.pageSize,
    onRouteViewChange: routeState.setView,
    onRoutePageSizeChange: routeState.setPageSize,
  });
  const { preferences: boardPrefs, currentViewMode, currentPageSize } = viewPreferences;

  const resetCreateDialog = useCallback(() => {
    setShowDialog(false);
    setFormData({ title: '', description: '', tags: '', parentId: 'none' });
  }, []);

  const {
    createMutation,
    deleteMutation,
    mutateDeleteEpic,
    deleteEpicsByIds,
    mutateUpdateEpicStatus,
    mutateUpdateEpicStatusAsync,
    mutateUpdateEpicAgentAsync,
  } = useBoardMutations({
    epicsKey,
    toast,
    onCreateSuccess: resetCreateDialog,
    onDeleteSettled: () => {
      setDeleteConfirm(null);
    },
  });

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

  const handleToggleStatusFilter = useCallback(
    (statusId: string): void => {
      routeState.toggleStatus(
        statusId,
        sortedStatuses.map((status: Status) => status.id),
      );
    },
    [routeState, sortedStatuses],
  );

  const handleCollapseAll = useCallback((): void => {
    viewPreferences.collapseAll(sortedStatuses.map((status: Status) => status.id));
  }, [sortedStatuses, viewPreferences]);

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

    createMutation.mutate({
      projectId: selectedProjectId,
      statusId: selectedStatusId,
      title: formData.title,
      description: formData.description || null,
      tags,
      parentId: formData.parentId === 'none' ? null : formData.parentId,
    });
  };

  const handleEdit = useCallback(
    (epic: Epic) => {
      navigate(`/epics/${epic.id}?edit=1`);
    },
    [navigate],
  );

  const openEpicDetails = useCallback((epic: Epic) => navigate(`/epics/${epic.id}`), [navigate]);

  const openStatusManagement = useCallback(() => navigate('/statuses'), [navigate]);

  const handleDelete = useCallback((epic: Epic) => {
    setDeleteConfirm(epic);
  }, []);

  const handleMoveToWorktree = useCallback((epic: Epic) => {
    setMoveToWorktreeEpic(epic);
  }, []);

  const handleToggleParentFilter = useCallback(
    (epic: Epic) => {
      if (epic.parentId) return; // only top-level epics can be parent filters
      routeState.setParent(filters.parent === epic.id ? null : epic.id);
    },
    [filters.parent, routeState],
  );

  const clearParentFilter = useCallback((): void => {
    routeState.setParent(null);
  }, [routeState]);

  const confirmDelete = useCallback(() => {
    if (deleteConfirm) {
      mutateDeleteEpic(deleteConfirm.id);
    }
  }, [deleteConfirm, mutateDeleteEpic]);

  // Bulk delete handlers for list view multi-select
  const handleBulkDelete = useCallback((epicIds: string[]) => {
    if (epicIds.length === 0) return;
    setBulkDeleteIds(epicIds);
  }, []);

  const confirmBulkDelete = useCallback(async () => {
    if (!bulkDeleteIds || bulkDeleteIds.length === 0) return;
    await deleteEpicsByIds(bulkDeleteIds);
    setBulkDeleteIds(null);
    toast({
      title: 'Success',
      description: `Deleted ${bulkDeleteIds.length} epic${bulkDeleteIds.length > 1 ? 's' : ''} successfully`,
    });
  }, [bulkDeleteIds, deleteEpicsByIds, toast]);

  useBoardSync({ selectedProjectId, parentFilter: filters.parent });

  // Source IDs come from the loaded Board context BEFORE status and search
  // filters so filter changes never create a new batch key. A parent filter
  // batches the loaded sub-epics; otherwise the loaded root epics.
  const sourceEpicIds = useMemo(() => {
    const items = filters.parent
      ? ((subEpicsData?.items ?? []) as Epic[])
      : ((epicsData?.items ?? []) as Epic[]).filter((epic) => !epic.parentId);
    // Deduplication and sort belong to the batch hook, which owns the cache key.
    return items.map((epic) => epic.id);
  }, [filters.parent, epicsData, subEpicsData]);

  // One bounded local read; worktree, unresolved, admission-off, and empty
  // contexts issue no request and see no cached data. Failures leave the map
  // empty — source notes are decoration, never a Board blocker.
  const { sources: externalSources } = useEpicExternalSourcesBatch(sourceEpicIds, {
    enabled: integrationAvailability.canUseIntegrations,
  });
  const externalSourceMap = externalSources ?? new Map();

  const {
    draggedEpic,
    activeDropStatusId,
    handleDragStart,
    handleDragEnd,
    handleDragOverStatus,
    handleDrop,
  } = useBoardDragDrop({
    epicsKey,
    parentFilter: filters.parent,
    onDropStatusChange: mutateUpdateEpicStatus,
  });

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
      mutateUpdateEpicStatus(epic, targetStatusId);

      toast({
        title: 'Moved',
        description: `Epic moved to ${sortedStatuses[targetIndex].label}`,
      });
    },
    [sortedStatuses, mutateUpdateEpicStatus, toast],
  );

  const handleAddEpic = useCallback(
    (statusId: string) => {
      setSelectedStatusId(statusId);
      setFormData({
        title: '',
        description: '',
        tags: '',
        parentId: filters.parent ?? 'none',
      });
      setShowDialog(true);
    },
    [filters.parent],
  );

  const changeCreateDialogOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setShowDialog(true);
      } else {
        resetCreateDialog();
      }
    },
    [resetCreateDialog],
  );
  const changeCreateForm = useCallback((data: EpicFormData) => setFormData(data), []);
  const closeDeleteDialog = useCallback(() => setDeleteConfirm(null), []);
  const closeBulkDeleteDialog = useCallback(() => setBulkDeleteIds(null), []);
  const changeDeleteDialogOpen = useCallback(
    (open: boolean) => !open && setDeleteConfirm(null),
    [],
  );
  const changeBulkDeleteDialogOpen = useCallback(
    (open: boolean) => !open && setBulkDeleteIds(null),
    [],
  );
  const changeMoveToWorktreeDialogOpen = useCallback(
    (open: boolean) => !open && setMoveToWorktreeEpic(null),
    [],
  );
  const changeFilterPopoverOpen = useCallback((open: boolean) => setFilterPopoverOpen(open), []);
  const changeColumnPickerOpen = useCallback((open: boolean) => setColumnPickerOpen(open), []);

  const statusEpicCounts = Object.fromEntries(
    sortedStatuses.map((status) => [status.id, getEpicsByStatus(status.id).length]),
  );

  const columns: BoardKanbanColumnModel[] = visibleStatuses.map((status) => {
    const epics = getEpicsByStatus(status.id);
    const common = {
      status,
      epics,
      activeParentId: filters.parent ?? null,
      isActiveDrop: activeDropStatusId === status.id,
      statusOrder: sortedStatuses,
      subEpicCounts: subEpicCountsMap,
      subEpicStatusCountsByEpicId,
      hasRunningWorktrees,
      getAgentName,
      addEpic: handleAddEpic,
      editEpic: handleEdit,
      deleteEpic: handleDelete,
      openBulkEdit: bulkEdit.open,
      openEpicDetails,
      toggleParentFilter: handleToggleParentFilter,
      moveToWorktree: handleMoveToWorktree,
      dragStart: handleDragStart,
      dragEnd: handleDragEnd,
      dragOver: () => handleDragOverStatus(status.id),
      drop: () => handleDrop(status.id),
    };

    if (viewPreferences.isColumnCollapsed(status.id, epics.length === 0)) {
      return {
        ...common,
        kind: 'collapsed',
        expand: () => viewPreferences.expandColumn(status.id),
      };
    }

    return {
      ...common,
      kind: 'expanded',
      draggedEpic,
      externalSources: externalSourceMap,
      collapse: () => viewPreferences.toggleColumnCollapse(status.id),
      keyboardMove: handleKeyboardMove,
    };
  });

  let content: BoardContentModel;
  if (!selectedProjectId) {
    content = { kind: 'no-project' };
  } else if (statusesLoading) {
    content = { kind: 'loading' };
  } else if (sortedStatuses.length === 0) {
    content = { kind: 'no-statuses', openStatusManagement };
  } else if (currentViewMode === 'kanban') {
    content = { kind: 'kanban', columns };
  } else {
    const sourceEpics = filters.parent
      ? ((subEpicsData?.items ?? []) as Epic[])
      : ((epicsData?.items ?? []) as Epic[]).filter((epic) => !epic.parentId);
    content = {
      kind: 'list',
      epics: filterEpicsByStatus(sourceEpics),
      statuses: sortedStatuses,
      agents: (agentsData?.items ?? []) as Agent[],
      pageSize: currentPageSize,
      currentPage: filters.page ?? 1,
      subEpicCounts: subEpicCountsMap,
      hasRunningWorktrees,
      changePage: routeState.setPage,
      changePageSize: viewPreferences.changePageSize,
      editEpic: handleEdit,
      deleteEpic: handleDelete,
      deleteEpics: handleBulkDelete,
      openEpicDetails,
      openBulkEdit: bulkEdit.open,
      toggleParentFilter: handleToggleParentFilter,
      changeStatus: async (epic, statusId) => {
        await mutateUpdateEpicStatusAsync(epic, statusId);
      },
      changeAgent: async (epic, agentId) => {
        await mutateUpdateEpicAgentAsync(epic, agentId);
      },
      moveToWorktree: handleMoveToWorktree,
      externalSources: externalSourceMap,
    };
  }

  return {
    header: {
      hasProject: Boolean(selectedProjectId),
      projectName: activeProject?.name ?? null,
    },
    toolbar:
      selectedProjectId && !statusesLoading && sortedStatuses.length > 0
        ? {
            projectId: selectedProjectId,
            currentViewMode,
            filters,
            hasActiveFilters: routeState.hasActiveFilters,
            filterPopoverOpen,
            columnPickerOpen,
            statuses: sortedStatuses,
            collapsedStatusIds: boardPrefs.collapsedStatusIds,
            statusEpicCounts,
            changeViewMode: viewPreferences.changeViewMode,
            applySavedFilter: routeState.applySavedFilter,
            changeFilterPopoverOpen,
            clearStatuses: routeState.clearStatuses,
            toggleStatus: handleToggleStatusFilter,
            changeArchivedVisible: routeState.setArchivedVisible,
            changeColumnPickerOpen,
            toggleColumn: viewPreferences.toggleColumnCollapse,
            collapseAll: handleCollapseAll,
            resetDefaults: viewPreferences.resetDefaults,
          }
        : null,
    parentBanner: filters.parent
      ? {
          parentName: activeParent?.title || filters.parent,
          isLoading: subEpicsLoading,
          clear: clearParentFilter,
        }
      : null,
    content,
    dialogs: {
      create: {
        isOpen: showDialog,
        activeProjectName: activeProject?.name,
        formData,
        parentCandidates,
        hasParentFilter: Boolean(filters.parent),
        activeParent,
        isSubmitting: createMutation.isPending,
        changeOpen: changeCreateDialogOpen,
        changeForm: changeCreateForm,
        cancel: resetCreateDialog,
        submit: handleSubmit,
      },
      deleteEpic: {
        epic: deleteConfirm,
        isSubmitting: deleteMutation.isPending,
        changeOpen: changeDeleteDialogOpen,
        close: closeDeleteDialog,
        confirm: confirmDelete,
      },
      bulkDelete: {
        epicCount: bulkDeleteIds?.length ?? 0,
        isOpen: bulkDeleteIds !== null,
        isSubmitting: deleteMutation.isPending,
        changeOpen: changeBulkDeleteDialogOpen,
        close: closeBulkDeleteDialog,
        confirm: confirmBulkDelete,
      },
      bulkEdit: {
        controller: bulkEdit,
        statuses: sortedStatuses,
        agents: (agentsData?.items ?? []) as Agent[],
      },
      moveToWorktree: {
        epic: moveToWorktreeEpic,
        statuses: sortedStatuses,
        agents: (agentsData?.items ?? []) as Agent[],
        changeOpen: changeMoveToWorktreeDialogOpen,
      },
    },
  };
}
