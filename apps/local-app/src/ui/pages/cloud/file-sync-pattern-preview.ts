import { useEffect, useState } from 'react';
import type { ProjectPatternPreview } from '@/modules/remotes/sync/remote-file-sync.dto';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

type PreviewState =
  | { pattern: string; kind: 'loading' }
  | { pattern: string; kind: 'result'; result: ProjectPatternPreview }
  | { pattern: string; kind: 'error'; message: string };

export function useFileSyncPatternPreview(
  projectId: string,
  pattern: string | null,
): PreviewState | null {
  const api = useRemoteVmApi();
  const [state, setState] = useState<PreviewState | null>(null);
  useEffect(() => {
    if (!pattern) return;
    const controller = new AbortController();
    let active = true;
    setState({ pattern, kind: 'loading' });
    const timer = setTimeout(() => {
      const preview = async () => {
        try {
          const result = await api.previewFileSyncPattern(projectId, pattern, controller.signal);
          if (active) setState({ pattern, kind: 'result', result });
        } catch (error) {
          if (active)
            setState({
              pattern,
              kind: 'error',
              message: getErrorMessage(error, 'Could not preview this pattern.'),
            });
        }
      };
      void preview();
    }, 400);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, projectId, pattern]);
  return pattern && state?.pattern === pattern ? state : null;
}
