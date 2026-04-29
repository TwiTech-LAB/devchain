import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import type { CodebaseOverviewSnapshot } from '@devchain/codebase-overview';
import { cn } from '@/ui/lib/utils';
import { HeatmapCell, EmptyState } from '../../primitives';

const MIN_CHURN30D = 1;
const MAX_ROWS = 30;
const DAYS = 14;

// ---------------------------------------------------------------------------
// Date utilities — author-local dates (never UTC)
// ---------------------------------------------------------------------------

function getLast14Dates(): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${mo}-${dy}`);
  }
  return dates; // oldest → newest (left → right)
}

function parseDateLocal(dateStr: string): Date {
  const [y, m, dy] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, dy);
}

function formatDateHeader(dateStr: string): { weekday: string; day: string } {
  const d = parseDateLocal(dateStr);
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'narrow' }),
    day: String(d.getDate()),
  };
}

export function formatTooltipDate(dateStr: string): string {
  const d = parseDateLocal(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface HeatmapRow {
  districtId: string;
  name: string;
  dailyChurn: Record<string, number>;
}

function useHeatmapData(
  snapshot: CodebaseOverviewSnapshot,
  dates: string[],
): { rows: HeatmapRow[]; globalMax: number } {
  return useMemo(() => {
    const activityMap = new Map(snapshot.activity.map((a) => [a.targetId, a.dailyChurn ?? {}]));

    const rows: HeatmapRow[] = snapshot.signals
      .filter((s) => s.churn30d >= MIN_CHURN30D)
      .sort((a, b) => b.churn30d - a.churn30d)
      .slice(0, MAX_ROWS)
      .map((s) => ({
        districtId: s.districtId,
        name: s.name,
        dailyChurn: activityMap.get(s.districtId) ?? {},
      }));

    let globalMax = 0;
    for (const row of rows) {
      for (const date of dates) {
        const v = row.dailyChurn[date] ?? 0;
        if (v > globalMax) globalMax = v;
      }
    }

    return { rows, globalMax };
  }, [snapshot, dates]);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface HeatmapProps {
  snapshot: CodebaseOverviewSnapshot;
  onSelectDistrict: (id: string) => void;
}

export function Heatmap({ snapshot, onSelectDistrict }: HeatmapProps) {
  const dates = useMemo(() => getLast14Dates(), []);
  const { rows, globalMax } = useHeatmapData(snapshot, dates);
  const gridRef = useRef<HTMLDivElement>(null);
  const shouldFocusRef = useRef(false);

  const [focusedCoord, setFocusedCoord] = useState<{ rowIdx: number; colIdx: number } | null>(null);

  useEffect(() => {
    if (rows.length === 0) {
      setFocusedCoord(null);
    } else {
      setFocusedCoord((prev) => {
        if (prev === null) return { rowIdx: 0, colIdx: 0 };
        return {
          rowIdx: Math.min(prev.rowIdx, rows.length - 1),
          colIdx: Math.min(prev.colIdx, dates.length - 1),
        };
      });
    }
  }, [rows.length, dates.length]);

  useEffect(() => {
    if (shouldFocusRef.current && focusedCoord !== null && gridRef.current) {
      const cell = gridRef.current.querySelector(
        `[data-row="${focusedCoord.rowIdx}"][data-col="${focusedCoord.colIdx}"] [tabindex="0"]`,
      ) as HTMLElement | null;
      cell?.focus();
      shouldFocusRef.current = false;
    }
  }, [focusedCoord]);

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (focusedCoord === null || rows.length === 0) return;
      const lastRowIdx = rows.length - 1;
      const lastColIdx = dates.length - 1;
      let next: { rowIdx: number; colIdx: number } | null = null;

      if (e.key === 'ArrowRight') {
        next = {
          rowIdx: focusedCoord.rowIdx,
          colIdx: Math.min(focusedCoord.colIdx + 1, lastColIdx),
        };
      } else if (e.key === 'ArrowLeft') {
        next = { rowIdx: focusedCoord.rowIdx, colIdx: Math.max(focusedCoord.colIdx - 1, 0) };
      } else if (e.key === 'ArrowDown') {
        next = {
          rowIdx: Math.min(focusedCoord.rowIdx + 1, lastRowIdx),
          colIdx: focusedCoord.colIdx,
        };
      } else if (e.key === 'ArrowUp') {
        next = { rowIdx: Math.max(focusedCoord.rowIdx - 1, 0), colIdx: focusedCoord.colIdx };
      } else if (e.key === 'Home') {
        if (e.ctrlKey) {
          next = { rowIdx: 0, colIdx: 0 };
        } else {
          next = { rowIdx: focusedCoord.rowIdx, colIdx: 0 };
        }
      } else if (e.key === 'End') {
        if (e.ctrlKey) {
          next = { rowIdx: lastRowIdx, colIdx: lastColIdx };
        } else {
          next = { rowIdx: focusedCoord.rowIdx, colIdx: lastColIdx };
        }
      } else if (e.key === 'PageUp') {
        next = { rowIdx: 0, colIdx: 0 };
      } else if (e.key === 'PageDown') {
        next = { rowIdx: lastRowIdx, colIdx: lastColIdx };
      }

      if (next) {
        e.preventDefault();
        shouldFocusRef.current = true;
        setFocusedCoord(next);
      }
    },
    [focusedCoord, rows.length, dates.length],
  );

  function handleCellClick(rowIdx: number, colIdx: number) {
    setFocusedCoord({ rowIdx, colIdx });
  }

  const hasDailyChurnUnavailable = snapshot.metrics.warnings.some(
    (w) => w.code === 'daily_churn_unavailable',
  );

  if (hasDailyChurnUnavailable) return null;

  if (rows.length === 0 || globalMax === 0) {
    return (
      <EmptyState
        icon={Activity}
        headline="No recent activity"
        reason="No districts have been changed in the last 30 days. Either the repo is quiet or commits are filtered out."
      />
    );
  }

  return (
    <div
      ref={gridRef}
      className="overflow-x-auto rounded-md border border-border"
      data-testid="heatmap"
      onKeyDown={handleGridKeyDown}
    >
      <table className="w-full min-w-max border-separate border-spacing-0">
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-20 min-w-[200px] border-b border-r border-border bg-background px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              District
            </th>
            {dates.map((date) => {
              const { weekday, day } = formatDateHeader(date);
              return (
                <th
                  key={date}
                  scope="col"
                  data-date={date}
                  className="sticky top-0 z-10 w-10 border-b border-border bg-background px-0.5 py-2 text-center"
                >
                  <div className="text-[10px] font-semibold leading-none text-foreground/70">
                    {weekday}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                    {day}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={row.districtId} className="group transition-colors">
              <td className="sticky left-0 z-10 min-w-[200px] border-r border-border bg-background p-0 transition-colors group-hover:bg-muted/50">
                <button
                  type="button"
                  onClick={() => onSelectDistrict(row.districtId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectDistrict(row.districtId);
                    }
                  }}
                  title={row.name}
                  className={cn(
                    'flex min-h-10 w-full items-center px-3 py-1 text-left text-xs font-medium',
                    'text-foreground/80 transition-colors hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  )}
                >
                  <span className="min-w-0 truncate">{row.name}</span>
                </button>
              </td>
              {dates.map((date, colIdx) => {
                const value = row.dailyChurn[date] ?? 0;
                const tooltipDate = formatTooltipDate(date);
                const isFocused =
                  focusedCoord !== null &&
                  focusedCoord.rowIdx === rowIdx &&
                  focusedCoord.colIdx === colIdx;
                return (
                  <td
                    key={date}
                    data-row={rowIdx}
                    data-col={colIdx}
                    className="px-0.5 text-center transition-colors group-hover:bg-muted/50"
                    onClick={() => handleCellClick(rowIdx, colIdx)}
                  >
                    <HeatmapCell
                      value={value}
                      max={globalMax}
                      size={16}
                      tabbable={isFocused}
                      ariaLabel={`${row.name}: ${value} changed file${value !== 1 ? 's' : ''} on ${tooltipDate}`}
                      tooltip={
                        <span>
                          {value} changed file{value !== 1 ? 's' : ''} on {tooltipDate}
                        </span>
                      }
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
