import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, Search, X } from 'lucide-react';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { cn } from '@/ui/lib/utils';
import { Input } from '@/ui/components/ui/input';
import { Button } from '@/ui/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { BarFill, EmptyState, DensityToggle, useTableDensity } from '../../primitives';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type SortDirection = 'asc' | 'desc';

interface ColumnDef {
  key: string;
  label: string;
  width: string;
  align: 'left' | 'right';
  getValue: (s: DistrictSignals) => string | number | null;
  renderCell: (s: DistrictSignals) => React.ReactNode;
  compare: (a: DistrictSignals, b: DistrictSignals, dir: SortDirection) => number;
}

function numericCompare(
  extract: (s: DistrictSignals) => number | null,
): (a: DistrictSignals, b: DistrictSignals, dir: SortDirection) => number {
  return (a, b, dir) => {
    const av = extract(a);
    const bv = extract(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return dir === 'asc' ? av - bv : bv - av;
  };
}

const COLUMNS: ColumnDef[] = [
  {
    key: 'name',
    label: 'Name',
    width: 'min-w-[180px] flex-1',
    align: 'left',
    getValue: (s) => s.name,
    renderCell: (s) => <span className="truncate">{s.name}</span>,
    compare: (a, b, dir) =>
      dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name),
  },
  {
    key: 'files',
    label: 'Files',
    width: 'w-16',
    align: 'right',
    getValue: (s) => s.files,
    renderCell: (s) => s.files,
    compare: numericCompare((s) => s.files),
  },
  {
    key: 'loc',
    label: 'LOC',
    width: 'w-20',
    align: 'right',
    getValue: (s) => s.loc,
    renderCell: (s) => s.loc.toLocaleString(),
    compare: numericCompare((s) => s.loc),
  },
  {
    key: 'churn7d',
    label: 'Churn 7d',
    width: 'w-20',
    align: 'right',
    getValue: (s) => s.churn7d,
    renderCell: (s) => s.churn7d,
    compare: numericCompare((s) => s.churn7d),
  },
  {
    key: 'churn30d',
    label: 'Churn 30d',
    width: 'w-20',
    align: 'right',
    getValue: (s) => s.churn30d,
    renderCell: (s) => s.churn30d,
    compare: numericCompare((s) => s.churn30d),
  },
  {
    key: 'coverage',
    label: 'Coverage %',
    width: 'w-28',
    align: 'right',
    getValue: (s) => s.testCoverageRate,
    renderCell: (s) =>
      s.testCoverageRate === null ? (
        <span className="text-muted-foreground">&mdash;</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <div className="w-12 h-2 shrink-0">
            <BarFill value={s.testCoverageRate * 100} max={100} />
          </div>
          <span className="tabular-nums">{Math.round(s.testCoverageRate * 100)}%</span>
        </div>
      ),
    compare: numericCompare((s) => s.testCoverageRate),
  },
  {
    key: 'complexity',
    label: 'Complexity',
    width: 'w-20',
    align: 'right',
    getValue: (s) => s.complexityAvg,
    renderCell: (s) =>
      s.complexityAvg === null ? (
        <span className="text-muted-foreground">&mdash;</span>
      ) : (
        <span className="tabular-nums">{s.complexityAvg.toFixed(1)}</span>
      ),
    compare: numericCompare((s) => s.complexityAvg),
  },
  {
    key: 'inbound',
    label: 'Inbound',
    width: 'w-18',
    align: 'right',
    getValue: (s) => s.inboundWeight,
    renderCell: (s) => s.inboundWeight,
    compare: numericCompare((s) => s.inboundWeight),
  },
  {
    key: 'outbound',
    label: 'Outbound',
    width: 'w-18',
    align: 'right',
    getValue: (s) => s.outboundWeight,
    renderCell: (s) => s.outboundWeight,
    compare: numericCompare((s) => s.outboundWeight),
  },
  {
    key: 'blast',
    label: 'Blast',
    width: 'w-16',
    align: 'right',
    getValue: (s) => s.blastRadius,
    renderCell: (s) => s.blastRadius,
    compare: numericCompare((s) => s.blastRadius),
  },
  {
    key: 'hhi',
    label: 'HHI %',
    width: 'w-28',
    align: 'right',
    getValue: (s) => s.ownershipHHI,
    renderCell: (s) =>
      s.ownershipHHI === null ? (
        <span className="text-muted-foreground">&mdash;</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <div className="w-12 h-2 shrink-0">
            <BarFill value={s.ownershipHHI * 100} max={100} />
          </div>
          <span className="tabular-nums">{Math.round(s.ownershipHHI * 100)}%</span>
        </div>
      ),
    compare: numericCompare((s) => s.ownershipHHI),
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PressureTableProps {
  signals: DistrictSignals[];
  selectedDistrictId: string | null;
  onSelectDistrict: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PressureTable({
  signals,
  selectedDistrictId,
  onSelectDistrict,
}: PressureTableProps) {
  const { density, setDensity } = useTableDensity();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const shouldFocusRowRef = useRef(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [hideSupportOnly, setHideSupportOnly] = useState(true);
  const [selectedRegions, setSelectedRegions] = useState<Set<string> | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Sort
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  const allRegions = useMemo(
    () => [...new Set(signals.map((s) => s.regionName))].sort(),
    [signals],
  );

  const handleHeaderClick = useCallback(
    (key: string) => {
      if (sortKey === key) {
        if (sortDir === 'asc') {
          setSortDir('desc');
        } else {
          setSortKey(null);
          setSortDir('asc');
        }
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey, sortDir],
  );

  const filteredSignals = useMemo(() => {
    let result = signals;
    if (hideSupportOnly) {
      result = result.filter((s) => s.hasSourceFiles);
    }
    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase().trim();
      result = result.filter((s) => s.name.toLowerCase().includes(q));
    }
    if (selectedRegions !== null) {
      result = result.filter((s) => selectedRegions.has(s.regionName));
    }
    return result;
  }, [signals, hideSupportOnly, debouncedQuery, selectedRegions]);

  const sortedSignals = useMemo(() => {
    if (!sortKey) {
      return [...filteredSignals].sort((a, b) => a.name.localeCompare(b.name));
    }
    const col = COLUMNS.find((c) => c.key === sortKey);
    if (!col) return filteredSignals;
    return [...filteredSignals].sort((a, b) => col.compare(a, b, sortDir));
  }, [filteredSignals, sortKey, sortDir]);

  const rowHeight = density === 'compact' ? 40 : 48;

  const virtualizer = useVirtualizer({
    count: sortedSignals.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (i) => sortedSignals[i]!.districtId,
    overscan: 8,
  });

  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(
    sortedSignals.length > 0 ? 0 : null,
  );

  useEffect(() => {
    if (sortedSignals.length === 0) {
      setFocusedRowIndex(null);
    } else {
      setFocusedRowIndex((prev) => {
        if (prev === null) return 0;
        return Math.min(prev, sortedSignals.length - 1);
      });
    }
  }, [sortedSignals.length]);

  useEffect(() => {
    if (shouldFocusRowRef.current && focusedRowIndex !== null) {
      rowRefs.current[focusedRowIndex]?.focus();
      shouldFocusRowRef.current = false;
    }
  }, [focusedRowIndex]);

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const lastIdx = sortedSignals.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        shouldFocusRowRef.current = true;
        const next = Math.min(index + 1, lastIdx);
        setFocusedRowIndex(next);
        virtualizer.scrollToIndex(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        shouldFocusRowRef.current = true;
        const prev = Math.max(index - 1, 0);
        setFocusedRowIndex(prev);
        virtualizer.scrollToIndex(prev);
      } else if (e.key === 'Home') {
        e.preventDefault();
        shouldFocusRowRef.current = true;
        setFocusedRowIndex(0);
        virtualizer.scrollToIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        shouldFocusRowRef.current = true;
        setFocusedRowIndex(lastIdx);
        virtualizer.scrollToIndex(lastIdx);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectDistrict(sortedSignals[index]!.districtId);
      }
    },
    [sortedSignals, onSelectDistrict, virtualizer],
  );

  if (signals.length === 0) {
    return (
      <EmptyState
        icon={Search}
        headline="No districts to show"
        reason="Try refreshing or check warnings above."
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-10 w-48 text-sm"
            aria-label="Filter districts by name"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Region filter */}
        <select
          multiple
          value={selectedRegions === null ? allRegions : [...selectedRegions]}
          onChange={(e) => {
            const selected = new Set(Array.from(e.target.selectedOptions, (o) => o.value));
            setSelectedRegions(selected.size === allRegions.length ? null : selected);
          }}
          className="h-10 text-sm rounded-md border border-input bg-background px-2"
          aria-label="Filter by region"
        >
          {allRegions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={hideSupportOnly ? 'secondary' : 'outline'}
                size="sm"
                className="h-10 text-xs"
                onClick={() => setHideSupportOnly((v) => !v)}
                aria-pressed={hideSupportOnly}
              >
                Hide support-only
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Hide districts with no source files (config, style, etc.)</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="ml-auto">
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </div>

      {/* Table */}
      {sortedSignals.length === 0 ? (
        <EmptyState
          icon={Search}
          headline="No districts match"
          reason="Adjust filters or clear search."
        />
      ) : (
        <div
          ref={scrollRef}
          className="overflow-auto max-h-[calc(100vh-300px)] rounded-md border"
          role="grid"
          aria-label="Pressure table"
          aria-rowcount={sortedSignals.length + 1}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize() + rowHeight}px`,
              position: 'relative',
            }}
          >
            {/* Sticky header */}
            <div
              className="sticky top-0 z-10 flex border-b bg-card"
              role="row"
              aria-rowindex={1}
              style={{ height: `${rowHeight}px` }}
            >
              {COLUMNS.map((col) => (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={
                    sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                  }
                  tabIndex={0}
                  onClick={() => handleHeaderClick(col.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleHeaderClick(col.key);
                    }
                  }}
                  className={cn(
                    'flex items-center shrink-0 px-2 text-xs font-medium text-muted-foreground cursor-pointer select-none',
                    'hover:text-foreground transition-colors',
                    col.width,
                    col.align === 'right' && 'justify-end',
                  )}
                >
                  <span>{col.label}</span>
                  {sortKey === col.key && (
                    <span className="ml-1">
                      {sortDir === 'asc' ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Virtualized rows */}
            {virtualizer.getVirtualItems().map((vRow) => {
              const signal = sortedSignals[vRow.index]!;
              const isSelected = signal.districtId === selectedDistrictId;
              const isFocused = vRow.index === focusedRowIndex;
              return (
                <div
                  key={vRow.key}
                  role="row"
                  aria-rowindex={vRow.index + 2}
                  aria-selected={isSelected}
                  tabIndex={isFocused ? 0 : -1}
                  ref={(el) => {
                    rowRefs.current[vRow.index] = el;
                  }}
                  data-index={vRow.index}
                  onClick={() => {
                    setFocusedRowIndex(vRow.index);
                    onSelectDistrict(signal.districtId);
                  }}
                  onKeyDown={(e) => handleRowKeyDown(e, vRow.index)}
                  className={cn(
                    'absolute flex items-center w-full cursor-pointer transition-colors text-sm',
                    isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
                    isFocused && 'ring-2 ring-ring ring-inset',
                  )}
                  style={{
                    height: `${rowHeight}px`,
                    top: `${vRow.start + rowHeight}px`,
                  }}
                >
                  {COLUMNS.map((col) => (
                    <div
                      key={col.key}
                      role="gridcell"
                      className={cn(
                        'shrink-0 px-2 truncate',
                        col.width,
                        col.align === 'right' && 'text-right',
                      )}
                    >
                      {col.renderCell(signal)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
