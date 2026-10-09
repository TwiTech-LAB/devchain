import { useEffect, useState } from 'react';
import type { ProjectExclusionSuggestions } from '@/modules/file-sync/sync-path-inspection.dto';
import { useRemoteVmApi } from './lib/remote-vm-api-context';

export function useFileSyncSuggestions(
  projectId: string,
  remoteId: string,
  onPending: (pending: boolean) => void,
  refreshKey: number,
) {
  const api = useRemoteVmApi();
  const [result, setResult] = useState<ProjectExclusionSuggestions | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    setFailed(false);
    setPending(true);
    onPending(true);
    const controller = new AbortController();
    let active = true;
    const finish = () => {
      setPending(false);
      onPending(false);
    };
    const timeout = setTimeout(() => {
      active = false;
      controller.abort();
      setFailed(true);
      finish();
    }, 15_000);
    const scan = async () => {
      try {
        const body = await api.readFileSyncSuggestions(projectId, remoteId, controller.signal);
        if (!active) return;
        clearTimeout(timeout);
        setResult({ ...body });
        finish();
      } catch {
        if (active) {
          clearTimeout(timeout);
          setFailed(true);
          finish();
        }
      }
    };
    void scan();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      onPending(false);
    };
  }, [api, projectId, remoteId, onPending, refreshKey]);

  return { result, failed, pending };
}
