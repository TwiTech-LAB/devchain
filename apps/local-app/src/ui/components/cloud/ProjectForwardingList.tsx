import { useState } from 'react';
import { FolderOpen, Search } from 'lucide-react';
import { useQueryClient, useQueries } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { cn } from '@/ui/lib/utils';
import { ProjectForwardingRow } from './ProjectForwardingRow';

type FilterMode = 'all' | 'enabled' | 'disabled';

const FILTER_OPTIONS: { key: FilterMode; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'enabled', label: 'Enabled' },
  { key: 'disabled', label: 'Disabled' },
];

export function ProjectForwardingList() {
  const { projects, projectsLoading } = useSelectedProject();
  const queryClient = useQueryClient();
  const [bulkPending, setBulkPending] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');

  const egressQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['cloud', 'egress', p.id] as const,
      queryFn: async () => {
        const res = await fetch(`/api/cloud/egress/projects/${p.id}`);
        if (!res.ok) throw new Error('Failed to fetch egress config');
        return res.json() as Promise<{ enabled: boolean }>;
      },
    })),
  });

  const enabledCount = egressQueries.filter((q) => q.data?.enabled === true).length;
  const totalCount = projects.length;

  const allEnabled = totalCount > 0 && egressQueries.every((q) => q.data?.enabled === true);
  const targetState = !allEnabled;
  const buttonLabel = allEnabled ? 'Disable all' : 'Enable all';

  const needle = search.toLowerCase().trim();
  const filteredProjects = projects.filter((p, i) => {
    if (
      needle &&
      !p.name.toLowerCase().includes(needle) &&
      !p.rootPath.toLowerCase().includes(needle)
    ) {
      return false;
    }
    if (filter === 'enabled') return egressQueries[i]?.data?.enabled === true;
    if (filter === 'disabled') return egressQueries[i]?.data?.enabled === false;
    return true;
  });

  const handleBulk = async () => {
    setBulkPending(true);
    const snapshots = egressQueries.map((q, i) => ({
      id: projects[i].id,
      prev: q.data,
    }));
    projects.forEach((p) =>
      queryClient.setQueryData(['cloud', 'egress', p.id], { enabled: targetState }),
    );
    const results = await Promise.allSettled(
      projects.map((p) =>
        fetch(`/api/cloud/egress/projects/${p.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: targetState }),
        }).then((res) => {
          if (!res.ok) throw new Error(`egress:${res.status}`);
        }),
      ),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const snap = snapshots[i];
        queryClient.setQueryData(['cloud', 'egress', snap.id], snap.prev);
      }
    });
    setBulkPending(false);
  };

  if (projectsLoading) {
    return <div className="text-sm text-muted-foreground">Loading projects...</div>;
  }

  if (projects.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-project forwarding</CardTitle>
          <CardDescription>Choose which projects can forward notifications to you.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <FolderOpen className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Add a project to manage its notifications
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Per-project forwarding</CardTitle>
            <CardDescription>
              Choose which projects can forward notifications to you.
            </CardDescription>
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap" aria-live="polite">
            {enabledCount} enabled &middot; {totalCount} projects
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
              aria-label="Search projects"
            />
          </div>
          <div
            className="flex rounded-md border border-border"
            role="group"
            aria-label="Filter by status"
          >
            {FILTER_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                aria-pressed={filter === key}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium transition-colors',
                  'first:rounded-l-md last:rounded-r-md',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  filter === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={handleBulk} disabled={bulkPending}>
            {buttonLabel}
          </Button>
        </div>

        <div className="rounded-lg border divide-y">
          {filteredProjects.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No projects match your filters
            </div>
          ) : (
            filteredProjects.map((p) => (
              <ProjectForwardingRow
                key={p.id}
                projectId={p.id}
                projectName={p.name}
                rootPath={p.rootPath}
                bulkPending={bulkPending}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
