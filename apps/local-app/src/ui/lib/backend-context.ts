import { createContext, useContext } from 'react';
import type { ApiFetch, BackendId } from '@/ui/lib/api-transport';

export interface ActiveRemote {
  id: string;
  name: string;
  online: boolean;
  /** The remote answers but refuses this PC's API key. */
  apiKeyRejected?: boolean;
  version: string | null;
  versionMatches: boolean;
}

export interface BackendContextValue {
  /** Backend of the selected project: `home` or a remote UUID. */
  activeBackend: BackendId;
  /** The active project's remote, or null while a local project is active. */
  activeRemote: ActiveRemote | null;
  bindings: ReadonlyMap<string, string>;
  /** True once the binding map, and for a remote project its remote, has loaded successfully. */
  ready: boolean;
  /** Set while not ready and the blocking query has failed; retryable. */
  bindingsError: Error | null;
  /** Re-issues the blocking query/queries behind `bindingsError`. */
  retry: () => void;
  apiFetch: ApiFetch;
  buildApiUrl: (backendId: BackendId, path: string) => string;
}

export const BackendContext = createContext<BackendContextValue | undefined>(undefined);

/** Backend context, or undefined outside a `BackendProvider` (requests then go home). */
export function useOptionalBackend(): BackendContextValue | undefined {
  return useContext(BackendContext);
}
