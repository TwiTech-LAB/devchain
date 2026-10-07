import { useEffect, useState } from 'react';
import type { ProjectExclusionSuggestions } from '@/modules/file-sync/sync-path-inspection.dto';
import { apiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';

export function useFileSyncSuggestions(
  projectId: string,
  remoteId: string,
  onPending: (pending: boolean) => void,
  refreshKey: number,
) {
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
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId)}/file-sync/suggestions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remoteId }),
            signal: controller.signal,
          },
          { backend: HOME_BACKEND },
        );
        if (!response.ok) throw new Error('Scan failed');
        const body = (await response.json()) as ProjectExclusionSuggestions;
        if (!Array.isArray(body.groups)) throw new Error('No suggestions');
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
  }, [projectId, remoteId, onPending, refreshKey]);

  return { result, failed, pending };
}
