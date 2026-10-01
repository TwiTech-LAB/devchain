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
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { formatBytes, formatDuration } from './file-sync-display';

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
  /** At least one plan answer was applied for this remote. */
  loaded: boolean;
}

const MODE_LABELS: Record<DockerSelectionMode, string> = {
  'container-and-data': 'Container and data',
  'without-data': 'Copy without its data',
  'data-only': 'Copy its data only',
};

const MOUNT_KIND_LABELS: Record<DockerPlanMount['kind'], string> = {
  'named-volume': 'named volume',
  'anonymous-volume': 'anonymous volume',
  'project-bind': 'in-project folder',
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

function linkedReasonLabel(reason: string): string {
  if (reason === 'compose-file-at-project-root') return 'compose file at the project root';
  if (reason.startsWith('bind:')) return `bind at ${reason.slice('bind:'.length)}`;
  return `Compose label ${reason}`;
}

/** "2–8 minutes (approximate)"; seconds for short ranges. */
export function formatCopyRange(minSeconds: number, maxSeconds: number): string {
  return `${formatDuration(minSeconds)}–${formatDuration(maxSeconds)} (approximate)`;
}

function isPlan(value: unknown): value is DockerPlan {
  const plan = value as Partial<DockerPlan> | null;
  return (
    typeof plan?.canConnect === 'boolean' &&
    typeof plan?.fit === 'string' &&
    Array.isArray(plan?.items) &&
    typeof plan?.availability === 'object' &&
    plan?.availability !== null
  );
}

async function fetchPlan(projectId: string, payload: string, signal: AbortSignal) {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/docker/plan`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal,
    },
    { backend: HOME_BACKEND },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (body as { message?: string } | null)?.message ??
        `The Docker plan failed (${response.status})`,
    );
  }
  if (!isPlan(body)) throw new Error('The server returned an invalid Docker plan.');
  return body;
}

/**
 * The Docker part of the Connect dialog: reads the import plan for the chosen
 * remote, lets the user pick items and modes, and reports the selection with
 * the plan's verdict. Only the latest plan request is ever applied, and while
 * one is pending the dialog does not act on the previous answer. A plan that
 * cannot be read never blocks a Connect without Docker items — the section
 * degrades to a note.
 */
export function ConnectDockerSection({
  projectId,
  remoteId,
  disabled,
  onStateChange,
}: {
  projectId: string;
  remoteId: string;
  disabled: boolean;
  onStateChange: (state: DockerSectionState) => void;
}) {
  const [plan, setPlan] = useState<DockerPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [modes, setModes] = useState<Record<string, DockerSelectionMode>>({});
  const [dataChoices, setDataChoices] = useState<Record<string, DockerDataChoice>>({});
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const plannedRef = useRef<string | null>(null);
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
        const body = await fetchPlan(projectId, JSON.stringify({ remoteId }), signal);
        if (signal.aborted) return;
        setPlan(body);
        setIncluded(
          Object.fromEntries(
            body.items.map((item) => [item.id, item.defaultSelected && item.choices.length > 0]),
          ),
        );
        setModes(
          Object.fromEntries(
            body.items
              .filter((item) => item.selectedMode !== null && item.choices.length > 0)
              .map((item) => [item.id, item.selectedMode as DockerSelectionMode]),
          ),
        );
        setLoaded(true);
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
  }, [projectId, remoteId]);

  const requestPlan = async (items: DockerSelectionItem[]) => {
    const payload = JSON.stringify({ remoteId, items });
    if (plannedRef.current === payload) return;
    plannedRef.current = payload;
    setError(null);
    const signal = nextRequest();
    setPending(true);
    try {
      const body = await fetchPlan(projectId, payload, signal);
      if (signal.aborted) return;
      setPlan(body);
      setLoaded(true);
    } catch (cause) {
      if (signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal.aborted) setPending(false);
    }
  };

  /** The included items with their mode: the chosen one, else the first choice. */
  const selectionFor = (
    include: Record<string, boolean>,
    chosen: Record<string, DockerSelectionMode>,
    data: Record<string, DockerDataChoice> = dataChoices,
  ): DockerSelectionItem[] =>
    (plan?.items ?? []).flatMap((item) => {
      const mode = chosen[item.id] ?? item.choices[0];
      return include[item.id] && mode !== undefined
        ? [{ id: item.id, mode, ...(data[item.id] && { dataChoice: data[item.id] }) }]
        : [];
    });

  const selection = selectionFor(included, modes);

  useEffect(() => {
    onStateChange({
      ready: plan !== null && plan.availability.available,
      items: selection,
      canConnect: !error && (plan?.canConnect ?? false),
      pending,
      loaded,
    });
  }, [plan, included, modes, dataChoices, pending, loaded, error, onStateChange]);

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

  if (error) {
    return (
      <p role="note" className="text-sm text-muted-foreground">
        Docker import is unavailable: {error}
      </p>
    );
  }
  if (!plan) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Reading Docker containers…
      </p>
    );
  }
  const { availability } = plan;
  if (!availability.available) {
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

  return (
    <section aria-label="Docker containers" className="space-y-2 text-sm">
      <h3>Docker containers</h3>
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
          {linked.map((item) => {
            // An item without choices cannot be selected; the server would
            // refuse every mode for it, so it only ever shows its reasons.
            const selectable = item.choices.length > 0;
            // The server computes the list with the handoff's own stop rule.
            const alsoStops = included[item.id] === true ? item.alsoStops.map(nameOf) : [];
            return (
              <li key={item.id} className="space-y-1 rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    id={`docker-item-${item.id}`}
                    checked={included[item.id] ?? false}
                    disabled={disabled || !selectable}
                    onCheckedChange={(checked) => toggle(item, checked === true)}
                  />
                  <Label htmlFor={`docker-item-${item.id}`} className="font-normal">
                    {item.name}
                  </Label>
                  <span className="text-muted-foreground">
                    {item.kind === 'compose-project' ? 'Compose project' : 'Container'}
                  </span>
                  {item.temporary && <span className="text-muted-foreground">temporary</span>}
                  {item.targetAction !== 'create' && (
                    <span className="text-muted-foreground">
                      {TARGET_ACTION_LABELS[item.targetAction]}
                    </span>
                  )}
                </div>
                {item.dataState && <p>Data: {DATA_STATE_LABELS[item.dataState]}.</p>}
                {item.dataChoiceRequired && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Shared data choice for {item.name}</span>
                    <Select
                      value={dataChoices[item.id]}
                      disabled={disabled || !included[item.id]}
                      onValueChange={(value) => changeDataChoice(item, value as DockerDataChoice)}
                    >
                      <SelectTrigger
                        aria-label={`Shared data choice for ${item.name}`}
                        className="h-8 w-auto min-w-[12rem]"
                      >
                        <SelectValue placeholder="Choose what to keep" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="keep-vm">Keep VM copy</SelectItem>
                        <SelectItem value="replace-home">
                          Replace with this PC&apos;s data
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {item.linkedReasons.length > 0 && (
                  <p className="text-muted-foreground">
                    Linked by {item.linkedReasons.map(linkedReasonLabel).join(', ')}.
                  </p>
                )}
                <ul className="list-disc pl-5 text-muted-foreground">
                  {item.mounts.map((mount, index) => (
                    <li key={`${mount.source}:${mount.destination}:${index}`}>
                      {MOUNT_KIND_LABELS[mount.kind]} {mount.source} → {mount.destination}
                      {mount.readOnly ? ' (read-only)' : ''}, {sizeLabel(mount.size)}
                    </li>
                  ))}
                  {item.images.map((image, index) => (
                    <li key={`${image.id}:${index}`}>
                      image {image.id} ({image.architecture}), {sizeLabel(image.size)}
                    </li>
                  ))}
                  <li>Writable layer: {sizeLabel(item.writableLayer)}.</li>
                </ul>
                {alsoStops.length > 0 && (
                  <p className="text-muted-foreground">
                    Connect also stops: {alsoStops.join(', ')}.
                  </p>
                )}
                {item.blockers.length > 0 && (
                  <ul className="list-disc pl-5 text-destructive">
                    {item.blockers.map((blocker, index) => (
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
                {item.notes.length > 0 && (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {item.notes.map((note, index) => (
                      <li key={`${note}:${index}`}>{note}</li>
                    ))}
                  </ul>
                )}
                {item.choices.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Mode</span>
                    <Select
                      value={modes[item.id] ?? item.choices[0]}
                      disabled={disabled || !included[item.id]}
                      onValueChange={(value) => changeMode(item, value as DockerSelectionMode)}
                    >
                      <SelectTrigger
                        aria-label={`Mode for ${item.name}`}
                        className="h-8 w-auto min-w-[12rem]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {item.choices.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {MODE_LABELS[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  item.choices[0] !== undefined &&
                  item.choices[0] !== 'container-and-data' && (
                    <p className="text-muted-foreground">Mode: {MODE_LABELS[item.choices[0]]}</p>
                  )
                )}
              </li>
            );
          })}
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
      {pending && (
        <p role="status" className="text-muted-foreground">
          Updating the plan…
        </p>
      )}
    </section>
  );
}
