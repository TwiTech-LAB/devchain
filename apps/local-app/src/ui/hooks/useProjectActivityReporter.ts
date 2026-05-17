import { useCallback, useMemo } from 'react';
import type { HTMLAttributes } from 'react';

export const PROJECT_ACTIVITY_TOUCH_THROTTLE_MS = 60_000;

type ProjectActivityHandlers = Pick<
  HTMLAttributes<HTMLElement>,
  'onFocusCapture' | 'onKeyDown' | 'onPointerDown'
>;

interface TouchProjectActivityOptions {
  documentRef?: Document;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const lastTouchedByProjectId = new Map<string, number>();

export function resetProjectActivityTouchThrottleForTests(): void {
  lastTouchedByProjectId.clear();
}

export function isProjectActivityDocumentActive(documentRef: Document | undefined): boolean {
  if (!documentRef) return false;
  if (documentRef.visibilityState !== 'visible') return false;
  return typeof documentRef.hasFocus === 'function' ? documentRef.hasFocus() : true;
}

export async function touchProjectActivity(
  projectId: string | null | undefined,
  options: TouchProjectActivityOptions = {},
): Promise<boolean> {
  const normalizedProjectId = projectId?.trim();
  const documentRef =
    options.documentRef ?? (typeof document === 'undefined' ? undefined : document);
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'undefined' ? undefined : fetch);

  if (!normalizedProjectId || !fetchImpl || !isProjectActivityDocumentActive(documentRef)) {
    return false;
  }

  const now = options.now?.() ?? Date.now();
  const lastTouchedAt = lastTouchedByProjectId.get(normalizedProjectId);
  if (lastTouchedAt !== undefined && now - lastTouchedAt < PROJECT_ACTIVITY_TOUCH_THROTTLE_MS) {
    return false;
  }

  lastTouchedByProjectId.set(normalizedProjectId, now);

  try {
    const res = await fetchImpl(
      `/api/cloud/activity/projects/${encodeURIComponent(normalizedProjectId)}/touch`,
      { method: 'POST' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function useProjectActivityReporter(projectId: string | null | undefined): {
  projectActivityHandlers: ProjectActivityHandlers;
  reportProjectActivity: () => void;
} {
  const reportProjectActivity = useCallback(() => {
    void touchProjectActivity(projectId);
  }, [projectId]);

  const projectActivityHandlers = useMemo<ProjectActivityHandlers>(
    () => ({
      onFocusCapture: reportProjectActivity,
      onKeyDown: reportProjectActivity,
      onPointerDown: reportProjectActivity,
    }),
    [reportProjectActivity],
  );

  return { projectActivityHandlers, reportProjectActivity };
}
