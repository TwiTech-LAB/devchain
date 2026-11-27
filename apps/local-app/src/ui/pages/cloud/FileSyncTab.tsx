import { useCallback, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { BusyStatus } from '@/ui/components/ui/spinner';
import {
  compareTableOrder,
  groupOf,
  type FileSyncFilter,
  type FileSyncProjectItem,
  type FileSyncTabActions,
} from './file-sync-display';
import { FileSyncAttention } from './FileSyncAttention';
import { FileSyncConnections } from './FileSyncConnections';
import { FileSyncProjects } from './FileSyncProjects';
import type { FileSyncStatusResponse, FileSyncStatusScope } from './lib/remote-vm-contracts';
import type { ProjectListRow } from './ProjectList';

export type { FileSyncTabActions } from './file-sync-display';

/** What the controller gives the File sync tab. */
export interface FileSyncTabData {
  /** The details answer; null until the first one arrives. */
  readonly status: FileSyncStatusResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly remoteNames: ReadonlyMap<string, string>;
  /** The project rows, for the actions of a project. */
  readonly rows: readonly ProjectListRow[];
  /** Reads the status now; settles when the read ends. */
  readonly refresh: () => Promise<unknown>;
}

/**
 * The project row whose actions a scope may offer: the project must be bound to the scope's
 * VM now. The details poll and the bindings are separate reads, so during a move a scope can
 * still describe the old VM while the row's actions already act on the new one.
 */
function actionRow(
  rows: readonly ProjectListRow[],
  scope: FileSyncStatusScope,
): ProjectListRow | undefined {
  return rows.find(
    (row) =>
      row.project.id === scope.projectId &&
      row.status.state === 'remote' &&
      row.status.remoteId === scope.remoteId,
  );
}

/** The measured file sync status: Syncthing, the VM links and each project on a VM. */
export function FileSyncTab({
  status,
  loading,
  error,
  projectNames,
  remoteNames,
  rows,
  refresh,
  actions,
}: FileSyncTabData & { actions: FileSyncTabActions }) {
  const [filter, setFilter] = useState<FileSyncFilter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const toggle = useCallback((projectId: string) => {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  }, []);
  const clearFocus = useCallback(() => setFocusId(null), []);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">File sync</h2>
        <p className="text-sm text-muted-foreground">Project files across this PC and your VMs.</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        pending={refreshing}
        disabled={loading}
        onClick={() => void onRefresh()}
      >
        {!refreshing && <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />}
        Refresh status
      </Button>
    </div>
  );
  const errorAlert = error && (
    <p role="alert" className="text-sm text-destructive">
      Could not load the file sync status: {error}
    </p>
  );

  if (!status) {
    return (
      <div className="space-y-4">
        {header}
        {errorAlert ||
          (loading && (
            <BusyStatus className="flex text-sm text-muted-foreground">
              Loading the file sync status…
            </BusyStatus>
          ))}
      </div>
    );
  }

  const vmName = (remoteId: string) => remoteNames.get(remoteId) ?? remoteId;
  const items: FileSyncProjectItem[] = status.scopes
    .map((scope) => ({
      scope,
      project: projectNames.get(scope.projectId) ?? scope.projectId,
      vm: vmName(scope.remoteId),
      row: actionRow(rows, scope),
    }))
    .sort(compareTableOrder);
  const attention = items.filter((item) => groupOf(item) === 'attention');

  // The first row can be filtered out now; the row takes the focus once it renders.
  const viewIssues = () => {
    const first = attention[0];
    if (!first) return;
    setFilter('attention');
    setQuery('');
    setExpanded((open) => new Set(open).add(first.scope.projectId));
    setFocusId(first.scope.projectId);
  };

  return (
    <div className="space-y-4">
      {header}
      {errorAlert}
      <FileSyncConnections status={status} vmName={vmName} />
      <FileSyncAttention items={attention} onView={viewIssues} />
      <FileSyncProjects
        items={items}
        filter={filter}
        onFilterChange={setFilter}
        query={query}
        onQueryChange={setQuery}
        expanded={expanded}
        onToggle={toggle}
        focusId={focusId}
        onFocused={clearFocus}
        actions={actions}
      />
    </div>
  );
}
