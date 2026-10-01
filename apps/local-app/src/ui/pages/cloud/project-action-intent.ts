import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { openActivityInParams } from './ActivityDialog';
import type { ProjectListRow } from './ProjectList';

/** The project whose next step the page opens, e.g. from the dock's VM menu. */
const PROJECT_ACTION_PARAM = 'projectAction';
/** The VM that Connect opens on; used only with `projectAction`. */
const CONNECT_VM_PARAM = 'connectVm';

/** The Cloud → Remote VMs link that runs the project's next step; `remoteId` names the VM for Connect. */
export function projectActionHref(projectId: string, remoteId?: string): string {
  const params = new URLSearchParams({ section: 'remote-vm', [PROJECT_ACTION_PARAM]: projectId });
  if (remoteId) params.set(CONNECT_VM_PARAM, remoteId);
  return `/cloud?${params.toString()}`;
}

/**
 * Runs a one-shot `?projectAction=<projectId>[&connectVm=<remoteId>]` intent:
 * opens Connect, Disconnect or the project's Activity, as the project's row
 * would, and removes both keys in the same URL write. It waits for `loaded`,
 * because the next step comes from the full project status. An unknown
 * project, or one with no next step, only removes the keys.
 */
export function useProjectActionIntent({
  loaded,
  rows,
  onConnect,
  onDisconnect,
  onOpenActivity,
}: {
  /** Remotes, bindings, projects and operations have all loaded. */
  loaded: boolean;
  /** Every project row, unfiltered. */
  rows: readonly ProjectListRow[];
  onConnect: (target: { projectId: string; remoteId?: string }) => void;
  onDisconnect: (target: { id: string; name: string }) => void;
  /** Called as the intent opens Activity; the URL write itself opens it. */
  onOpenActivity: () => void;
}): void {
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL write lands a render later; this stops a second run on the same intent.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const projectId = searchParams.get(PROJECT_ACTION_PARAM);
    const remoteId = searchParams.get(CONNECT_VM_PARAM);
    if (projectId === null && remoteId === null) {
      handled.current = null;
      return;
    }
    const intent = searchParams.toString();
    if (!loaded || handled.current === intent) return;
    handled.current = intent;

    // Activity lives in the URL too, so it joins this write: two writes in
    // one tick start from the same snapshot, and the second drops the first.
    const next = new URLSearchParams(searchParams);
    next.delete(PROJECT_ACTION_PARAM);
    next.delete(CONNECT_VM_PARAM);
    const row = projectId ? rows.find((candidate) => candidate.project.id === projectId) : null;
    const action = row?.status.action ?? null;
    if (row && action) {
      switch (action.kind) {
        case 'connect':
          onConnect({ projectId: row.project.id, ...(remoteId ? { remoteId } : {}) });
          break;
        case 'disconnect':
          onDisconnect({ id: row.project.id, name: row.project.name });
          break;
        case 'view':
        case 'resolve':
          onOpenActivity();
          openActivityInParams(next, action.operationId);
          break;
      }
    }
    setSearchParams(next, { replace: true });
  }, [loaded, searchParams, rows, setSearchParams, onConnect, onDisconnect, onOpenActivity]);
}
