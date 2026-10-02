import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Input } from '@/ui/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { BusyStatus } from '@/ui/components/ui/spinner';
import type { Project, ProjectWorkspace } from '@/ui/pages/projects/lib/project-contracts';
import type { ProjectStatus } from './remote-status';
import { StatusChip } from './StatusChip';

export type ProjectLocationFilter = 'all' | 'vms' | 'pc';

export interface ProjectListRow {
  project: Project;
  status: ProjectStatus;
  /** The project runs on a VM or is moving between this PC and one. */
  onVm: boolean;
}

/** The rows and load state a project list or picker renders. */
export interface ProjectListData {
  rows: ProjectListRow[];
  workspaces: ProjectWorkspace[];
  loading: boolean;
  error: Error | null;
  /** The server holds more projects than the one request returned. */
  truncated: boolean;
}

const ALL_WORKSPACES = 'all';

const LOCATION_LABELS: Record<ProjectLocationFilter, string> = {
  all: 'All',
  vms: 'On VMs',
  pc: 'This PC',
};

/**
 * Every project of every workspace, with a location, workspace and name
 * filter. The row action comes from the caller, so the same list serves the
 * Overview and a project picker.
 */
export function ProjectList({
  rows,
  workspaces,
  loading,
  error,
  truncated,
  title = 'Projects',
  description = 'Connect a project to a VM, or disconnect it to bring it back to this PC.',
  autoFocusSearch = false,
  renderAction,
}: ProjectListData & {
  title?: string;
  description?: string;
  /** A picker in a dialog starts in the search field instead of the first filter. */
  autoFocusSearch?: boolean;
  renderAction: (row: ProjectListRow) => ReactNode;
}) {
  const [location, setLocation] = useState<ProjectLocationFilter>('all');
  const [workspaceId, setWorkspaceId] = useState(ALL_WORKSPACES);
  const [query, setQuery] = useState('');
  const multipleWorkspaces = workspaces.length > 1;
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  const effectiveWorkspace = multipleWorkspaces ? workspaceId : ALL_WORKSPACES;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows
        .filter(({ onVm }) => location === 'all' || (location === 'vms') === onVm)
        .filter(
          ({ project }) =>
            effectiveWorkspace === ALL_WORKSPACES || project.workspaceId === effectiveWorkspace,
        )
        .filter(({ project }) => !needle || project.name.toLowerCase().includes(needle))
        // Projects on a VM (or moving to or from one) come first; each group by name.
        .sort(
          (a, b) => Number(b.onVm) - Number(a.onVm) || a.project.name.localeCompare(b.project.name),
        ),
    [rows, location, effectiveWorkspace, needle],
  );
  const showWorkspace = multipleWorkspaces && effectiveWorkspace === ALL_WORKSPACES;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={location}
            onValueChange={(value) => setLocation(value as ProjectLocationFilter)}
          >
            <SelectTrigger aria-label="Show projects" className="h-9 w-auto min-w-[8rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LOCATION_LABELS) as ProjectLocationFilter[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {LOCATION_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {multipleWorkspaces && (
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger aria-label="Workspace" className="h-9 w-auto min-w-[10rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_WORKSPACES}>All workspaces</SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="relative min-w-[10rem] flex-1">
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search projects"
              placeholder="Search projects"
              autoFocus={autoFocusSearch}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 pl-8"
            />
          </div>
        </div>

        {truncated && (
          <p className="text-xs text-muted-foreground">Showing the first 1,000 projects.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Could not load projects: {error.message}
          </p>
        )}
        {loading ? (
          <BusyStatus className="text-sm text-muted-foreground">Loading projects…</BusyStatus>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {rows.length === 0 ? 'No projects yet.' : 'No project matches these filters.'}
          </p>
        ) : (
          <ul aria-label="Projects" className="divide-y">
            {visible.map((row) => {
              const { project, status } = row;
              return (
                <li
                  key={project.id}
                  aria-label={project.name}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-all font-medium">{project.name}</span>
                      {showWorkspace && (
                        <span className="text-xs text-muted-foreground">
                          {workspaceNames.get(project.workspaceId) ?? 'Unknown workspace'}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={status.tone}>{status.label}</StatusChip>
                      {status.note && (
                        <span className="break-words text-xs text-muted-foreground">
                          {status.note}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0">{renderAction(row)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
