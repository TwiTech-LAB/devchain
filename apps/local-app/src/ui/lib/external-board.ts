import type { IntegrationProvider } from '@/ui/hooks/useIntegrationConnections';
import {
  normalizeExternalProviderSourceUrl,
  normalizeExternalTaskSourceUrl,
  normalizeExternalWorkAreaSourceUrl,
} from '@/modules/external-integrations/models/external-task-source';
import { INTEGRATION_PROVIDER_IDS } from '@/ui/lib/integration-connections';

export type ExternalBoardProvider = IntegrationProvider;

export const EXTERNAL_BOARD_PROVIDERS: readonly ExternalBoardProvider[] = INTEGRATION_PROVIDER_IDS;

/**
 * Completed-work scope for external board routes. Lives only on `/board/:provider...`
 * URLs and is never consumed by the native `/board` filter serializer.
 */
export const EXTERNAL_COMPLETED_QUERY_PARAM = 'completed';

export function isExternalBoardProvider(value: string): value is ExternalBoardProvider {
  return (EXTERNAL_BOARD_PROVIDERS as readonly string[]).includes(value);
}

export function externalBoardProviderLabel(provider: ExternalBoardProvider): string {
  return provider === 'clickup' ? 'ClickUp' : 'Jira';
}

/**
 * One presentation rule for an actionable status destination. Jira transitions
 * can carry their own label; show it beside the destination so both the detail
 * selector and the drag-choice dialog name a transition identically.
 */
export function externalTaskStatusOptionLabel(option: {
  actionLabel?: string;
  name: string;
}): string {
  return option.actionLabel !== undefined && option.actionLabel !== option.name
    ? `${option.actionLabel} (${option.name})`
    : option.name;
}

export function externalBoardMyWorkPath(provider: ExternalBoardProvider): string {
  return `/board/${provider}`;
}

/**
 * Render-safe external task URL. Delegates to the shared provider-origin allowlist
 * (`modules/external-integrations/models/external-task-source.ts`) so server and
 * browser enforce one URL policy; vendor strings never become arbitrary link targets.
 */
export function safeExternalTaskUrl(
  provider: ExternalBoardProvider,
  value: string | null | undefined,
): string | null {
  return normalizeExternalTaskSourceUrl(provider, value);
}

export function externalWorkAreaSourceUrl(
  provider: ExternalBoardProvider,
  workArea: { remoteId: string; scopeKey: string },
): string | null {
  if (provider === 'jira' && workArea.remoteId === 'other-assigned') {
    return null;
  }
  const candidate =
    provider === 'clickup'
      ? `https://app.clickup.com/${encodeURIComponent(workArea.scopeKey)}/v/li/${encodeURIComponent(workArea.remoteId)}`
      : `https://${workArea.scopeKey}/secure/RapidBoard.jspa?rapidView=${encodeURIComponent(workArea.remoteId)}`;
  return normalizeExternalWorkAreaSourceUrl(provider, candidate);
}

export function externalProviderSourceUrl(
  provider: ExternalBoardProvider,
  scopeKey?: string,
): string | null {
  const candidate =
    provider === 'clickup' ? 'https://app.clickup.com' : scopeKey ? `https://${scopeKey}` : null;
  return normalizeExternalProviderSourceUrl(provider, candidate);
}

/** True only when the URL explicitly requests completed-inclusive work. */
export function readExternalCompletedParam(params: URLSearchParams): boolean {
  return params.get(EXTERNAL_COMPLETED_QUERY_PARAM) === '1';
}

function withCompletedParam(path: string, includeCompleted: boolean): string {
  return includeCompleted ? `${path}?${EXTERNAL_COMPLETED_QUERY_PARAM}=1` : path;
}

export function buildExternalBoardMyWorkPath(
  provider: ExternalBoardProvider,
  includeCompleted: boolean,
): string {
  return withCompletedParam(externalBoardMyWorkPath(provider), includeCompleted);
}

export function buildExternalWorkAreaPath(
  provider: ExternalBoardProvider,
  workAreaId: string,
  includeCompleted: boolean,
): string {
  return withCompletedParam(
    `/board/${provider}/${encodeURIComponent(workAreaId)}`,
    includeCompleted,
  );
}

/**
 * Path of the DevChain linked-task workspace under a provider tab. The Epic ID
 * is the durable identifier; the workspace resolves the current remote task
 * for it at render time.
 */
export function externalLinkedTaskPath(provider: ExternalBoardProvider, epicId: string): string {
  return `/board/${provider}/linked/${encodeURIComponent(epicId)}`;
}

/**
 * True only for the exact four-segment shape `/board/:provider/linked/:epicId`.
 * Defined by segment shape, never by substring: a work area named "linked"
 * must not turn its three-segment route into a linked-workspace route.
 */
export function isExternalLinkedTaskPath(pathname: string): boolean {
  const segments = pathname.split('/');
  return (
    segments.length === 5 &&
    segments[0] === '' &&
    segments[1] === 'board' &&
    segments[2] !== '' &&
    segments[3] === 'linked' &&
    segments[4] !== ''
  );
}

/**
 * Location state the native Board attaches when opening the linked workspace;
 * the workspace validates `boardReturnUrl` before closing back to it.
 */
export interface ExternalLinkedTaskState {
  boardReturnUrl: string;
}

export function externalLinkedTaskState(boardReturnUrl: string): ExternalLinkedTaskState {
  return { boardReturnUrl };
}

/**
 * Nullable Board-return validator: returns the exact native `/board` return
 * URL carried in history state, or null when state carries none. Anything
 * else — absolute or protocol-relative URLs, hosts, hashes, `/board`
 * subpaths, malformed values, non-strings — is rejected, so history state
 * can never steer navigation off-app or into a provider route. Callers that
 * must distinguish "validated return target" from "no return target" use
 * this; `parseBoardReturnUrl` stays the `/board`-fallback wrapper.
 */
export function boardReturnUrlFromState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const candidate = (state as { boardReturnUrl?: unknown }).boardReturnUrl;
  return typeof candidate === 'string' && /^\/board(?:\?[^#]+)?$/.test(candidate)
    ? candidate
    : null;
}

export function parseBoardReturnUrl(state: unknown): string {
  return boardReturnUrlFromState(state) ?? '/board';
}

/**
 * True only when this tab has an in-app history entry to return to: the
 * production router tracks its stack index in `window.history.state.idx`,
 * and a missing, null, zero, or malformed index means the current entry is
 * the first in-app entry — the direct or reloaded deep-link case — so
 * closing must fall back to `/board` instead of leaving the app.
 */
export function hasInAppHistoryBack(): boolean {
  const idx = window.history.state?.idx;
  return Number.isInteger(idx) && idx > 0;
}
