import { HOME_BACKEND, apiFetch, type BackendId } from './api-transport';

/**
 * The Cloud page's sign-in target: this PC (`home`) or one registered remote.
 * Persisted in localStorage (not state) because the OAuth popup and this page
 * are different windows that must agree on where the callback hands its tokens.
 */
export const CLOUD_TARGET_STORAGE_KEY = 'devchain.cloud.target';
export const CLOUD_TARGET_CHANGED_EVENT = 'devchain:cloud-target:changed';

export interface PersistedCloudTarget {
  backend: BackendId;
  /** The remote's name at home; null for `home`. Refreshed on every selection. */
  remoteName: string | null;
}

export function readPersistedCloudTarget(): PersistedCloudTarget {
  try {
    const raw = window.localStorage.getItem(CLOUD_TARGET_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedCloudTarget>;
      if (typeof parsed.backend === 'string' && parsed.backend) {
        if (parsed.backend === HOME_BACKEND) return { backend: HOME_BACKEND, remoteName: null };
        const remoteName = typeof parsed.remoteName === 'string' ? parsed.remoteName : null;
        return { backend: parsed.backend, remoteName };
      }
    }
  } catch {
    // Unreadable or stale storage falls back to home.
  }
  return { backend: HOME_BACKEND, remoteName: null };
}

export function persistCloudTarget(target: PersistedCloudTarget): void {
  try {
    window.localStorage.setItem(CLOUD_TARGET_STORAGE_KEY, JSON.stringify(target));
  } catch {
    // Storage may be unavailable; the in-memory selection still applies this session.
  }
  // Account may already be mounted when a notice selects this PC.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CLOUD_TARGET_CHANGED_EVENT, { detail: target }));
  }
}

/**
 * Opens the GitHub sign-in popup for the target the page shows. The callback
 * window reads only the persisted target, and the page may show This PC as the
 * fallback for an unusable persisted remote, so the shown target is written first.
 */
export function openCloudOAuthPopup(
  identityServiceUrl: string,
  target: PersistedCloudTarget,
): void {
  persistCloudTarget(target);
  const redirectUri = window.location.origin + '/auth/cloud/callback';
  const url = `${identityServiceUrl}/auth/github?response_mode=fragment_full&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.open(url, 'devchain-cloud-auth', 'width=600,height=700');
}

/**
 * Looks up the current name home gives the remote, preferring it over the
 * (possibly stale) persisted copy. Returns null when the lookup fails.
 */
export async function fetchRemoteName(
  remoteId: string,
  fallback: string | null,
): Promise<string | null> {
  try {
    const res = await apiFetch('/api/remotes', undefined, { backend: HOME_BACKEND });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { items?: Array<{ id: string; name: string }> };
    return body.items?.find((remote) => remote.id === remoteId)?.name ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Completes a cloud sign-in against the chosen backend. A remote target gets
 * its instance label pushed FIRST: the host opens its bridge tunnel when the
 * tokens land, and the label must already be stored for that first attestation
 * to carry the name home gave the remote. The label push is best-effort — it
 * never blocks or fails the token hand-off.
 */
export async function completeCloudSignIn(input: {
  backend: BackendId;
  remoteName: string | null;
  accessToken: string;
  refreshToken: string;
}): Promise<Response> {
  if (input.backend !== HOME_BACKEND && input.remoteName) {
    try {
      await apiFetch(
        '/api/cloud/instance-label',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: input.remoteName }),
        },
        { backend: input.backend },
      );
    } catch {
      // The label is cosmetic; sign-in proceeds and a later rename re-sends it.
    }
  }
  return apiFetch(
    '/api/auth/cloud/tokens',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: input.accessToken, refreshToken: input.refreshToken }),
    },
    { backend: input.backend },
  );
}
