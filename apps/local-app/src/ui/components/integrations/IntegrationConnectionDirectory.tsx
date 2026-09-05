import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import type { IntegrationConnectionDirectoryEntry } from '@/ui/lib/integration-connections';
import { externalBoardProviderLabel } from '@/ui/lib/external-board';

export interface IntegrationConnectionDirectoryGroup {
  key: string;
  project: { id: string; name: string };
  workspace: { id: string; name: string };
  showWorkspaceName: boolean;
  entries: IntegrationConnectionDirectoryEntry[];
}

/**
 * Groups the flat project×provider rows per project, keeping the backend's
 * workspace/name ordering. The workspace name is surfaced only when the same
 * project name exists in more than one workspace, so single-workspace
 * listings stay uncluttered.
 */
export function groupDirectoryEntriesByProject(
  entries: IntegrationConnectionDirectoryEntry[],
): IntegrationConnectionDirectoryGroup[] {
  const groups: IntegrationConnectionDirectoryGroup[] = [];
  const workspaceIdsByProjectName = new Map<string, Set<string>>();
  for (const entry of entries) {
    const ids = workspaceIdsByProjectName.get(entry.project.name) ?? new Set<string>();
    ids.add(entry.workspace.id);
    workspaceIdsByProjectName.set(entry.project.name, ids);
  }
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.project.id === entry.project.id) {
      last.entries.push(entry);
      continue;
    }
    groups.push({
      key: entry.project.id,
      project: entry.project,
      workspace: entry.workspace,
      showWorkspaceName: (workspaceIdsByProjectName.get(entry.project.name)?.size ?? 0) > 1,
      entries: [entry],
    });
  }
  return groups;
}

function formatUpdatedAt(updatedAt: string | null): string {
  return updatedAt ? new Date(updatedAt).toLocaleString() : '';
}

interface IntegrationDirectoryRowProps {
  entry: IntegrationConnectionDirectoryEntry;
  onOpenBoard: (entry: IntegrationConnectionDirectoryEntry) => void;
}

function IntegrationDirectoryRow({ entry, onOpenBoard }: IntegrationDirectoryRowProps) {
  const label = externalBoardProviderLabel(entry.provider);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {entry.configured ? `Configured ${formatUpdatedAt(entry.updatedAt)}` : 'Not configured'}
          {entry.configured ? ` · Managed sync ${entry.subtaskSyncEnabled ? 'on' : 'paused'}` : ''}
        </p>
        {entry.hasMigratedSharedOrigin ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Migrated from a shared connection
          </p>
        ) : null}
      </div>
      {entry.configured ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onOpenBoard(entry)}
          aria-label={`Open ${label} board for ${entry.project.name}`}
        >
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Open Board
        </Button>
      ) : (
        <Badge variant="secondary">Not connected</Badge>
      )}
    </li>
  );
}

export interface IntegrationConnectionDirectoryListProps {
  entries: IntegrationConnectionDirectoryEntry[];
  truncated: boolean;
  onOpenBoard: (entry: IntegrationConnectionDirectoryEntry) => void;
}

export function IntegrationConnectionDirectoryList({
  entries,
  truncated,
  onOpenBoard,
}: IntegrationConnectionDirectoryListProps) {
  const groups = groupDirectoryEntriesByProject(entries);
  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const headingId = `integration-directory-project-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId}>
            <h3 id={headingId} className="mb-2 text-sm font-semibold">
              {group.project.name}
              {group.showWorkspaceName ? (
                <span className="font-normal text-muted-foreground"> · {group.workspace.name}</span>
              ) : null}
            </h3>
            <ul className="space-y-2">
              {group.entries.map((entry) => (
                <IntegrationDirectoryRow
                  key={`${entry.project.id}:${entry.provider}`}
                  entry={entry}
                  onOpenBoard={onOpenBoard}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Only the first 100 projects are listed. Open a project's Board to inspect its connections.
        </p>
      ) : null}
    </div>
  );
}
