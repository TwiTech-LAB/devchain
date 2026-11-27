import { Search } from 'lucide-react';
import { CountBadge } from '@/ui/components/shared/CountBadge';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Table, TableBody, TableHeader } from '@/ui/components/ui/table';
import {
  SYNC_GROUP_LABELS,
  groupOf,
  type FileSyncFilter,
  type FileSyncGroup,
  type FileSyncProjectItem,
  type FileSyncTabActions,
} from './file-sync-display';
import { FileSyncProjectHead, FileSyncProjectRow } from './FileSyncProjectRow';

/** "All", then one filter for each group, so a new group gets its filter with its label. */
const FILTERS: readonly { key: FileSyncFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  ...(Object.keys(SYNC_GROUP_LABELS) as FileSyncGroup[]).map((key) => ({
    key,
    label: SYNC_GROUP_LABELS[key],
  })),
];

/** The Projects section of the File sync tab: search, filter chips and the project table. */
export function FileSyncProjects({
  items,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  expanded,
  onToggle,
  focusId,
  onFocused,
  actions,
}: {
  /** Every project of the tab, in table order. */
  items: readonly FileSyncProjectItem[];
  filter: FileSyncFilter;
  onFilterChange: (filter: FileSyncFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
  expanded: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  /** The project whose expand button takes the focus once it renders. */
  focusId: string | null;
  onFocused: () => void;
  actions: FileSyncTabActions;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No project is connected to a VM.</p>;
  }

  const counts: Record<FileSyncFilter, number> = {
    all: items.length,
    attention: 0,
    pending: 0,
    'in-sync': 0,
  };
  for (const item of items) counts[groupOf(item)] += 1;

  const needle = query.trim().toLowerCase();
  const visible = items
    .filter((item) => filter === 'all' || groupOf(item) === filter)
    .filter((item) => !needle || item.project.toLowerCase().includes(needle));

  return (
    <section aria-labelledby="file-sync-projects" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 id="file-sync-projects" className="text-sm font-semibold">
          Projects
        </h3>
        <div className="relative min-w-0 flex-1 basis-48">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search projects"
            placeholder="Search projects…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-9 pl-8"
          />
        </div>
      </div>
      <div role="group" aria-label="Filter projects" className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label }) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={filter === key ? 'selected' : 'outline'}
            aria-pressed={filter === key}
            onClick={() => onFilterChange(key)}
          >
            {label}
            <span className="tabular-nums">
              <CountBadge count={counts[key]} />
            </span>
          </Button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No project matches.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <FileSyncProjectHead />
            </TableHeader>
            <TableBody>
              {visible.map((item) => (
                <FileSyncProjectRow
                  key={item.scope.projectId}
                  item={item}
                  expanded={expanded.has(item.scope.projectId)}
                  onToggle={onToggle}
                  focus={focusId === item.scope.projectId}
                  onFocused={onFocused}
                  actions={actions}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
