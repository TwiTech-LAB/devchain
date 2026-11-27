import { useEffect, useId, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  XCircle,
} from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Spinner } from '@/ui/components/ui/spinner';
import { TableCell, TableHead, TableRow } from '@/ui/components/ui/table';
import type { StatusTone } from '@/ui/lib/status-tone';
import { cn } from '@/ui/lib/utils';
import {
  SYNC_VERDICT_TONES,
  WRAP,
  bytesText,
  countText,
  folderLabel,
  formatTime,
  groupOf,
  lastReceivedText,
  pendingText,
  type FileSyncProjectItem,
  type FileSyncTabActions,
} from './file-sync-display';
import type { FileSyncStatusFolder, FileSyncStatusScope } from './lib/remote-vm-contracts';
import type { ProjectListRow } from './ProjectList';
import { measuredSyncText } from './remote-status';
import { StatusChip } from './StatusChip';

const DIRECTIONS: Record<string, string> = {
  sendreceive: 'Two-way',
  sendonly: 'This PC sends',
  receiveonly: 'This PC receives',
};

/**
 * The tone colors the icon only. The text stays `foreground`, because a status color is not
 * readable as text in every theme, and less so on the tint of an attention row.
 */
const TONE_ICONS: Record<StatusTone, { icon: typeof Circle | null; color: string }> = {
  ok: { icon: CheckCircle2, color: 'text-status-ok' },
  warn: { icon: AlertTriangle, color: 'text-status-warn' },
  error: { icon: XCircle, color: 'text-destructive' },
  running: { icon: null, color: 'text-primary' },
  info: { icon: Clock, color: 'text-status-info' },
  neutral: { icon: Circle, color: 'text-muted-foreground' },
};

const HEAD = 'h-10 px-2 md:px-4';
const CELL = 'px-2 py-2 md:p-4 align-top';
/** The columns that a narrow screen hides; the details row shows their values there. */
const WIDE = 'hidden md:table-cell';

/** "Today, 19:00" for the current day, else "Nov 24, 19:00". */
function shortTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'unknown';
  const at = new Date(parsed);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === new Date().toDateString()) return `Today, ${time}`;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn(WRAP, 'tabular-nums')}>{children}</dd>
    </div>
  );
}

function PendingPaths({ folder }: { folder: FileSyncStatusFolder }) {
  const groups = [
    { label: 'Waiting to go to the VM', direction: 'toVm' },
    { label: 'Waiting to come from the VM', direction: 'fromVm' },
  ] as const;
  return groups.map(({ label, direction }) => {
    const paths = folder.pending.filter((item) => item.direction === direction);
    if (paths.length === 0) return null;
    return (
      <div key={direction}>
        <p className="text-xs text-muted-foreground">{label}</p>
        <ul className="font-mono text-xs">
          {paths.map((item) => (
            <li key={item.path} className="break-all">
              {item.path}
            </li>
          ))}
        </ul>
      </div>
    );
  });
}

function FolderBlock({ folder }: { folder: FileSyncStatusFolder }) {
  return (
    <section
      aria-label={folderLabel(folder.id)}
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium">{folderLabel(folder.id)}</h4>
        <span className="text-muted-foreground">{DIRECTIONS[folder.type] ?? folder.type}</span>
        {folder.paused && <StatusChip tone="info">Paused</StatusChip>}
      </div>
      {folder.error && <p className={cn(WRAP, 'text-destructive')}>{folder.error}</p>}
      {folder.watchError && (
        <p className={cn('flex items-start gap-1.5', WRAP)}>
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
          <span className="min-w-0">
            This PC does not watch this folder for changes: {folder.watchError}. Changes sync after
            the next scan.
          </span>
        </p>
      )}
      <PendingPaths folder={folder} />
    </section>
  );
}

function SyncStatus({ scope }: { scope: FileSyncStatusScope }) {
  const tone = SYNC_VERDICT_TONES[scope.verdict];
  const { icon: Icon, color } = TONE_ICONS[tone];
  return (
    <span className={cn('flex items-start gap-1.5', WRAP)}>
      {Icon ? (
        <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0', color)} />
      ) : (
        <Spinner className={cn('mt-0.5 h-4 w-4 shrink-0', color)} />
      )}
      <span className="min-w-0">{measuredSyncText(scope)}</span>
    </span>
  );
}

function FixButton({
  row,
  actions,
  className,
}: {
  row: ProjectListRow | undefined;
  actions: FileSyncTabActions;
  className?: string;
}) {
  if (!row || !actions.canFixFileSync(row)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      onClick={() => actions.fixFileSync(row)}
    >
      Fix file sync
    </Button>
  );
}

function ProjectDetails({
  id,
  item,
  actions,
}: {
  id: string;
  item: FileSyncProjectItem;
  actions: FileSyncTabActions;
}) {
  const { scope, project, row } = item;
  return (
    <section id={id} aria-label={`${project} details`} className="space-y-3">
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="To the VM" className="md:hidden">
          {pendingText(scope.toVm)}
        </Field>
        <Field label="From the VM" className="md:hidden">
          {pendingText(scope.fromVm)}
        </Field>
        <Field label="Failed">
          {countText(scope.failed.home)} on this PC · {countText(scope.failed.vm)} on the VM (last
          reported)
        </Field>
        <Field label="Files">
          {countText(scope.files)} files, {bytesText(scope.bytes)}
        </Field>
        <Field label="Last received">{lastReceivedText(scope.lastReceived, formatTime)}</Field>
      </dl>
      {scope.folders ? (
        scope.folders.map((folder) => <FolderBlock key={folder.id} folder={folder} />)
      ) : (
        <p className="text-sm text-muted-foreground">Loading the folder details…</p>
      )}
      {row && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => actions.openSettings(row)}>
            File sync settings
          </Button>
          <FixButton row={row} actions={actions} className="md:hidden" />
        </div>
      )}
    </section>
  );
}

/** The header row of the File sync table; its columns match `FileSyncProjectRow`. */
export function FileSyncProjectHead() {
  return (
    <TableRow className="hover:bg-transparent">
      <TableHead className={HEAD}>Project</TableHead>
      <TableHead className={HEAD}>Status</TableHead>
      <TableHead className={cn(HEAD, WIDE)}>To VM / From VM</TableHead>
      <TableHead className={cn(HEAD, WIDE)}>Last received</TableHead>
      <TableHead className={cn(HEAD, WIDE)}>
        <span className="sr-only">Action</span>
      </TableHead>
    </TableRow>
  );
}

/** A project row of the File sync table and, while it is expanded, its details row. */
export function FileSyncProjectRow({
  item,
  expanded,
  onToggle,
  focus,
  onFocused,
  actions,
}: {
  item: FileSyncProjectItem;
  expanded: boolean;
  onToggle: (projectId: string) => void;
  focus: boolean;
  onFocused: () => void;
  actions: FileSyncTabActions;
}) {
  const detailsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    toggleRef.current?.focus();
    onFocused();
  }, [focus, onFocused]);
  const { scope, project, vm } = item;
  const attention = groupOf(item) === 'attention';
  return (
    <>
      <TableRow
        aria-label={project}
        className={cn(attention && 'bg-status-warn/5 hover:bg-status-warn/10')}
      >
        <TableCell
          className={cn(
            CELL,
            'border-l-2',
            attention ? 'border-l-status-warn' : 'border-l-transparent',
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              '-ml-2 h-auto min-h-9 justify-start gap-1 whitespace-normal text-left font-medium md:min-w-36',
              WRAP,
            )}
            ref={toggleRef}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => onToggle(scope.projectId)}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0">{project}</span>
          </Button>
          {/* On the tint of an attention row the secondary text color is not readable. */}
          <p className={cn(WRAP, 'text-xs', !attention && 'text-muted-foreground')}>{vm}</p>
        </TableCell>
        <TableCell className={CELL}>
          <SyncStatus scope={scope} />
        </TableCell>
        <TableCell className={cn(CELL, WIDE, 'whitespace-nowrap tabular-nums')}>
          <p>To VM: {pendingText(scope.toVm)}</p>
          <p>From VM: {pendingText(scope.fromVm)}</p>
        </TableCell>
        <TableCell className={cn(CELL, WIDE, 'whitespace-nowrap tabular-nums')}>
          {scope.lastReceived ? shortTime(scope.lastReceived.at) : 'unknown'}
        </TableCell>
        <TableCell className={cn(CELL, WIDE, 'text-right')}>
          <FixButton row={item.row} actions={actions} />
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className={CELL}>
            <ProjectDetails id={detailsId} item={item} actions={actions} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
