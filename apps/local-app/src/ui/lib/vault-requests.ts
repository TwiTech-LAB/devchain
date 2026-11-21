// The REST contract types are the server's own (docs/ui-kit-guide.md Part 1, item 1).
import type {
  VaultRequestApproveResult,
  VaultRequestCandidate,
  VaultRequestFulfillInput,
  VaultRequestFulfillResult,
  VaultRequestView,
} from '@/modules/vault-requests/vault-request-fulfill.service';
import type { VaultUseDecision } from '@/modules/vault-requests/vault-use-decision';
import { HOME_BACKEND, apiFetch } from './api-transport';
import { fetchJsonOrThrow, fetchOrThrow } from './http-json';

export type { VaultRequestCandidate, VaultRequestView, VaultUseDecision };

/** Agent requests always live on home, whichever project page is open. */
const homeFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  apiFetch(input, init, { backend: HOME_BACKEND });

export const vaultRequestsQueryKey = ['vault', 'requests'] as const;

/** Under `vaultRequestsQueryKey`, so a refresh of the request list also reloads it. */
export const vaultRequestCandidatesQueryKey = (requestId: string) =>
  [...vaultRequestsQueryKey, requestId, 'candidates'] as const;

/** Socket frame types of the request events (topic `project/<id>/vault-requests`). */
export const VAULT_REQUEST_FRAME_TYPES: ReadonlySet<string> = new Set([
  'vault_request.pending',
  'vault_request.resolved',
]);

function requestPath(
  requestId: string,
  action: 'fulfill' | 'approve' | 'deny' | 'candidates',
): string {
  return `/api/vault/requests/${encodeURIComponent(requestId)}/${action}`;
}

export function fetchVaultRequests(): Promise<VaultRequestView[]> {
  return fetchJsonOrThrow<VaultRequestView[]>(
    '/api/vault/requests',
    {},
    'Vault requests could not be loaded',
    homeFetch,
  );
}

/** The existing entries that can answer a `create` request; empty for other types. */
export function fetchVaultRequestCandidates(requestId: string): Promise<VaultRequestCandidate[]> {
  return fetchJsonOrThrow<VaultRequestCandidate[]>(
    requestPath(requestId, 'candidates'),
    {},
    'The existing entries could not be loaded',
    homeFetch,
  );
}

/**
 * `value` or `entryId` only for a `create` request; `permanent: false` keeps a value for
 * the session only, and `entryId` takes `permanent: true` only.
 */
export function fulfillVaultRequest(
  requestId: string,
  body: VaultRequestFulfillInput,
): Promise<VaultRequestFulfillResult> {
  return fetchJsonOrThrow<VaultRequestFulfillResult>(
    requestPath(requestId, 'fulfill'),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    'The request could not be fulfilled',
    homeFetch,
  );
}

/** Answers a `use` request; deny it with `denyVaultRequest`. */
export function approveVaultRequest(
  requestId: string,
  decision: VaultUseDecision,
): Promise<VaultRequestApproveResult> {
  return fetchJsonOrThrow<VaultRequestApproveResult>(
    requestPath(requestId, 'approve'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
    'The request could not be approved',
    homeFetch,
  );
}

export function denyVaultRequest(requestId: string, reason?: string): Promise<void> {
  return fetchOrThrow(
    requestPath(requestId, 'deny'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
    'The request could not be denied',
    homeFetch,
  );
}
