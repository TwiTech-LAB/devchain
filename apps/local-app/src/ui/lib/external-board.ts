import type { IntegrationProvider } from '@/ui/hooks/useIntegrationConnections';
import { normalizeExternalTaskSourceUrl } from '@/modules/external-integrations/models/external-task-source';
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
 * The only accepted close target: the native `/board` entry, optionally with
 * a query. Anything else carried in history state — absolute or
 * protocol-relative URLs, hosts, hashes, `/board` subpaths, malformed values,
 * non-strings — falls back to `/board`, so state can never steer navigation
 * off-app or into a provider route.
 */
export function parseBoardReturnUrl(state: unknown): string {
  if (typeof state !== 'object' || state === null) return '/board';
  const candidate = (state as { boardReturnUrl?: unknown }).boardReturnUrl;
  return typeof candidate === 'string' && /^\/board(?:\?[^#]+)?$/.test(candidate)
    ? candidate
    : '/board';
}
