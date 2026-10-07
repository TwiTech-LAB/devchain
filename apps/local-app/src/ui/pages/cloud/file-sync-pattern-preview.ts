import { useEffect, useState } from 'react';
import type { ProjectPatternPreview } from '@/modules/remotes/sync/remote-file-sync.dto';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { apiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

type PreviewState =
  | { pattern: string; kind: 'loading' }
  | { pattern: string; kind: 'result'; result: ProjectPatternPreview }
  | { pattern: string; kind: 'error'; message: string };

export function useFileSyncPatternPreview(
  projectId: string,
  pattern: string | null,
): PreviewState | null {
  const [state, setState] = useState<PreviewState | null>(null);
  useEffect(() => {
    if (!pattern) return;
    const controller = new AbortController();
    let active = true;
    setState({ pattern, kind: 'loading' });
    const timer = setTimeout(() => {
      const preview = async () => {
        try {
          const response = await apiFetch(
            `/api/projects/${encodeURIComponent(projectId)}/file-sync/pattern-preview`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pattern }),
              signal: controller.signal,
            },
            { backend: HOME_BACKEND },
          );
          if (!response.ok)
            throw new Error(await readErrorMessage(response, 'Could not preview this pattern.'));
          const result = (await response.json()) as ProjectPatternPreview;
          if (!result.home || !result.vm)
            throw new Error('The server returned no pattern preview.');
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
  }, [projectId, pattern]);
  return pattern && state?.pattern === pattern ? state : null;
}
