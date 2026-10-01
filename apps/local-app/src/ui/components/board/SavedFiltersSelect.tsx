import { useState, useCallback, useEffect, useMemo } from 'react';
import { Bookmark, Plus, Pencil, Trash2, Check, ChevronDown, Star } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { useToast } from '@/ui/hooks/use-toast';
import { cn } from '@/ui/lib/utils';
import {
  getSavedFilters,
  saveFilter,
  renameFilter,
  deleteFilter,
  isFilterActive,
  getDefaultFilterId,
  setDefaultFilterId,
  clearDefaultFilterId,
  SavedFilter,
} from '@/ui/lib/saved-filters';
import { serializeBoardFilters, BoardFilterParams } from '@/ui/lib/url-filters';

/** Exclude pagination params from filter state for saving/comparing */
function withoutPagination(
  filters: BoardFilterParams,
): Omit<BoardFilterParams, 'page' | 'pageSize'> {
  const { page, pageSize, ...rest } = filters;
  void page;
  void pageSize;
  return rest;
}

export interface SavedFiltersSelectProps {
  /** Project ID for scoping saved filters */
  projectId: string;
  /** Current filter state to save */
  currentFilters: BoardFilterParams;
  /** Called when a saved filter is applied */
  onApply: (qs: string) => void;
  /** Optional className for the trigger button */
  className?: string;
}

/**
 * SavedFiltersSelect - Dropdown for managing saved board filters
 *
 * Features:
 * - List saved filters with apply on click
 * - Save current filter state with name
 * - Rename/delete saved filters inline
 * - Toast feedback for all actions
 */
export function SavedFiltersSelect({
  projectId,
  currentFilters,
  onApply,
  className,
}: SavedFiltersSelectProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<SavedFilter[]>([]);

  // URL-derived active filter IDs — any saved filter whose qs matches current URL params
  const activeFilterIds = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    for (const f of filters) {
      if (isFilterActive(f, currentFilters)) set.add(f.id);
    }
    return set;
  }, [filters, currentFilters]);

  // Default filter state
  const [defaultId, setDefaultId] = useState<string | null>(() => getDefaultFilterId(projectId));

  const reloadDefaultId = useCallback(() => {
    setDefaultId(getDefaultFilterId(projectId));
  }, [projectId]);

  // Dialog states
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingFilter, setEditingFilter] = useState<SavedFilter | null>(null);
  const [filterName, setFilterName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  // Load filters from localStorage
  const loadFilters = useCallback(() => {
    const loaded = getSavedFilters(projectId);
    setFilters(loaded);
  }, [projectId]);

  useEffect(() => {
    loadFilters();
    reloadDefaultId();
  }, [loadFilters, reloadDefaultId]);

  // Check if current filters have any active state (excluding pagination)
  const hasActiveFilters = useCallback(() => {
    const filterParams = withoutPagination(currentFilters);
    return Object.keys(filterParams).length > 0;
  }, [currentFilters]);

  // Max length for filter names
  const MAX_FILTER_NAME_LENGTH = 50;

  // Validate filter name
  const validateName = useCallback(
    (name: string, excludeId?: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return 'Filter name cannot be empty';
      }
      if (trimmed.length > MAX_FILTER_NAME_LENGTH) {
        return `Name must be ${MAX_FILTER_NAME_LENGTH} characters or less`;
      }
      // Check for duplicates (excluding current filter if renaming)
      const exists = filters.some(
        (f) => f.id !== excludeId && f.name.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (exists) {
        return `A filter named "${trimmed}" already exists`;
      }
      return null;
    },
    [filters],
  );

  // Handle apply filter
  const handleApply = useCallback(
    (filter: SavedFilter) => {
      onApply(filter.qs);
      setOpen(false);
      toast({
        title: 'Filter applied',
        description: `"${filter.name}" applied`,
      });
    },
    [onApply, toast],
  );

  // Handle save new filter
  const handleOpenSaveDialog = useCallback(() => {
    if (!hasActiveFilters()) {
      toast({
        title: 'No filters to save',
        description: 'Apply some filters first before saving.',
        variant: 'destructive',
      });
      return;
    }
    setFilterName('');
    setNameError(null);
    setSaveDialogOpen(true);
  }, [hasActiveFilters, toast]);

  const handleSave = useCallback(() => {
    const error = validateName(filterName);
    if (error) {
      setNameError(error);
      return;
    }

    try {
      // Exclude pagination from saved filters
      const filterParams = withoutPagination(currentFilters);
      const qs = serializeBoardFilters(filterParams);
      const newFilter = saveFilter(projectId, filterName.trim(), qs);
      loadFilters();
      setSaveDialogOpen(false);
      setOpen(false);
      toast({
        title: 'Filter saved',
        description: `"${newFilter.name}" saved`,
      });
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to save filter');
    }
  }, [filterName, validateName, currentFilters, projectId, loadFilters, toast]);

  // Handle rename filter
  const handleOpenRenameDialog = useCallback((filter: SavedFilter) => {
    setEditingFilter(filter);
    setFilterName(filter.name);
    setNameError(null);
    setRenameDialogOpen(true);
  }, []);

  const handleRename = useCallback(() => {
    if (!editingFilter) return;

    const error = validateName(filterName, editingFilter.id);
    if (error) {
      setNameError(error);
      return;
    }

    try {
      renameFilter(projectId, editingFilter.id, filterName.trim());
      loadFilters();
      setRenameDialogOpen(false);
      setEditingFilter(null);
      toast({
        title: 'Filter renamed',
        description: `Renamed to "${filterName.trim()}"`,
      });
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to rename filter');
    }
  }, [editingFilter, filterName, validateName, projectId, loadFilters, toast]);

  // Handle delete filter
  const handleOpenDeleteDialog = useCallback((filter: SavedFilter) => {
    setEditingFilter(filter);
    setDeleteDialogOpen(true);
  }, []);

  const handleDelete = useCallback(() => {
    if (!editingFilter) return;

    try {
      deleteFilter(projectId, editingFilter.id);
      loadFilters();
      reloadDefaultId();
      setDeleteDialogOpen(false);
      toast({
        title: 'Filter deleted',
        description: `"${editingFilter.name}" deleted`,
      });
      setEditingFilter(null);
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to delete filter',
        variant: 'destructive',
      });
    }
  }, [editingFilter, projectId, loadFilters, reloadDefaultId, toast]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn('gap-1.5', className)}
            aria-label="Saved filters"
          >
            <Bookmark className="h-4 w-4" />
            {activeFilterIds.size === 1
              ? (filters.find((f) => activeFilterIds.has(f.id))?.name ?? 'Saved')
              : 'Saved'}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <div className="flex flex-col">
            {/* Header with save button */}
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-medium">Saved Filters</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2"
                onClick={handleOpenSaveDialog}
                disabled={!hasActiveFilters()}
              >
                <Plus className="h-3.5 w-3.5" />
                Save
              </Button>
            </div>

            {/* Filter list */}
            <div className="max-h-64 overflow-y-auto">
              {filters.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No saved filters
                </div>
              ) : (
                <div className="py-1">
                  {filters.map((filter) => {
                    const isActive = activeFilterIds.has(filter.id);
                    const isDefault = defaultId === filter.id;
                    return (
                      <div
                        key={filter.id}
                        className={cn(
                          'group flex items-center gap-2 px-3 py-2 cursor-pointer',
                          isActive ? 'bg-selected border-l-2 border-l-primary' : 'hover:bg-accent',
                        )}
                      >
                        <button
                          className="h-5 w-5 shrink-0 flex items-center justify-center rounded-sm hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isDefault) {
                              clearDefaultFilterId(projectId);
                            } else {
                              setDefaultFilterId(projectId, filter.id);
                            }
                            reloadDefaultId();
                          }}
                          aria-label={isDefault ? 'Unset default filter' : 'Set as default filter'}
                        >
                          <Star
                            className={cn(
                              'h-3.5 w-3.5',
                              isDefault
                                ? 'fill-status-warn text-status-warn'
                                : 'text-muted-foreground',
                            )}
                          />
                        </button>
                        <button
                          className="flex-1 text-left text-sm truncate flex items-center gap-1.5"
                          onClick={() => handleApply(filter)}
                        >
                          <span className="truncate">{filter.name}</span>
                          {isDefault && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-status-warn/10 px-1 py-0.5 text-[10px] font-medium text-status-warn shrink-0">
                              ★ Default
                            </span>
                          )}
                        </button>
                        {isActive && <Check className="h-4 w-4 text-primary shrink-0" />}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenRenameDialog(filter);
                            }}
                            aria-label={`Rename "${filter.name}"`}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenDeleteDialog(filter);
                            }}
                            aria-label={`Delete "${filter.name}"`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Save Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Filter</DialogTitle>
            <DialogDescription>
              Save the current filter configuration for quick access later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="filter-name">Name</Label>
              <Input
                id="filter-name"
                value={filterName}
                onChange={(e) => {
                  setFilterName(e.target.value);
                  setNameError(null);
                }}
                placeholder="e.g., Active bugs, My tasks"
                className={cn(nameError && 'border-destructive')}
                maxLength={MAX_FILTER_NAME_LENGTH}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSave();
                  }
                }}
              />
              {nameError && <p className="text-sm text-destructive">{nameError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!filterName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Filter</DialogTitle>
            <DialogDescription>Enter a new name for this saved filter.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="rename-filter-name">Name</Label>
              <Input
                id="rename-filter-name"
                value={filterName}
                onChange={(e) => {
                  setFilterName(e.target.value);
                  setNameError(null);
                }}
                placeholder="Filter name"
                className={cn(nameError && 'border-destructive')}
                maxLength={MAX_FILTER_NAME_LENGTH}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleRename();
                  }
                }}
              />
              {nameError && <p className="text-sm text-destructive">{nameError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={!filterName.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Filter</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{editingFilter?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
