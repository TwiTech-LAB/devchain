import { useEffect, useRef, useState } from 'react';
import type {
  DockerDataChoice,
  DockerDataState,
  DockerPlan,
  DockerPlanItem,
  DockerPlanMount,
  DockerPlanSize,
  DockerSelectionItem,
  DockerSelectionMode,
} from '@/modules/remotes/docker/docker-plan.dto';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { BusyStatus } from '@/ui/components/ui/spinner';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { cn } from '@/ui/lib/utils';
import type { DockerPresenceState } from './docker-presence';
import { formatBytes, formatDuration } from './file-sync-display';
import { userIds } from '@/modules/remotes/vm-user-identity';

/** What the Connect dialog needs to gate its button and build the request. */
export interface DockerSectionState {
  /** A plan answered and parsed; until then Connect keeps its old behavior. */
  ready: boolean;
  /** The current selection; empty means a Connect without Docker work. */
  items: DockerSelectionItem[];
  /** The plan's verdict for this selection (fit, blockers). */
  canConnect: boolean;
  /** A plan request is in flight; a loaded plan must not be acted on stale. */
  pending: boolean;
}

const MODE_LABELS: Record<DockerSelectionMode, string> = {
  'container-and-data': 'Container and data',
  'without-data': 'Copy without its data',
  'data-only': 'Copy its data only',
};

/** Without data starts the container with empty data when the VM holds none of it. */
function modeLabel(item: DockerPlanItem, mode: DockerSelectionMode): string {
  if (mode === 'without-data' && item.dataState === 'no-record') return 'Start with empty data';
  return MODE_LABELS[mode];
}

const MOUNT_KIND_LABELS: Record<DockerPlanMount['kind'], string> = {
  'named-volume': 'named volume',
  'anonymous-volume': 'anonymous volume',
  'project-bind': 'in-project data folder',
  'project-code': 'in-project folder, synced by file sync',
  'home-bind': 'home folder',
  'readonly-external-bind': 'read-only folder',
  'external-bind': 'external folder',
};

const TARGET_ACTION_LABELS: Record<DockerPlanItem['targetAction'], string> = {
  create: '',
  replace: 'Replaces the VM copy',
  'leave-as-is': 'Keeps the VM copy',
  conflict: 'Conflicts with an item on the VM',
  'data-only': 'Data only; no container is created',
};

const DATA_STATE_LABELS: Record<DockerDataState, string> = {
  'in-sync': 'In sync',
  'vm-newer': 'VM data changed',
  'home-newer': 'Home data changed',
  'both-changed': 'Both sides changed',
  unknown: 'Changes unknown',
  'no-record': 'No VM data',
};

function sizeLabel(size: DockerPlanSize): string {
  return size.unknown
    ? `unknown size, at least ${formatBytes(size.bytes)}`
    : formatBytes(size.bytes);
}

/** "at least" when part of the size is unknown. */
function shortSizeLabel(size: DockerPlanSize): string {
  if (!size.unknown) return formatBytes(size.bytes);
  return size.bytes > 0 ? `at least ${formatBytes(size.bytes)}` : 'size unknown';
}

/**
 * What the item moves in this mode: its images, plus its data unless the mode
 * or a kept VM copy leaves the data behind.
 */
function itemSize(item: DockerPlanItem, mode: DockerSelectionMode): DockerPlanSize {
  const images = [
    ...new Map(
      item.images.filter((image) => !image.notCopied).map((image) => [image.id, image.size]),
    ).values(),
  ];
  const parts = [
    ...(mode === 'data-only' ? [] : images),
    ...(mode === 'without-data' || item.dataAction === 'keep-vm'
      ? []
      : [item.dataSize ?? { bytes: 0, unknown: true }]),
  ];
  return {
    bytes: parts.reduce((total, size) => total + size.bytes, 0),
    unknown: parts.some((size) => size.unknown),
  };
}

/** The in-project data folders the item copies in this mode: project files git does not track. */
function projectDataFolders(
  item: DockerPlanItem,
  mode: DockerSelectionMode | null | undefined,
): DockerPlanMount[] {
  if (!mode || mode === 'without-data' || item.dataAction === 'keep-vm' || item.temporary)
    return [];
  return item.mounts.filter((mount) => mount.kind === 'project-bind');
}

/**
 * "incl. 2.3 GB of non-git shared project files (tmp)". Each folder counts once,
 * and a folder inside another counts with it, as the copy does.
 */
function projectFilesNote(folders: DockerPlanMount[]): string | null {
  const unique = [...new Map(folders.map((mount) => [mount.source, mount])).values()];
  const outer = unique.filter(
    (mount) =>
      !unique.some((other) => other !== mount && mount.source.startsWith(`${other.source}/`)),
  );
  if (outer.length === 0) return null;
  const size = {
    bytes: outer.reduce((total, mount) => total + mount.size.bytes, 0),
    unknown: outer.some((mount) => mount.size.unknown),
  };
  const amount = size.unknown && size.bytes === 0 ? '' : `${shortSizeLabel(size)} of `;
  const where = outer.length === 1 ? outer[0].source.split('/').pop() : `${outer.length} folders`;
  return `incl. ${amount}non-git shared project files (${where})`;
}

function linkedReasonLabel(reason: string): string {
  if (reason === 'compose-file-at-project-root') return 'compose file at the project root';
  if (reason.startsWith('bind:')) return `bind at ${reason.slice('bind:'.length)}`;
  return `Compose label ${reason}`;
}

/** "2–8 minutes (approximate)"; seconds for short ranges. */
export function formatCopyRange(minSeconds: number, maxSeconds: number): string {
  return `${formatDuration(minSeconds)}–${formatDuration(maxSeconds)} (approximate)`;
}

/** The included items with their mode: the chosen one, else the first choice. */
function selectionOf(
  items: readonly DockerPlanItem[],
  include: Record<string, boolean>,
  chosen: Record<string, DockerSelectionMode>,
  data: Record<string, DockerDataChoice>,
  acceptance: Record<string, boolean>,
): DockerSelectionItem[] {
  return items.flatMap((item) => {
    const mode = chosen[item.id] ?? item.choices[0];
    return include[item.id] && mode !== undefined
      ? [
          {
            id: item.id,
            mode,
            ...(data[item.id] && { dataChoice: data[item.id] }),
            ...(acceptance[item.id] && { acceptPrivileged: true as const }),
          },
        ]
      : [];
  });
}

/** A Connect without Docker work: nothing read, nothing selected. */
export const NO_DOCKER_STATE: DockerSectionState = {
  ready: false,
  items: [],
  canConnect: false,
  pending: false,
};

interface DockerSectionProps {
  presence: DockerPresenceState;
  initialIncludeDocker?: boolean;
  managedVm?: boolean;
  projectId: string;
  remoteId: string;
  disabled: boolean;
  onStateChange: (state: DockerSectionState) => void;
}

/**
 * Reads the plan while Include Docker containers is checked. Opting out
 * unmounts the plan, which aborts its requests and drops the selection,
 * so the Connect goes without Docker items.
 */
export function ConnectDockerSection(props: DockerSectionProps) {
  const { remoteId, disabled, onStateChange, presence } = props;
  const [enabled, setEnabled] = useState(props.initialIncludeDocker ?? false);
  const visible = presence !== 'loading' && presence !== 'absent';

  useEffect(() => {
    if (!visible || !enabled)
      onStateChange({ ...NO_DOCKER_STATE, pending: presence === 'loading' && enabled });
  }, [enabled, visible, presence, onStateChange]);

  if (!visible) return null;

  return (
    <div className="space-y-2 text-sm">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`docker-include-${remoteId}`}
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          <Label htmlFor={`docker-include-${remoteId}`} className="font-normal">
            Include Docker containers
          </Label>
        </div>
        <p className="text-muted-foreground">
          <strong>Optional.</strong> Moves this project&apos;s containers and their data to the VM;
          files sync either way. Next waits until the read is done.
        </p>
      </div>
      {enabled && <DockerPlanSection {...props} />}
    </div>
  );
}

/**
 * Reads the import plan for the chosen remote, lets the user pick items and
 * modes, and reports the selection with the plan's verdict. Only the latest
 * plan request is ever applied, and while one is pending the dialog does not
 * act on the previous answer. A plan that cannot be read never blocks a
 * Connect without Docker items — the section degrades to a note.
 */
function DockerPlanSection({
  projectId,
  remoteId,
  disabled,
  onStateChange,
  managedVm = false,
}: DockerSectionProps) {
  const api = useRemoteVmApi();
  const [plan, setPlan] = useState<DockerPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [modes, setModes] = useState<Record<string, DockerSelectionMode>>({});
  const [dataChoices, setDataChoices] = useState<Record<string, DockerDataChoice>>({});
  const [privilegedAcceptance, setPrivilegedAcceptance] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(true);
  const plannedRef = useRef<string | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const latest = useRef({ plan, included, modes, dataChoices, privilegedAcceptance });
  latest.current = { plan, included, modes, dataChoices, privilegedAcceptance };
  /**
   * The newest plan request. A newer request, a remote change or an unmount
   * aborts it, so only the newest answer may change the state.
   */
  const requestRef = useRef<AbortController | null>(null);
  const nextRequest = (): AbortSignal => {
    requestRef.current?.abort();
    requestRef.current = new AbortController();
    return requestRef.current.signal;
  };
  // The dialog keys this section by remote, so each remote starts from a fresh state.
  useEffect(() => {
    if (!remoteId) return;
    const signal = nextRequest();
    const run = async () => {
      setError(null);
      setPending(true);
      try {
        const body = await api.readDockerPlan(projectId, { remoteId }, signal);
        if (signal.aborted) return;
        const previous = latest.current;
        const nextIncluded: Record<string, boolean> = {};
        const nextModes: Record<string, DockerSelectionMode> = {};
        const nextData: Record<string, DockerDataChoice> = {};
        const nextAcceptance: Record<string, boolean> = {};
        const itemKey = (item: DockerPlanItem) =>
          JSON.stringify([item.kind, item.composeProject, item.name]);
        const oldItems = new Map((previous.plan?.items ?? []).map((item) => [itemKey(item), item]));
        // A known item keeps its pick, a new item after the first plan starts unpicked,
        // and the first plan uses the server's default.
        const wasPicked = (item: DockerPlanItem, old: DockerPlanItem | undefined): boolean => {
          if (old) return previous.included[old.id] === true;
          if (previous.plan) return false;
          return item.defaultSelected;
        };
        for (const item of body.items) {
          const old = oldItems.get(itemKey(item));
          nextIncluded[item.id] = item.choices.length > 0 && wasPicked(item, old);
          const chosen = old ? previous.modes[old.id] : item.selectedMode;
          if (chosen && item.choices.includes(chosen)) nextModes[item.id] = chosen;
          if (old && previous.dataChoices[old.id]) nextData[item.id] = previous.dataChoices[old.id];
          if (old && previous.privilegedAcceptance[old.id]) nextAcceptance[item.id] = true;
        }
        const currentKeys = new Set(body.items.map(itemKey));
        setDropped(
          (previous.plan?.items ?? [])
            .filter((item) => previous.included[item.id] && !currentKeys.has(itemKey(item)))
            .map((item) => item.name),
        );
        setIncluded(nextIncluded);
        setModes(nextModes);
        setDataChoices(nextData);
        setPrivilegedAcceptance(nextAcceptance);
        plannedRef.current = null;
        setPlan(body);
        if (previous.plan && body.availability.available) {
          const items = selectionOf(body.items, nextIncluded, nextModes, nextData, nextAcceptance);
          const refreshed = await api.readDockerPlan(projectId, { remoteId, items }, signal);
          if (signal.aborted) return;
          setPlan(refreshed);
          plannedRef.current = JSON.stringify({ remoteId, items });
        }
      } catch (cause) {
        if (signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPlan(null);
        setIncluded({});
        setModes({});
      } finally {
        if (!signal.aborted) setPending(false);
      }
    };
    void run();
    return () => requestRef.current?.abort();
  }, [api, projectId, remoteId]);

  const requestPlan = async (items: DockerSelectionItem[]) => {
    const payload = JSON.stringify({ remoteId, items });
    if (plannedRef.current === payload) return;
    plannedRef.current = payload;
    setError(null);
    const signal = nextRequest();
    setPending(true);
    try {
      const body = await api.readDockerPlan(projectId, { remoteId, items }, signal);
      if (signal.aborted) return;
      setPlan(body);
    } catch (cause) {
      if (signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal.aborted) setPending(false);
    }
  };

  const selectionFor = (
    include: Record<string, boolean>,
    chosen: Record<string, DockerSelectionMode>,
    data: Record<string, DockerDataChoice> = dataChoices,
    acceptance: Record<string, boolean> = privilegedAcceptance,
  ): DockerSelectionItem[] => selectionOf(plan?.items ?? [], include, chosen, data, acceptance);

  const selection = selectionFor(included, modes);

  useEffect(() => {
    onStateChange({
      ready: plan !== null && plan.availability.available,
      items: selection,
      canConnect: !error && (plan?.canConnect ?? false),
      pending,
    });
  }, [plan, included, modes, dataChoices, privilegedAcceptance, pending, error, onStateChange]);

  const toggle = (item: DockerPlanItem, checked: boolean) => {
    setIncluded((current) => ({ ...current, [item.id]: checked }));
    void requestPlan(selectionFor({ ...included, [item.id]: checked }, modes));
  };

  const changeMode = (item: DockerPlanItem, mode: DockerSelectionMode) => {
    setModes((current) => ({ ...current, [item.id]: mode }));
    void requestPlan(selectionFor(included, { ...modes, [item.id]: mode }));
  };

  const changeDataChoice = (item: DockerPlanItem, choice: DockerDataChoice) => {
    const next = { ...dataChoices };
    for (const id of item.dataGroup ?? [item.id]) next[id] = choice;
    setDataChoices(next);
    void requestPlan(selectionFor(included, modes, next));
  };

  const changePrivilegedAcceptance = (item: DockerPlanItem, accepted: boolean) => {
    const next = { ...privilegedAcceptance, [item.id]: accepted };
    setPrivilegedAcceptance(next);
    void requestPlan(selectionFor(included, modes, dataChoices, next));
  };

  if (error) {
    return (
      <p role="note" className="text-sm text-muted-foreground">
        Docker import is unavailable: {error}
      </p>
    );
  }
  if (!plan) {
    return (
      <BusyStatus className="text-sm text-muted-foreground">Reading Docker containers…</BusyStatus>
    );
  }
  const { availability } = plan;
  if (!availability.available) {
    if (availability.reason?.code === 'vm-user-mismatch') {
      const mismatch = availability.userMismatch;
      const conflict = mismatch?.uidConflict;
      return (
        <div role="note" aria-label="Docker availability" className="space-y-2 text-sm">
          <p className="font-medium">Automatic Docker move is off for this VM.</p>
          <p>
            Connect, file sync and agents work as usual. Only the automatic move of containers and
            their data needs the same user ids on this PC and the VM: here{' '}
            {userIds(mismatch?.homeUid ?? null, mismatch?.homeGid ?? null)} and{' '}
            {userIds(mismatch?.vmUid ?? null, mismatch?.vmGid ?? null)}.
            {conflict?.holder &&
              ` (uid ${conflict.requestedUid} belongs to ${conflict.holder} on the VM)`}
          </p>
          {!managedVm && conflict?.holder && (
            <p>
              To turn it on, set up the VM from another account and remove {conflict.holder}, or use
              a VM where uid {conflict.requestedUid} is free.
            </p>
          )}
          <p>
            You can still move what you need yourself, for example with <code>docker save</code> and{' '}
            <code>docker load</code> for images, and a volume export and import for data.
          </p>
        </div>
      );
    }
    const installHint =
      availability.reason?.code === 'remote-no-docker'
        ? ' The VM needs Docker; use Update VM with Install Docker before connecting with containers.'
        : '';
    return (
      <div role="note" aria-label="Docker availability" className="text-sm">
        <p>{availability.reason?.message ?? 'Docker is not usable for this connect.'}</p>
        {installHint && <p className="text-muted-foreground">{installHint}</p>}
      </div>
    );
  }

  const nameOf = (id: string): string =>
    plan.items.find((candidate) => candidate.id === id)?.name ?? id;
  // Only containers linked to the project are offered. The plan keeps the others,
  // so "Connect also stops" can still name one that shares data with a pick.
  const linked = plan.items.filter((item) => item.linkedReasons.length > 0);
  // From the server's selection, like the total that it explains.
  const totalProjectFiles = projectFilesNote(
    plan.items.flatMap((item) => projectDataFolders(item, item.selectedMode)),
  );

  return (
    <section aria-label="Docker containers" className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3>Docker containers</h3>
        {pending && <BusyStatus className="text-muted-foreground">Updating the plan…</BusyStatus>}
      </div>
      {dropped.length > 0 && (
        <p role="note">
          No longer available; removed from your Docker choices: {dropped.join(', ')}.
        </p>
      )}
      {plan.reconnect && (
        <div role="note" aria-label="Reconnect replacement" className="space-y-1">
          <p className="font-medium">
            Replaces the VM&apos;s copy from {new Date(plan.reconnect.importedAt).toLocaleString()}
          </p>
          <ul className="list-disc pl-5">
            {plan.reconnect.replacing.map((name, index) => (
              <li key={`${name}:${index}`}>{name}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">{plan.reconnect.lossNotice}</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="font-medium">Linked to this project</p>
        <p className="text-muted-foreground">
          Containers that are not linked to this project stay on this PC.
        </p>
        {linked.length === 0 && <p className="text-muted-foreground">None.</p>}
        <ul className="space-y-2">
          {/* The server computes "also stops" with the handoff's own stop rule. */}
          {linked.map((item) => (
            <DockerItemRow
              key={item.id}
              item={item}
              included={included[item.id] === true}
              mode={modes[item.id] ?? item.choices[0]}
              dataChoice={dataChoices[item.id]}
              acceptPrivileged={privilegedAcceptance[item.id] === true}
              alsoStops={included[item.id] === true ? item.alsoStops.map(nameOf) : []}
              disabled={disabled}
              onToggle={(checked) => toggle(item, checked)}
              onModeChange={(mode) => changeMode(item, mode)}
              onDataChoiceChange={(choice) => changeDataChoice(item, choice)}
              onPrivilegedAcceptanceChange={(accepted) =>
                changePrivilegedAcceptance(item, accepted)
              }
            />
          ))}
        </ul>
      </div>
      {plan.filesystems.some((fs) => fs.status !== 'fits') && (
        <div aria-label="Docker space" className="space-y-1">
          {plan.filesystems
            .filter((fs) => fs.status !== 'fits')
            .map((fs, index) => (
              <p
                key={`${fs.filesystemId ?? 'unknown'}:${fs.paths.join(',')}:${index}`}
                className={fs.status === 'refused' ? 'text-destructive' : 'text-status-warn'}
              >
                {fs.status === 'refused' &&
                  `Needs ${formatBytes(fs.requiredBytes)} on ${fs.paths.join(', ')}, but only ${formatBytes(fs.freeBytes ?? 0)} is free.`}
                {fs.status === 'warning' &&
                  `Uses more than 80% of ${fs.paths.join(', ')}: needs ${formatBytes(fs.requiredBytes)} of ${formatBytes(fs.freeBytes ?? 0)} free.`}
                {fs.status === 'unknown' &&
                  `Free space is unknown on ${fs.paths.join(', ')}; the need is at least ${formatBytes(fs.requiredBytes)}.`}
              </p>
            ))}
        </div>
      )}
      {selection.length > 0 && (
        <p>
          Total for {selection.length} selected{' '}
          {selection.length === 1 ? 'container' : 'containers'}: {shortSizeLabel(plan.copySize)} on
          the VM{totalProjectFiles && `, ${totalProjectFiles}`}.
        </p>
      )}
      {plan.estimate && (
        <p className="text-muted-foreground">
          Estimated copy time: {formatCopyRange(plan.estimate.minSeconds, plan.estimate.maxSeconds)}
          .
        </p>
      )}
      {plan.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-status-warn">
          {plan.warnings.map((warning, index) => (
            <li key={`${warning.code}:${index}`}>{warning.message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Selects that read as controls, not as text. */
const CONTROL_CLASS =
  'h-8 w-auto min-w-[12rem] border-foreground/30 bg-muted/60 font-medium shadow-sm hover:bg-muted';

/** A control that Connect waits for. */
const REQUIRED_CLASS =
  'border-status-warn ring-2 ring-status-warn ring-offset-1 ring-offset-background';

/**
 * One item on one line: its pick, its size in the chosen mode and the mode.
 * Links, data, images and notes open under Details. Blockers, warnings and
 * the containers Connect also stops stay in view, as they change what Connect
 * does, and a choice that Connect waits for is highlighted.
 */
function DockerItemRow({
  item,
  included,
  mode,
  dataChoice,
  acceptPrivileged,
  alsoStops,
  disabled,
  onToggle,
  onModeChange,
  onDataChoiceChange,
  onPrivilegedAcceptanceChange,
}: {
  item: DockerPlanItem;
  included: boolean;
  /** The chosen mode, else the first choice; none when the item has no choices. */
  mode: DockerSelectionMode | undefined;
  dataChoice: DockerDataChoice | undefined;
  acceptPrivileged: boolean;
  alsoStops: string[];
  disabled: boolean;
  onToggle: (checked: boolean) => void;
  onModeChange: (mode: DockerSelectionMode) => void;
  onDataChoiceChange: (choice: DockerDataChoice) => void;
  onPrivilegedAcceptanceChange: (accepted: boolean) => void;
}) {
  // An item without choices cannot be selected; the server would refuse every
  // mode for it, so it only ever shows its reasons.
  const selectable = item.choices.length > 0;
  const choiceMissing = included && item.dataChoiceRequired === true && dataChoice === undefined;
  const privilegedContainer =
    item.privileged && (mode === 'container-and-data' || mode === 'without-data');
  const acceptanceMissing = included && privilegedContainer && !acceptPrivileged;
  const blockers = item.blockers.filter((blocker) => blocker.code !== 'privileged-not-accepted');
  // Where the VM holds the item's data, Keep VM copy or Replace is the choice; the
  // server's default for the data state is preselected.
  const vmData = item.dataState !== 'no-record' ? item.dataState : undefined;
  const projectFiles = projectFilesNote(projectDataFolders(item, mode ?? 'container-and-data'));
  return (
    <Collapsible asChild>
      <li
        className={cn(
          'space-y-2 rounded-md border p-2',
          (choiceMissing || acceptanceMissing) && 'border-status-warn',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <Checkbox
              id={`docker-item-${item.id}`}
              checked={included}
              disabled={disabled || !selectable}
              onCheckedChange={(checked) => onToggle(checked === true)}
            />
            <Label htmlFor={`docker-item-${item.id}`}>{item.name}</Label>
            <span className="text-muted-foreground">
              {item.kind === 'compose-project' ? 'Compose project' : 'Container'}
            </span>
            <span className="tabular-nums">
              {shortSizeLabel(itemSize(item, mode ?? 'container-and-data'))}
            </span>
            {projectFiles && <span className="text-muted-foreground">{projectFiles}</span>}
            {item.temporary && (
              <Badge variant="outline" className="font-normal">
                temporary
              </Badge>
            )}
            {item.targetAction !== 'create' && (
              <Badge
                variant="outline"
                className={cn(
                  'font-normal',
                  item.targetAction === 'conflict' && 'border-destructive text-destructive',
                )}
              >
                {TARGET_ACTION_LABELS[item.targetAction]}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {item.choices.length > 1 ? (
              <Select
                value={mode}
                disabled={disabled || !included}
                onValueChange={(value) => onModeChange(value as DockerSelectionMode)}
              >
                <SelectTrigger aria-label={`Mode for ${item.name}`} className={CONTROL_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {item.choices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {modeLabel(item, choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              mode !== undefined &&
              mode !== 'container-and-data' && (
                <span className="text-muted-foreground">Mode: {modeLabel(item, mode)}</span>
              )
            )}
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="group h-8 gap-1 px-2"
                aria-label={`Details for ${item.name}`}
              >
                Details
                <ChevronDown
                  aria-hidden="true"
                  className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180"
                />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        {privilegedContainer && (
          <div className="flex items-start gap-2">
            <Checkbox
              id={`docker-privileged-${item.id}`}
              checked={acceptPrivileged}
              disabled={disabled || !included}
              aria-invalid={acceptanceMissing}
              className={cn(acceptanceMissing && REQUIRED_CLASS)}
              onCheckedChange={(checked) => onPrivilegedAcceptanceChange(checked === true)}
            />
            <Label htmlFor={`docker-privileged-${item.id}`} className="font-normal">
              Run privileged: root access on the VM. If the container does not need it, remove it
              before you connect.
            </Label>
          </div>
        )}
        {vmData && (
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(choiceMissing && 'font-medium text-status-warn')}>
              Data: {DATA_STATE_LABELS[vmData]}.
            </span>
            <Select
              value={dataChoice ?? item.dataAction ?? ''}
              disabled={disabled || !included}
              onValueChange={(value) => onDataChoiceChange(value as DockerDataChoice)}
            >
              <SelectTrigger
                aria-label={`Data choice for ${item.name}`}
                aria-invalid={choiceMissing}
                className={cn(CONTROL_CLASS, choiceMissing && REQUIRED_CLASS)}
              >
                <SelectValue placeholder="Choose what to keep" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep-vm">Keep VM copy</SelectItem>
                <SelectItem value="replace-home">Replace with this PC&apos;s data</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {blockers.length > 0 && (
          <ul className="list-disc pl-5 text-destructive">
            {blockers.map((blocker, index) => (
              <li key={`${blocker.code}:${index}`}>{blocker.message}</li>
            ))}
          </ul>
        )}
        {item.warnings.length > 0 && (
          <ul className="list-disc pl-5 text-status-warn">
            {item.warnings.map((warning, index) => (
              <li key={`${warning.code}:${index}`}>{warning.message}</li>
            ))}
          </ul>
        )}
        {alsoStops.length > 0 && (
          <p className="text-muted-foreground">Connect also stops: {alsoStops.join(', ')}.</p>
        )}
        <CollapsibleContent className="space-y-1 border-t pt-2 text-muted-foreground">
          {item.dataState === 'no-record' && <p>Data: {DATA_STATE_LABELS[item.dataState]}.</p>}
          {item.linkedReasons.length > 0 && (
            <p>Linked by {item.linkedReasons.map(linkedReasonLabel).join(', ')}.</p>
          )}
          <ul className="list-disc pl-5">
            {item.mounts.map((mount, index) => (
              <li key={`${mount.source}:${mount.destination}:${index}`}>
                {MOUNT_KIND_LABELS[mount.kind]} {mount.source} → {mount.destination}
                {mount.readOnly ? ' (read-only)' : ''}
                {mount.kind !== 'project-code' && `, ${sizeLabel(mount.size)}`}
              </li>
            ))}
            {item.images.map((image, index) => (
              <li key={`${image.id}:${index}`}>
                image {image.id} ({image.architecture}),{' '}
                {image.notCopied ? 'not copied' : sizeLabel(image.size)}
              </li>
            ))}
            <li>Writable layer: {sizeLabel(item.writableLayer)}.</li>
          </ul>
          {item.notes.length > 0 && (
            <ul className="list-disc pl-5">
              {item.notes.map((note, index) => (
                <li key={`${note}:${index}`}>{note}</li>
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
