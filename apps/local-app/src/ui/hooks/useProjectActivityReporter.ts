import { useEffect } from 'react';

export const PROJECT_ACTIVITY_TOUCH_THROTTLE_MS = 60_000;

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

export function useProjectActivityReporter(projectId: string | null | undefined): void {
  useEffect(() => {
    const reportProjectActivity = () => {
      void touchProjectActivity(projectId);
    };

    document.addEventListener('pointerdown', reportProjectActivity, { capture: true });
    document.addEventListener('keydown', reportProjectActivity, { capture: true });

    return () => {
      document.removeEventListener('pointerdown', reportProjectActivity, { capture: true });
      document.removeEventListener('keydown', reportProjectActivity, { capture: true });
    };
  }, [projectId]);
}
