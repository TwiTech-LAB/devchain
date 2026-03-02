import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { BulkEditRow } from '@/ui/components/board/BulkEditDialog';
import type { EpicFormData } from '@/ui/components/board/EpicFormDialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useBoardFilters } from '@/ui/hooks/useBoardFilters';
import { useBoardData } from '@/ui/hooks/useBoardData';
import { useBoardSync } from '@/ui/hooks/useBoardSync';
import { useBoardMutations } from '@/ui/hooks/useBoardMutations';
import { useBoardDragDrop } from '@/ui/hooks/useBoardDragDrop';
import {
  parseBoardFilters,
  serializeBoardFilters,
  type BoardFilterParams,
} from '@/ui/lib/url-filters';
import { fetchSubEpics } from '@/ui/pages/board/lib/board-api';
import type { Epic, Status } from '@/ui/types';

interface BoardViewPreferences {
  collapsedStatusIds: string[];
  autoCollapseEmpty: boolean;
  explicitlyExpandedStatusIds: string[];
  viewMode: 'kanban' | 'list';
  listPageSize: number;
}

const BOARD_PREFS_KEY_PREFIX = 'devchain:board:columns:';

function getBoardPreferences(projectId: string): BoardViewPreferences {
  const key = `${BOARD_PREFS_KEY_PREFIX}${projectId}`;
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
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

export function useBoardPageController() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();
  const { activeWorktree, worktrees } = useOptionalWorktreeTab();
  const hasRunningWorktrees =
    activeWorktree === null && worktrees.some((wt) => wt.status === 'running');
  const [showDialog, setShowDialog] = useState(false);
  const [editingEpic, setEditingEpic] = useState<Epic | null>(null);
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
  const [bulkRows, setBulkRows] = useState<BulkEditRow[]>([]);
  const [bulkBaseline, setBulkBaseline] = useState<
    Record<string, { statusId: string; agentId: string | null }>
  >({});
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  // URL → UI hydration (read-only in this epic)
  const { filters } = useBoardFilters();
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

  const {
    createMutation,
    updateMutation,
    deleteMutation,
    bulkUpdateMutation,
    mutateDeleteEpic,
    deleteEpicsByIds,
    mutateUpdateEpicStatus,
    mutateUpdateEpicStatusAsync,
    mutateUpdateEpicAgentAsync,
    mutateBulkUpdate,
  } = useBoardMutations({
    epicsKey,
    toast,
    onCreateSuccess: () => {
      setShowDialog(false);
      setFormData({ title: '', description: '', tags: '', parentId: 'none' });
    },
    onUpdateSuccess: () => {
      setShowDialog(false);
      setEditingEpic(null);
      setFormData({ title: '', description: '', tags: '', parentId: 'none' });
    },
    onDeleteSettled: () => {
      setDeleteConfirm(null);
    },
    onBulkSuccess: () => {
      setBulkModalOpen(false);
      setBulkTarget(null);
      setBulkRows([]);
      setBulkBaseline({});
      setBulkError(null);
      setBulkLoading(false);
    },
    onBulkError: setBulkError,
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

  // Display name for parent banner: prefer resolved epic title, fallback to id/slug from URL filters
  const activeParentName = useMemo(() => {
    if (activeParent?.title) return activeParent.title;
    return filters.parent ?? null;
  }, [activeParent?.title, filters.parent]);

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
    if (
      activeParentId &&
      !(epicsData?.items ?? []).some((epic: Epic) => epic.id === activeParentId)
    ) {
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

  const handleMoveToWorktree = useCallback((epic: Epic) => {
    setMoveToWorktreeEpic(epic);
  }, []);

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

  useEffect(() => {
    if (!bulkTarget) return;

    let cancelled = false;
    setBulkLoading(true);
    setBulkError(null);

    const resolvedParent =
      (epicsData?.items ?? []).find((item: Epic) => item.id === bulkTarget.id) ?? bulkTarget;

    (async () => {
      try {
        const subEpics = await fetchSubEpics(bulkTarget.id);
        if (cancelled) return;
        const children = Array.isArray(subEpics?.items) ? (subEpics.items as Epic[]) : [];
        const rows: BulkEditRow[] = [
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

    mutateBulkUpdate({
      rows: bulkRows,
      baseline: bulkBaseline,
      parentId: bulkTarget.id,
    });
  }, [bulkTarget, bulkHasChanges, bulkRows, bulkBaseline, mutateBulkUpdate, toast]);

  const confirmDelete = () => {
    if (deleteConfirm) {
      mutateDeleteEpic(deleteConfirm.id);
    }
  };

  // Bulk delete handlers for list view multi-select
  const handleBulkDelete = useCallback((epicIds: string[]) => {
    if (epicIds.length === 0) return;
    setBulkDeleteIds(epicIds);
  }, []);

  const confirmBulkDelete = async () => {
    if (!bulkDeleteIds || bulkDeleteIds.length === 0) return;
    await deleteEpicsByIds(bulkDeleteIds);
    setBulkDeleteIds(null);
    toast({
      title: 'Success',
      description: `Deleted ${bulkDeleteIds.length} epic${bulkDeleteIds.length > 1 ? 's' : ''} successfully`,
    });
  };

  useBoardSync({ selectedProjectId, parentFilter: filters.parent });
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

  return {
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
  };
}

export type BoardPageController = ReturnType<typeof useBoardPageController>;
