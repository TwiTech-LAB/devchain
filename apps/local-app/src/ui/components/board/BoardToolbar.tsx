import { Filter, LayoutGrid, List, Settings2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Switch } from '@/ui/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { SavedFiltersSelect } from '@/ui/components/board/SavedFiltersSelect';
import { cn } from '@/ui/lib/utils';
import type { BoardFilterParams } from '@/ui/lib/url-filters';
import type { Status } from './types';

export interface BoardToolbarProps {
  projectId: string;
  currentViewMode: 'kanban' | 'list';
  onViewModeChange: (mode: 'kanban' | 'list') => void;
  filters: BoardFilterParams;
  onApplySavedFilter: (queryString: string) => void;
  hasActiveFilters: boolean;
  filterPopoverOpen: boolean;
  onFilterPopoverOpenChange: (open: boolean) => void;
  statuses: Status[];
  onSelectAllStatuses: () => void;
  onToggleStatusFilter: (statusId: string) => void;
  onToggleArchived: (showArchived: boolean) => void;
  columnPickerOpen: boolean;
  onColumnPickerOpenChange: (open: boolean) => void;
  collapsedStatusIds: string[];
  getStatusEpicCount: (statusId: string) => number;
  onToggleColumnCollapse: (statusId: string) => void;
  onCollapseAll: () => void;
  onResetDefaults: () => void;
}

export function BoardToolbar({
  projectId,
  currentViewMode,
  onViewModeChange,
  filters,
  onApplySavedFilter,
  hasActiveFilters,
  filterPopoverOpen,
  onFilterPopoverOpenChange,
  statuses,
  onSelectAllStatuses,
  onToggleStatusFilter,
  onToggleArchived,
  columnPickerOpen,
  onColumnPickerOpenChange,
  collapsedStatusIds,
  getStatusEpicCount,
  onToggleColumnCollapse,
  onCollapseAll,
  onResetDefaults,
}: BoardToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center border rounded-md">
        <Button
          variant={currentViewMode === 'kanban' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewModeChange('kanban')}
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
          onClick={() => onViewModeChange('list')}
          aria-label="List view"
          aria-pressed={currentViewMode === 'list'}
          className="rounded-l-none"
        >
          <List className="h-4 w-4 mr-1.5" />
          List
        </Button>
      </div>

      <SavedFiltersSelect
        projectId={projectId}
        currentFilters={filters}
        onApply={onApplySavedFilter}
      />

      <Popover open={filterPopoverOpen} onOpenChange={onFilterPopoverOpenChange}>
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

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Status</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={onSelectAllStatuses}
                  disabled={!filters.status || filters.status.length === 0}
                >
                  Clear
                </Button>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {statuses.map((status) => {
                  const isChecked =
                    !filters.status ||
                    filters.status.length === 0 ||
                    filters.status.includes(status.id);
                  return (
                    <div key={status.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`filter-st-${status.id}`}
                        checked={isChecked}
                        onCheckedChange={() => onToggleStatusFilter(status.id)}
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

            <div className="pt-3 border-t">
              <div className="flex items-center justify-between">
                <label htmlFor="filter-archived" className="text-sm cursor-pointer flex-1">
                  Show Archived
                </label>
                <Switch
                  id="filter-archived"
                  checked={filters.archived === 'all'}
                  onCheckedChange={onToggleArchived}
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

      <Popover open={columnPickerOpen} onOpenChange={onColumnPickerOpenChange}>
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
              {statuses.map((status) => {
                const isManuallyCollapsed = collapsedStatusIds.includes(status.id);
                return (
                  <div key={status.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`col-${status.id}`}
                      checked={!isManuallyCollapsed}
                      onCheckedChange={() => onToggleColumnCollapse(status.id)}
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
                        {getStatusEpicCount(status.id)}
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
                onClick={onCollapseAll}
                className="flex-1 text-xs"
              >
                Collapse All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onResetDefaults}
                className="flex-1 text-xs"
              >
                Reset
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
