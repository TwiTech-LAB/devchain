import { Badge, OpaqueBadge } from '@/ui/components/ui/badge';
import { TONE_CLASSES } from '@/ui/lib/status-tone';
import { Button } from '@/ui/components/ui/button';
import { Card } from '@/ui/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import { Input } from '@/ui/components/ui/input';
import { cn } from '@/ui/lib/utils';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Download,
  Edit,
  FolderOpen,
  GripVertical,
  Loader2,
  MoreHorizontal,
  MoveRight,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type {
  ProjectTableRowModel,
  ProjectsSortField,
  ProjectsTableModel,
  ProjectsTableDragModel,
  ProjectWorkspaceGroupModel,
} from './projects-page-presentation';

interface ProjectsTableProps {
  model: ProjectsTableModel;
}

const countFormatter = new Intl.NumberFormat();

function TemplateSourceBadges({
  template,
}: {
  template: NonNullable<ProjectTableRowModel['template']>;
}) {
  if (template.source === 'bundled') {
    return (
      <>
        <Badge variant="outline" className="text-xs text-muted-foreground">
          Built-in
        </Badge>
        {template.version && (
          <OpaqueBadge variant="outline" className={cn('text-xs', TONE_CLASSES.info)}>
            v{template.version}
          </OpaqueBadge>
        )}
      </>
    );
  }
  if (!template.version) return null;
  return (
    <OpaqueBadge variant="outline" className={cn('text-xs', TONE_CLASSES.info)}>
      v{template.version}
    </OpaqueBadge>
  );
}

function SortButton({
  field,
  label,
  model,
}: {
  field: ProjectsSortField;
  label: string;
  model: ProjectsTableModel;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => model.toggleSort(field)}
    >
      {label}
      <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
      {model.sortField === field && (
        <span aria-hidden="true">{model.sortOrder === 'asc' ? '↑' : '↓'}</span>
      )}
    </button>
  );
}

function ariaSort(model: ProjectsTableModel, field: ProjectsSortField) {
  if (model.sortField !== field) return 'none' as const;
  return model.sortOrder === 'asc' ? ('ascending' as const) : ('descending' as const);
}

function WorkspaceActions({ group }: { group: ProjectWorkspaceGroupModel }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Actions for workspace ${group.name}`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={group.openCreate}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          Create project here
        </DropdownMenuItem>
        <DropdownMenuItem onClick={group.rename}>
          <Edit className="mr-2 h-4 w-4" aria-hidden="true" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={group.moveUp} disabled={!group.moveUp}>
          <ArrowUp className="mr-2 h-4 w-4" aria-hidden="true" />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem onClick={group.moveDown} disabled={!group.moveDown}>
          <ArrowDown className="mr-2 h-4 w-4" aria-hidden="true" />
          Move down
        </DropdownMenuItem>
        {group.requestDelete && (
          <DropdownMenuItem
            onClick={group.requestDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectRow({ row, drag }: { row: ProjectTableRowModel; drag: ProjectsTableDragModel }) {
  return (
    <tr className="border-t hover:bg-muted/50">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-start gap-1">
          {row.moveTargets.length > 0 && (
            <span
              draggable
              tabIndex={-1}
              aria-hidden="true"
              data-testid={`project-drag-handle-${row.id}`}
              title={`Drag ${row.name} to another workspace`}
              className="mt-0.5 hidden h-6 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing sm:inline-flex"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', row.id);
                drag.start(row.id, row.workspaceId);
              }}
              onDragEnd={drag.end}
            >
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <Button
              variant="link"
              className="block h-auto max-w-56 truncate p-0 text-left font-medium"
              onClick={row.open}
              title={row.name}
            >
              {row.name}
            </Button>
            {row.isTemplate ? (
              <Badge variant="outline" className="mt-1" aria-label="Template project">
                Template
              </Badge>
            ) : null}
            {row.remoteLock ? (
              <Badge variant="outline" className="mt-1" title={row.remoteLock.message}>
                Remote
              </Badge>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <code
          className="block max-w-64 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
          title={row.rootPath}
        >
          {row.rootPath}
        </code>
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        <span className="block max-w-64 truncate" title={row.description ?? undefined}>
          {row.description || '—'}
        </span>
      </td>
      <td className="px-4 py-3 text-sm">
        {row.template ? (
          <span className="flex max-w-56 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-muted-foreground" title={row.template.slug}>
              {row.template.slug}
            </span>
            <TemplateSourceBadges template={row.template} />
            {row.template.upgradeVersion && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs text-status-ok hover:bg-accent hover:text-foreground"
                onClick={row.upgrade}
                disabled={row.remoteLock !== null}
                title={row.remoteLock?.message ?? `Upgrade to v${row.template.upgradeVersion}`}
              >
                <ArrowUp className="mr-0.5 h-3 w-3" aria-hidden="true" />v
                {row.template.upgradeVersion}
              </Button>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-center">
        <Badge variant="secondary" className="tabular-nums">
          {countFormatter.format(row.epicsCount)}
        </Badge>
      </td>
      <td className="px-4 py-3 text-center">
        <Badge variant="secondary" className="tabular-nums">
          {countFormatter.format(row.agentsCount)}
        </Badge>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex justify-end gap-2">
          {row.configure && (
            <Button
              variant="ghost"
              size="sm"
              onClick={row.configure}
              title="Configure project"
              aria-label={`Configure ${row.name}`}
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={row.edit} aria-label={`Edit ${row.name}`}>
            <Edit className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={row.requestDelete}
            disabled={row.remoteLock !== null}
            title={row.remoteLock?.message}
            className="text-destructive hover:text-destructive"
            aria-label={`Delete ${row.name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                id={row.actionsButtonId}
                variant="ghost"
                size="sm"
                aria-label={`Actions for ${row.name}`}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {row.remoteLock && (
                <DropdownMenuItem disabled title={row.remoteLock.message}>
                  <MoveRight className="mr-2 h-4 w-4" aria-hidden="true" />
                  Move to workspace…
                </DropdownMenuItem>
              )}
              {row.moveTargets.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <MoveRight className="mr-2 h-4 w-4" aria-hidden="true" />
                    Move to workspace…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {row.moveTargets.map((target) => (
                      <DropdownMenuItem key={target.workspaceId} onClick={target.requestMove}>
                        {target.workspaceName}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem
                onClick={row.startImport}
                disabled={row.remoteLock !== null}
                title={row.remoteLock?.message}
              >
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                Import
              </DropdownMenuItem>
              <DropdownMenuItem onClick={row.export}>
                <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
                Export
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}

function WorkspaceEmptyRow({ group }: { group: ProjectWorkspaceGroupModel }) {
  if (group.emptyState === 'none' || group.emptyState === 'no-matches') return null;
  return (
    <tr className="border-t">
      <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
        {group.emptyState === 'workspace-empty'
          ? 'No projects in this workspace.'
          : `${countFormatter.format(group.projectCount)} total ${group.projectCount === 1 ? 'project is' : 'projects are'} outside the current project results.`}
      </td>
    </tr>
  );
}

function workspaceDropState(
  isDragging: boolean,
  isSource: boolean,
  isActiveDestination: boolean,
): 'idle' | 'invalid' | 'active' | 'available' {
  if (!isDragging) return 'idle';
  if (isSource) return 'invalid';
  return isActiveDestination ? 'active' : 'available';
}

function WorkspaceGroup({
  group,
  searchActive,
  drag,
}: {
  group: ProjectWorkspaceGroupModel;
  searchActive: boolean;
  drag: ProjectsTableDragModel;
}) {
  const countLabel = searchActive
    ? `${countFormatter.format(group.visibleMatchCount)} visible matches · ${countFormatter.format(group.projectCount)} total projects`
    : `${countFormatter.format(group.projectCount)} ${group.projectCount === 1 ? 'project' : 'projects'}`;
  const isDragging = drag.projectId !== null;
  const isSource = isDragging && drag.sourceWorkspaceId === group.id;
  const isActiveDestination = isDragging && !isSource && drag.targetWorkspaceId === group.id;
  const dropState = workspaceDropState(isDragging, isSource, isActiveDestination);

  return (
    <tbody
      data-workspace-id={group.id}
      data-drop-state={dropState}
      className={cn(
        isDragging && '[&_tr>*]:transition-colors [&_tr>*]:motion-reduce:transition-none',
        isDragging && !isSource && '[&_tr>*]:bg-primary/[0.03]',
        isSource && '[&_tr>*]:cursor-not-allowed [&_tr>*]:opacity-60',
        isActiveDestination &&
          'outline outline-2 outline-offset-[-2px] outline-primary [&_tr>*]:bg-primary/10',
      )}
      onDragEnter={(event) => {
        if (!drag.projectId) return;
        event.preventDefault();
        drag.enterWorkspace(group.id);
      }}
      onDragOver={(event) => {
        if (!drag.projectId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = isSource ? 'none' : 'move';
        drag.enterWorkspace(group.id);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        drag.leaveWorkspace(group.id);
      }}
      onDrop={(event) => {
        if (!drag.projectId) return;
        event.preventDefault();
        drag.dropOnWorkspace(group.id);
      }}
    >
      <tr className={cn('border-y', group.identity.baseClassName)}>
        <th scope="rowgroup" colSpan={7} className="px-3 py-2 text-left font-medium">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={group.isExpanded}
              onClick={group.toggleExpanded}
              disabled={!group.canToggle}
              title={!group.canToggle ? 'Expansion follows search results' : undefined}
            >
              {group.isExpanded ? (
                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-xs font-bold',
                  group.identity.baseClassName,
                )}
                aria-hidden="true"
              >
                {group.identity.initial}
              </span>
              <span className="min-w-0 truncate" title={group.name}>
                {group.name}
              </span>
              {group.isDefault && <Badge variant="outline">Default</Badge>}
              <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                {countLabel}
              </span>
              {isSource && (
                <span
                  className="shrink-0 text-xs font-normal text-muted-foreground"
                  aria-hidden="true"
                >
                  Current workspace · cannot drop
                </span>
              )}
              {isActiveDestination && <Badge aria-hidden="true">Move to {group.name}</Badge>}
            </button>
            <WorkspaceActions group={group} />
          </div>
        </th>
      </tr>
      {group.isExpanded &&
        group.rows.map((row) => <ProjectRow key={row.id} row={row} drag={drag} />)}
      {group.isExpanded && <WorkspaceEmptyRow group={group} />}
    </tbody>
  );
}

function failedDataLabel(failedData: ReadonlyArray<'projects' | 'workspaces'>): string {
  if (failedData.length !== 1) return 'projects and workspaces';
  return failedData[0];
}

export function ProjectsTable({ model }: ProjectsTableProps) {
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {model.statusMessage}
      </p>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-balance text-3xl font-bold">Projects</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={model.openCreateWorkspace}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Create Workspace
          </Button>
          <Button onClick={model.openCreate}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Create Project
          </Button>
        </div>
      </div>

      <Card className="mb-4 p-3">
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="text"
            name="projectSearch"
            autoComplete="off"
            aria-label="Search projects"
            placeholder="Search projects by name, path, or description…"
            value={model.search}
            onChange={(event) => model.changeSearch(event.target.value)}
            data-shortcut="primary-search"
            className="pl-10"
          />
        </div>
      </Card>

      {model.content.kind === 'loading' && (
        <div className="flex items-center justify-center py-16" role="status">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading projects and workspaces…</span>
        </div>
      )}

      {model.content.kind === 'unavailable' && (
        <Card className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <FolderOpen className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xl font-semibold">Project data unavailable</h2>
          <p className="text-muted-foreground">
            Couldn’t load {failedDataLabel(model.content.failedData)}.
          </p>
          <Button type="button" variant="outline" onClick={model.content.retry}>
            Retry
          </Button>
        </Card>
      )}

      {model.content.kind === 'ready' && model.content.groups.length === 0 && (
        <Card className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <FolderOpen className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xl font-semibold">No workspaces available</h2>
          <p className="text-muted-foreground">Create a workspace to organize projects.</p>
        </Card>
      )}

      {model.content.kind === 'ready' && model.content.groups.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table
              className={cn(
                'w-full min-w-[960px] table-fixed',
                model.drag.projectId && 'select-none',
              )}
            >
              <colgroup>
                <col className="w-56" />
                <col className="w-64" />
                <col className="w-64" />
                <col className="w-56" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-48" />
              </colgroup>
              <thead className="bg-muted">
                <tr>
                  <th
                    className="px-4 py-3 text-left text-sm font-medium"
                    aria-sort={ariaSort(model, 'name')}
                  >
                    <SortButton field="name" label="Name" model={model} />
                  </th>
                  <th
                    className="px-4 py-3 text-left text-sm font-medium"
                    aria-sort={ariaSort(model, 'rootPath')}
                  >
                    <SortButton field="rootPath" label="Path" model={model} />
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Description</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Template</th>
                  <th className="px-4 py-3 text-center text-sm font-medium">
                    <span className="flex items-center justify-center gap-1">
                      <ClipboardList className="h-4 w-4" aria-hidden="true" />
                      Epics
                    </span>
                  </th>
                  <th className="px-4 py-3 text-center text-sm font-medium">
                    <span className="flex items-center justify-center gap-1">
                      <Users className="h-4 w-4" aria-hidden="true" />
                      Agents
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
                </tr>
              </thead>
              {model.content.groups.map((group) => (
                <WorkspaceGroup
                  key={group.id}
                  group={group}
                  searchActive={model.content.kind === 'ready' && model.content.searchActive}
                  drag={model.drag}
                />
              ))}
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
