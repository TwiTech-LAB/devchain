import { useCallback, useMemo, useState } from 'react';
import { HOME_BACKEND, type BackendId } from '@/ui/lib/api-transport';
import {
  persistCloudTarget,
  readPersistedCloudTarget,
  type PersistedCloudTarget,
} from '@/ui/lib/cloud-target';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { useRemotes } from './useRemotes';

export interface CloudTarget {
  /** The backend cloud sign-in, status, QR pairing and devices apply to. */
  backend: BackendId;
  /** The remote's name at home, or null for This PC. */
  remoteName: string | null;
  /** Online, version-matching remotes — the only ones the selector offers. */
  eligible: RemoteListItemDto[];
  /** Hidden entirely when no usable remote exists, leaving This PC implicit. */
  selectorVisible: boolean;
  selectTarget: (backend: BackendId) => void;
}

/**
 * The Cloud page's target selector state. The persisted choice is only honored
 * while the remote is usable; an offline or version-mismatched remote falls
 * back to This PC until it returns (the proxy would 503/409 its requests).
 */
export function useCloudTarget(): CloudTarget {
  const { remotes } = useRemotes();
  const [persisted, setPersisted] = useState<PersistedCloudTarget>(readPersistedCloudTarget);

  const eligible = useMemo(
    () =>
      remotes.filter((remote) => remote.online && !remote.apiKeyRejected && remote.versionMatches),
    [remotes],
  );

  const selected = eligible.find((remote) => remote.id === persisted.backend);
  const backend = selected ? selected.id : HOME_BACKEND;
  const remoteName = selected ? selected.name : null;

  const selectTarget = useCallback(
    (next: BackendId) => {
      const remote = next === HOME_BACKEND ? undefined : eligible.find((r) => r.id === next);
      const target: PersistedCloudTarget = remote
        ? { backend: remote.id, remoteName: remote.name }
        : { backend: HOME_BACKEND, remoteName: null };
      persistCloudTarget(target);
      setPersisted(target);
    },
    [eligible],
  );

  return {
    backend,
    remoteName,
    eligible,
    selectorVisible: eligible.length > 0,
    selectTarget,
  };
}
