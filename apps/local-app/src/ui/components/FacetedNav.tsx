import { useMemo, useCallback, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { cn } from '../lib/utils';
import { X, Tag as TagIcon, Pencil, Check, GitMerge, ArrowRight } from 'lucide-react';
import { extractFacets, getFacetDisplayName } from '../lib/tags';

interface FacetedNavProps {
  /**
   * All available tags from the current result set
   */
  allTags: string[];

  /**
   * Tags visible in the currently filtered documents (optional).
   * When provided and "hide unmatched" is enabled, facet values not present here are hidden.
   */
  visibleTags?: string[];

  /**
   * Selected facets: Map of facet key -> Set of selected values
   */
  selectedFacets: Map<string, Set<string>>;

  /**
   * Callback when facets selection changes
   */
  onFacetsChange: (selectedFacets: Map<string, Set<string>>) => void;

  /**
   * Current grouping key (null for no grouping)
   */
  groupByKey: string | null;

  /**
   * Callback when grouping key changes
   */
  onGroupByKeyChange: (key: string | null) => void;

  /**
   * Additional CSS classes
   */
  className?: string;

  /**
   * Optional: Called when user toggles Edit mode
   */
  onToggleEditMode?: (edit: boolean) => void;

  /**
   * Optional: Request to rename a tag value (and optionally key)
   */
  onRequestRename?: (
    item: { key: string; value: string },
    next: { key?: string; value?: string },
  ) => void;

  /**
   * Optional: Request to merge multiple source values into a destination (same or cross key)
   */
  onRequestMerge?: (
    sources: { key: string; value: string }[],
    destination: { key: string; value: string },
  ) => void;

  /**
   * Optional: Request to move multiple values to another key (no merge)
   */
  onRequestMove?: (sources: { key: string; value: string }[], destinationKey: string) => void;
}

/**
 * FacetedNav displays faceted navigation with multi-select filtering
 * and grouping options for document tags
 */
export function FacetedNav({
  allTags,
  visibleTags,
  selectedFacets,
  onFacetsChange,
  groupByKey,
  onGroupByKeyChange,
  className,
  onToggleEditMode,
  onRequestRename,
  onRequestMerge,
  onRequestMove,
}: FacetedNavProps) {
  const [editMode, setEditMode] = useState(false);
  const [hideUnmatched, setHideUnmatched] = useState(true);
  const [manageSelection, setManageSelection] = useState<Set<string>>(new Set());
  const facets = useMemo(() => {
    const facetsMap = extractFacets(allTags);
    return Array.from(facetsMap.entries())
      .map(([_key, facet]) => facet)
      .sort((a, b) => {
        // Sort: put __labels__ last, then alphabetically
        if (a.key === '__labels__') return 1;
        if (b.key === '__labels__') return -1;
        return a.key.localeCompare(b.key);
      });
  }, [allTags]);

  const activeFacetsCount = useMemo(() => {
    let count = 0;
    selectedFacets.forEach((values) => {
      count += values.size;
    });
    return count;
  }, [selectedFacets]);

  const handleToggleFacetValue = useCallback(
    (facetKey: string, value: string) => {
      const newSelectedFacets = new Map(selectedFacets);
      const currentValues = newSelectedFacets.get(facetKey) ?? new Set();

      if (currentValues.has(value)) {
        currentValues.delete(value);
      } else {
        currentValues.add(value);
      }

      if (currentValues.size === 0) {
        newSelectedFacets.delete(facetKey);
      } else {
        newSelectedFacets.set(facetKey, currentValues);
      }

      onFacetsChange(newSelectedFacets);
    },
    [selectedFacets, onFacetsChange],
  );

  const handleClearAll = useCallback(() => {
    onFacetsChange(new Map());
  }, [onFacetsChange]);

  const handleRemoveFacetValue = useCallback(
    (facetKey: string, value: string) => {
      handleToggleFacetValue(facetKey, value);
    },
    [handleToggleFacetValue],
  );

  const availableGroupKeys = useMemo(() => {
    return facets.filter((f) => f.key !== '__labels__').map((f) => f.key);
  }, [facets]);

  const visibleTagSet = useMemo(() => new Set(visibleTags ?? []), [visibleTags]);

  const toggleEditMode = useCallback(() => {
    setEditMode((prev) => {
      const next = !prev;
      onToggleEditMode?.(next);
      if (!next) {
        setManageSelection(new Set());
      }
      return next;
    });
  }, [onToggleEditMode]);

  const tokenFor = (facetKey: string, value: string) => `${facetKey}:${value}`;

  const handleToggleManageSelection = useCallback((facetKey: string, value: string) => {
    const token = tokenFor(facetKey, value);
    setManageSelection((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }, []);

  const handleClearManageSelection = useCallback(() => setManageSelection(new Set()), []);

  const handlePromptRename = useCallback(
    (facetKey: string, value: string) => {
      const input = window.prompt('Rename value', value);
      if (!input) return;
      onRequestRename?.({ key: facetKey, value }, { value: input.trim() });
    },
    [onRequestRename],
  );

  const handlePromptMergeSelected = useCallback(() => {
    if (manageSelection.size === 0) return;
    const destRaw = window.prompt('Merge selected into (format key:value)');
    if (!destRaw) return;
    const [key, ...rest] = destRaw.split(':');
    const value = rest.join(':');
    if (!key || !value) return;
    const sources = Array.from(manageSelection).map((tok) => {
      const idx = tok.indexOf(':');
      return { key: tok.slice(0, idx), value: tok.slice(idx + 1) };
    });
    onRequestMerge?.(sources, { key, value });
  }, [manageSelection, onRequestMerge]);

  const handlePromptMoveSelected = useCallback(() => {
    if (manageSelection.size === 0) return;
    const destKey = window.prompt('Move selected to key (value kept)');
    if (!destKey) return;
    const sources = Array.from(manageSelection).map((tok) => {
      const idx = tok.indexOf(':');
      return { key: tok.slice(0, idx), value: tok.slice(idx + 1) };
    });
    onRequestMove?.(sources, destKey.trim());
  }, [manageSelection, onRequestMove]);

  if (facets.length === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <p className="text-sm text-muted-foreground">
          No tags found. Add tags to documents to enable filtering.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Edit Mode Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase text-muted-foreground">Tags</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={!hideUnmatched}
              onCheckedChange={() => setHideUnmatched((v) => !v)}
              disabled={editMode}
            />
            Show All
          </label>
          <Button variant={editMode ? 'secondary' : 'outline'} size="sm" onClick={toggleEditMode}>
            {editMode ? (
              <>
                <Check className="h-3.5 w-3.5 mr-2" /> Done
              </>
            ) : (
              <>
                <Pencil className="h-3.5 w-3.5 mr-2" /> Edit Tags
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Manage Selection Toolbar */}
      {editMode && manageSelection.size > 0 && (
        <div className="flex items-center justify-between rounded-md border p-2 text-xs">
          <span>{manageSelection.size} selected</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePromptMergeSelected}>
              <GitMerge className="h-3.5 w-3.5 mr-2" /> Merge Selected
            </Button>
            <Button variant="outline" size="sm" onClick={handlePromptMoveSelected}>
              <ArrowRight className="h-3.5 w-3.5 mr-2" /> Move To Key
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearManageSelection}>
              Clear
            </Button>
          </div>
        </div>
      )}
      {/* Active Filters Chips */}
      {activeFacetsCount > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              Active Filters ({activeFacetsCount})
            </span>
            <Button variant="ghost" size="sm" onClick={handleClearAll} className="h-6 px-2 text-xs">
              Clear All
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from(selectedFacets.entries()).map(([facetKey, values]) =>
              Array.from(values).map((value) => {
                const displayKey =
                  facetKey === '__labels__' ? '' : `${getFacetDisplayName(facetKey)}: `;
                return (
                  <Badge key={`${facetKey}:${value}`} variant="secondary" className="gap-1 pr-1">
                    <TagIcon className="h-3 w-3" />
                    <span className="text-xs">
                      {displayKey}
                      {value}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFacetValue(facetKey, value)}
                      className="ml-1 rounded-full hover:bg-muted"
                      aria-label={`Remove filter: ${value}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              }),
            )}
          </div>
        </div>
      )}

      {/* Grouping Selector */}
      {availableGroupKeys.length > 0 && (
        <div className="space-y-2">
          <Label
            htmlFor="group-by-select"
            className="text-xs font-medium uppercase text-muted-foreground"
          >
            Group By
          </Label>
          <Select
            value={groupByKey ?? 'none'}
            onValueChange={(value) => onGroupByKeyChange(value === 'none' ? null : value)}
          >
            <SelectTrigger id="group-by-select" className="w-full">
              <SelectValue placeholder="No grouping" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No grouping</SelectItem>
              {availableGroupKeys.map((key) => (
                <SelectItem key={key} value={key}>
                  {getFacetDisplayName(key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Facets List */}
      <div className="space-y-4">
        {facets.map((facet) => {
          const selectedValues = selectedFacets.get(facet.key) ?? new Set();
          let values = Array.from(facet.values.entries());
          // In edit mode, always show all values regardless of current filters
          if (
            !editMode &&
            hideUnmatched &&
            selectedFacets.size > 0 &&
            (visibleTags?.length ?? 0) > 0
          ) {
            values = values.filter(([value]) => {
              const t = facet.key === '__labels__' ? value : `${facet.key}:${value}`;
              return visibleTagSet.has(t);
            });
          }
          const sortedValues = values.sort((a, b) => {
            // Sort by count (descending), then alphabetically
            if (b[1] !== a[1]) {
              return b[1] - a[1];
            }
            return a[0].localeCompare(b[0]);
          });

          return (
            <div key={facet.key} className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">
                {getFacetDisplayName(facet.key)}
              </h3>
              <div className="space-y-1.5">
                {sortedValues.map(([value, count]) => {
                  const isSelected = selectedValues.has(value);
                  const id = `facet-${facet.key}-${value}`;

                  return (
                    <div key={value} className="flex items-center gap-2">
                      {/* Filtering checkbox */}
                      <Checkbox
                        id={id}
                        checked={isSelected}
                        onCheckedChange={() => handleToggleFacetValue(facet.key, value)}
                      />
                      <label
                        htmlFor={id}
                        className="flex flex-1 cursor-pointer items-center justify-between text-sm"
                      >
                        <span className={cn('truncate', isSelected && 'font-medium')}>{value}</span>
                        <Badge variant="outline" className="ml-2 text-xs">
                          {count}
                        </Badge>
                      </label>

                      {/* Edit mode controls */}
                      {editMode && (
                        <div className="flex items-center gap-1">
                          <Checkbox
                            aria-label={`Select ${value} for manage`}
                            checked={manageSelection.has(tokenFor(facet.key, value))}
                            onCheckedChange={() => handleToggleManageSelection(facet.key, value)}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            title="Rename"
                            onClick={() => handlePromptRename(facet.key, value)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
