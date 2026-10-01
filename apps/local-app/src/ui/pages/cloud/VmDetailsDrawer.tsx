import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, Lock, LockOpen, Pencil, X } from 'lucide-react';
import { PROVIDER_CLI_NAMES } from '@devchain/shared';
import { REMOTE_NAME_MAX_LENGTH, type RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { RemoteMetricsStrip } from '@/ui/components/remote-metrics/RemoteMetricsStrip';
import { Button } from '@/ui/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/ui/components/ui/drawer';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import type { ProviderAuthEntryItem } from '@/ui/hooks/useProviderAuth';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { ActivityGroup } from './ActivityDialog';
import { LOGIN_PROVIDERS, providerName } from './login-choices';
import type { ActivityNames } from './OperationDetail';
import type { ProjectListRow } from './ProjectList';
import {
  colonFingerprint,
  newestFirst,
  VM_CONNECTION_LABELS,
  vmConnectionSecurity,
  vmReachable,
  type VmAction,
  type VmConnectionSecurity,
  type VmStatus,
} from './remote-status';
import { isValidRename } from './RenameVmDialog';
import { StatusChip } from './StatusChip';
import type { VmMenuItem, VmMenuKey } from './VmList';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt id={id} className="text-muted-foreground">
        {label}
      </dt>
      <dd aria-labelledby={id} className="min-w-0 break-words">
        {children}
      </dd>
    </div>
  );
}

/** The VM's name as the drawer title; Rename edits it in place. */
function EditableName({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (draft === null) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <DrawerTitle className="break-all">{name}</DrawerTitle>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Rename"
          className="h-8 w-8 shrink-0"
          onClick={() => {
            setError(null);
            setDraft(name);
          }}
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  const trimmed = draft.trim();
  const canSave = !saving && isValidRename(trimmed, name);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(trimmed);
      setDraft(null);
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not rename the VM.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-1.5">
      <DrawerTitle className="sr-only">{name}</DrawerTitle>
      <Label htmlFor="vm-drawer-name">Name</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="vm-drawer-name"
          value={draft}
          maxLength={REMOTE_NAME_MAX_LENGTH}
          autoFocus
          disabled={saving}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft(null);
            }
          }}
          className="min-w-[12rem] flex-1"
        />
        <Button type="submit" size="sm" disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => setDraft(null)}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function versionFact(remote: RemoteListItemDto): string {
  if (!remote.version) return 'Unknown';
  return remote.versionMatches
    ? `${remote.version} · same as this PC`
    : `${remote.version} · differs from this PC`;
}

function dockerFact(remote: RemoteListItemDto): string {
  if (!remote.docker) return 'Unknown';
  if (!remote.docker.installed) return 'Not installed';
  return remote.docker.userInGroup ? 'Installed' : 'Installed · restart DevChain to use it';
}

function seenFact(remote: RemoteListItemDto): string {
  if (remote.online) return 'Now';
  const parsed = remote.lastSeenAt ? Date.parse(remote.lastSeenAt) : NaN;
  return Number.isNaN(parsed) ? 'Never' : new Date(parsed).toLocaleString();
}

function ConnectionFact({ security }: { security: VmConnectionSecurity }) {
  const label = VM_CONNECTION_LABELS[security];
  if (security === 'pinned-offline') return <span className="text-muted-foreground">{label}</span>;
  const pinned = security === 'pinned';
  const Icon = pinned ? Lock : LockOpen;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${pinned ? 'text-status-ok' : 'text-status-warn'}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The VM's provider CLI versions. The managed four come from its runtime
 * report; Antigravity has no npm package, so its claim-time version is the
 * only source. An offline VM keeps its last report, which shows as stale.
 * Wording matches the CLI versions table on /providers.
 */
function ProviderCliFacts({ remote }: { remote: RemoteListItemDto }) {
  const stale = !vmReachable(remote);
  const versionText = (version: string | null | undefined): string => {
    if (!version) return '—';
    return stale ? `${version} (stale)` : version;
  };
  return (
    <ul className="space-y-1">
      {PROVIDER_CLI_NAMES.map((provider) => {
        const install = remote.providerClis?.[provider];
        return (
          <li key={provider} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted-foreground">{providerName(provider)}</span>
            {install ? (
              <span
                className={stale ? 'text-muted-foreground' : undefined}
                title={stale ? 'Offline — last known version' : undefined}
              >
                {versionText(install.installedVersion)}
              </span>
            ) : (
              <span className="text-muted-foreground">No report yet</span>
            )}
            {install?.state === 'installing' && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> Installing
              </span>
            )}
            {install?.state === 'failed' && (
              <span className="text-destructive" title={install.error ?? undefined}>
                Failed{install.error ? `: ${install.error}` : ''}
              </span>
            )}
          </li>
        );
      })}
      <li className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">{providerName('agy')}</span>
        {remote.cliVersions?.agy ? (
          <span
            className={stale ? 'text-muted-foreground' : undefined}
            title={stale ? 'Offline — last known version' : undefined}
          >
            {versionText(remote.cliVersions.agy)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </li>
    </ul>
  );
}

function Overview({
  remote,
  security,
  danger,
  onMenu,
}: {
  remote: RemoteListItemDto;
  security: VmConnectionSecurity | null;
  danger: VmMenuItem[];
  onMenu: (key: VmMenuKey) => void;
}) {
  const spec = remote.kind === 'proxmox' ? remote.vmSpec : null;
  return (
    <div className="space-y-4 text-sm">
      <dl className="space-y-2">
        <Fact label="Address">{remote.baseUrl ?? '—'}</Fact>
        {security && (
          <Fact label="Connection">
            <ConnectionFact security={security} />
          </Fact>
        )}
        {remote.tlsFingerprint && (
          <Fact label="Certificate">
            <span className="break-all font-mono text-xs">
              SHA-256 {colonFingerprint(remote.tlsFingerprint)}
            </span>
          </Fact>
        )}
        <Fact label="DevChain version">
          <span
            className={remote.version && !remote.versionMatches ? 'text-status-warn' : undefined}
          >
            {versionFact(remote)}
          </span>
        </Fact>
        <Fact label="Provider CLIs">
          <ProviderCliFacts remote={remote} />
        </Fact>
        {spec && (
          <Fact label="Size">
            {spec.cores} cores · {Math.round(spec.memory / 1024)} GiB memory · {spec.disk} GiB disk
          </Fact>
        )}
        <Fact label="Docker">{dockerFact(remote)}</Fact>
        <Fact label="uid and gid">
          {remote.uid ?? '—'} / {remote.gid ?? '—'}
        </Fact>
        <Fact label="Home folder">
          {remote.homePath ?? 'Not reported'}
          {remote.homePathMatches === true && (
            <span className="text-muted-foreground"> · same as this PC</span>
          )}
          {remote.homePathMatches === false && (
            <span className="text-status-warn"> · differs from this PC</span>
          )}
        </Fact>
        <Fact label="Last seen">{seenFact(remote)}</Fact>
      </dl>
      {vmReachable(remote) && <RemoteMetricsStrip remoteId={remote.id} remoteName={remote.name} />}
      {danger.length > 0 && (
        <section
          aria-label="Danger zone"
          className="space-y-2 rounded-md border border-destructive/40 p-3"
        >
          <h3 className="font-medium text-destructive">Danger zone</h3>
          <div className="flex flex-wrap gap-2">
            {danger.map((item) => (
              <Button
                key={item.key}
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                onClick={() => onMenu(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Each provider's recorded login on the VM, named by its vault label. */
function Logins({
  remote,
  entries,
}: {
  remote: RemoteListItemDto;
  entries: readonly ProviderAuthEntryItem[];
}) {
  if (!remote.logins) {
    return (
      <p className="text-sm text-muted-foreground">
        This PC has not set up this VM, so it has no logins on record.
      </p>
    );
  }
  const labels = new Map(entries.map((entry) => [entry.id, entry.label]));
  const describe = (provider: string): string => {
    const login = remote.logins?.[provider];
    if (!login || login.choice === 'skip') return 'None';
    if (login.entryIds.length === 0) return 'New login';
    return login.entryIds.map((id) => labels.get(id) ?? 'A deleted login').join(', ');
  };
  return (
    <dl className="space-y-2 text-sm">
      {LOGIN_PROVIDERS.map((provider) => (
        <Fact key={provider} label={providerName(provider)}>
          {describe(provider)}
        </Fact>
      ))}
    </dl>
  );
}

/**
 * One VM's facts, projects, logins and history. The URL's `vm=<id>` opens it,
 * so a link or a reload lands on the same VM.
 */
export function VmDetailsDrawer({
  remote,
  status,
  where,
  menu,
  projects,
  operations,
  recentFinished,
  names,
  loginEntries,
  powerOnPending,
  onClose,
  onAction,
  onMenu,
  onRename,
  onOpenActivity,
  onConnectProject,
  renderProjectAction,
}: {
  remote: RemoteListItemDto;
  status: VmStatus;
  where: string;
  menu: VmMenuItem[];
  /** The projects on this VM, named from every workspace. */
  projects: ProjectListRow[];
  operations: readonly RemoteOperationDto[];
  recentFinished: readonly RemoteOperationDto[];
  names: ActivityNames;
  loginEntries: readonly ProviderAuthEntryItem[];
  powerOnPending: boolean;
  onClose: () => void;
  onAction: (action: VmAction) => void;
  onMenu: (key: VmMenuKey) => void;
  /** Rejects with the server's message, which shows under the name. */
  onRename: (name: string) => Promise<void>;
  onOpenActivity: (operationId: string) => void;
  /** Absent until the page can connect a project from a VM. */
  onConnectProject?: () => void;
  renderProjectAction: (row: ProjectListRow) => ReactNode;
}) {
  const [tab, setTab] = useState('overview');
  const { action } = status;
  const changeLogins = menu.some((item) => item.key === 'change-logins');
  const resetApiKey = menu.some((item) => item.key === 'reset-api-key');
  const danger = menu.filter((item) => item.danger);
  const own = (operation: RemoteOperationDto) => operation.remoteId === remote.id;
  const running = operations.filter((op) => own(op) && op.state === 'running').sort(newestFirst);
  const stopped = operations.filter((op) => own(op) && op.state === 'failed').sort(newestFirst);
  // Keeps the hook's end-time order, so Finished matches the Activity dialog.
  const finished = recentFinished.filter(own);

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent side="right" className="gap-4 overflow-y-auto p-4 sm:p-6">
        <DrawerHeader className="space-y-2 p-0 text-left">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <EditableName name={remote.name} onRename={onRename} />
            </div>
            <DrawerClose asChild>
              <Button type="button" size="icon" variant="ghost" aria-label="Close details">
                <X className="h-4 w-4" />
              </Button>
            </DrawerClose>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
            {status.note && <span className="text-xs text-muted-foreground">{status.note}</span>}
          </div>
          <DrawerDescription className="break-all">{where}</DrawerDescription>
          <div className="flex flex-wrap gap-2 pt-1">
            {action && (
              <Button
                size="sm"
                variant={status.tone === 'error' ? 'destructive' : 'default'}
                disabled={action.kind === 'power-on' && powerOnPending}
                onClick={() => onAction(action)}
              >
                {action.kind === 'power-on' && powerOnPending ? 'Starting…' : action.label}
              </Button>
            )}
            {onConnectProject && status.state === 'ready' && (
              <Button size="sm" variant="outline" onClick={onConnectProject}>
                Connect a project
              </Button>
            )}
            {resetApiKey && (
              <Button size="sm" variant="outline" onClick={() => onMenu('reset-api-key')}>
                Reset API key
              </Button>
            )}
            {changeLogins && (
              <Button size="sm" variant="outline" onClick={() => onMenu('change-logins')}>
                Change logins
              </Button>
            )}
          </div>
        </DrawerHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="projects">Projects ({projects.length})</TabsTrigger>
            <TabsTrigger value="logins">Logins</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-2">
            <Overview
              remote={remote}
              security={vmConnectionSecurity(remote, status.state)}
              danger={danger}
              onMenu={onMenu}
            />
          </TabsContent>
          <TabsContent value="projects" className="pt-2">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">No projects run on this VM.</p>
            ) : (
              <ul aria-label="Projects on this VM" className="divide-y rounded-md border">
                {projects.map((row) => (
                  <li
                    key={row.project.id}
                    aria-label={row.project.name}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block break-words font-medium">{row.project.name}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusChip tone={row.status.tone}>{row.status.label}</StatusChip>
                        {row.status.note && (
                          <span className="text-xs text-muted-foreground">{row.status.note}</span>
                        )}
                      </span>
                    </span>
                    {renderProjectAction(row)}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="logins" className="space-y-3 pt-2">
            <Logins remote={remote} entries={loginEntries} />
            {resetApiKey && (
              <Button size="sm" variant="outline" onClick={() => onMenu('reset-api-key')}>
                Reset API key
              </Button>
            )}
            {changeLogins && (
              <Button size="sm" variant="outline" onClick={() => onMenu('change-logins')}>
                Change logins
              </Button>
            )}
          </TabsContent>
          <TabsContent value="activity" className="space-y-4 pt-2">
            {running.length + stopped.length + finished.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity for this VM yet.</p>
            ) : (
              <>
                <ActivityGroup
                  title="Running"
                  operations={running}
                  names={names}
                  onOpen={onOpenActivity}
                />
                <ActivityGroup
                  title="Needs attention"
                  operations={stopped}
                  names={names}
                  onOpen={onOpenActivity}
                />
                <ActivityGroup
                  title="Finished"
                  operations={finished}
                  names={names}
                  onOpen={onOpenActivity}
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}
