import { useCallback } from 'react';
import {
  HOME_BACKEND,
  apiFetch as explicitApiFetch,
  type BackendId,
  type FetchFn,
} from '@/ui/lib/api-transport';
import { useOptionalBackend } from '@/ui/lib/backend-context';

function homeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return explicitApiFetch(input, init, { backend: HOME_BACKEND });
}

/**
 * Returns the fetch bound to the backend context this component mounted under:
 * callers pass root-absolute paths such as `/api/...` and the request goes to
 * home or to the remote that owns the project. A callback created from it keeps
 * its backend after the active project changes. Outside a `BackendProvider`
 * every request goes home. Safe to use directly as a React Query queryFn or
 * effect dependency.
 */
export function useFetchFactory(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  const apiFetch = useOptionalBackend()?.apiFetch ?? homeFetch;
  return useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => apiFetch(input, init),
    [apiFetch],
  );
}

/**
 * The backend that `useFetchFactory()` sends a request without a project id to: the active
 * project's. Use it in a query key next to that fetch.
 */
export function useAmbientBackend(): BackendId {
  return useOptionalBackend()?.activeBackend ?? HOME_BACKEND;
}

/** A fetch that sends every request to `backend`, whatever project is active. */
export function useBackendFetch(backend: BackendId): FetchFn {
  return useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => explicitApiFetch(input, init, { backend }),
    [backend],
  );
}

/**
 * Home transport for instance-level reads and writes (global skill settings):
 * every call names the home backend explicitly, so the request stays home no
 * matter which project is active. Usable as a React Query dependency.
 */
export function useHomeFetch(): FetchFn {
  return homeFetch;
}
