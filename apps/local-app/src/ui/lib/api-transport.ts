/**
 * The UI's single HTTP transport. Every API request picks a backend — `home`
 * (this DevChain) or a remote UUID reached through the home proxy at
 * `/r/<remoteId>/…` — and this module is the only place allowed to call
 * `fetch` (enforced by ESLint).
 *
 * Resolution order (`resolveBackend`):
 *   1. an explicit `backend` option;
 *   2. home-always routes (project catalogue and creation, remotes, cloud, …);
 *   3. a project id named in the call (path, `projectId` query or JSON body),
 *      looked up in the binding map;
 *   4. the active project's backend (entity-id-only and backend-global routes).
 *
 * There is no global resolution context. `BackendProvider` builds one bound
 * fetch per context (`createApiFetch`) and hands it down; a component keeps the
 * instance it mounted with, so its requests stay on that backend after a switch.
 * The module-level `apiFetch` knows no project and requires an explicit backend.
 */

export const HOME_BACKEND = 'home';

/** `home` or a remote UUID. */
export type BackendId = string;

/** An explicit backend: `home`, a remote UUID, or `project:<projectId>` (resolved via bindings). */
export type BackendSelector = BackendId | `project:${string}`;

export interface ApiFetchOptions {
  backend?: BackendSelector;
}

export interface BackendResolutionContext {
  /** projectId → remoteId for every project whose requests go to a remote. */
  bindings: ReadonlyMap<string, string>;
  activeProjectId?: string | null;
  /**
   * `unknown` until the binding map (and the active project's remote) has loaded:
   * every request that would consult the map or the active project is refused.
   */
  authority: 'known' | 'unknown';
}

/** Retryable: the request needs project routing, which is not loaded yet. */
export class RoutingUnknownError extends Error {
  constructor() {
    super('Project routing is not known yet');
    this.name = 'ROUTING_UNKNOWN';
  }
}

export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: ApiFetchOptions,
) => Promise<Response>;

/** A fetch already bound to a backend context, as `useFetchFactory` returns it. */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A fetch with no project context: every call names its backend. */
export type ExplicitApiFetch = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: { backend: BackendId },
) => Promise<Response>;

const PROJECT_SELECTOR_PREFIX = 'project:';
const REMOTE_PROXY_PREFIX = '/r/';

const HOME_ALWAYS_PREFIXES = [
  '/api/remotes',
  '/api/vm-providers',
  '/api/workspaces',
  '/api/projects',
  '/api/cloud',
  '/api/auth/cloud',
  '/api/e2ee',
  '/api/integrations',
  '/api/provider-auth',
  '/api/provider-clis',
  '/api/runtime',
  '/api/fs',
  '/api/templates',
  '/api/registry',
  '/api/preflight',
  '/api/agent-time-buffers',
  '/api/epics/import-external-task',
  '/api/epics/external-sources',
  '/api/epics/time-summary',
] as const;

// Epic time link boundaries live only at home, so time reads for any project go there.
const HOME_ALWAYS_EPIC_TIME_LOGS = /^\/api\/epics\/[^/]+\/time-logs(?:\/|$)/;
const HOME_ALWAYS_EPIC_TIME_READ = /^\/api\/epics\/[^/]+\/time(?:\/|$)/;

// Routes outside the home-always set that carry the target project id in the path.
const PROJECT_ID_IN_PATH = [/^\/api\/settings\/autoclean\/([^/]+)/];

export function extractPathname(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') {
    try {
      if (/^https?:\/\//.test(input)) {
        return new URL(input).pathname;
      }
      return input.split('?')[0].split('#')[0];
    } catch {
      return null;
    }
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.pathname;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      return new URL(input.url).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

function extractSearchParams(input: RequestInfo | URL): URLSearchParams | null {
  try {
    if (typeof input === 'string') {
      return new URL(input, 'http://localhost').searchParams;
    }
    if (typeof URL !== 'undefined' && input instanceof URL) {
      return input.searchParams;
    }
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return new URL(input.url, 'http://localhost').searchParams;
    }
  } catch {
    return null;
  }
  return null;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method =
    init?.method ??
    (typeof Request !== 'undefined' && input instanceof Request ? input.method : undefined);
  return (method ?? 'GET').toUpperCase();
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isApiPath(pathname: string): boolean {
  return matchesPrefix(pathname, '/api');
}

export function isHomeAlwaysRoute(pathname: string, method = 'GET'): boolean {
  if (HOME_ALWAYS_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return true;
  }
  if (HOME_ALWAYS_EPIC_TIME_LOGS.test(pathname)) {
    return true;
  }
  return method === 'GET' && HOME_ALWAYS_EPIC_TIME_READ.test(pathname);
}

function projectIdFromBody(body: RequestInit['body']): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const projectId = (parsed as { projectId?: unknown }).projectId;
      return typeof projectId === 'string' && projectId ? projectId : null;
    }
  } catch {
    // Non-JSON bodies carry no project id.
  }
  return null;
}

function namedProjectId(
  pathname: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): string | null {
  for (const pattern of PROJECT_ID_IN_PATH) {
    const match = pathname.match(pattern);
    if (match?.[1]) {
      return safeDecode(match[1]);
    }
  }
  const fromQuery = extractSearchParams(input)?.get('projectId');
  if (fromQuery) {
    return fromQuery;
  }
  return projectIdFromBody(init?.body);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function backendForProject(
  projectId: string | null | undefined,
  context: BackendResolutionContext,
): BackendId {
  if (context.authority === 'unknown') {
    throw new RoutingUnknownError();
  }
  return (projectId && context.bindings.get(projectId)) || HOME_BACKEND;
}

function resolveSelector(selector: BackendSelector, context: BackendResolutionContext): BackendId {
  if (selector.startsWith(PROJECT_SELECTOR_PREFIX)) {
    return backendForProject(selector.slice(PROJECT_SELECTOR_PREFIX.length), context);
  }
  return selector || HOME_BACKEND;
}

/**
 * Pure: picks the backend for one request. Non-API and already-proxied paths go home.
 * Throws `RoutingUnknownError` when steps 3–4 (or a `project:` selector) are reached
 * while the context's authority is `unknown`.
 */
export function resolveBackend(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ApiFetchOptions | undefined,
  context: BackendResolutionContext,
): BackendId {
  if (options?.backend) {
    return resolveSelector(options.backend, context);
  }

  const pathname = extractPathname(input);
  if (!pathname || !isApiPath(pathname)) {
    return HOME_BACKEND;
  }
  if (isHomeAlwaysRoute(pathname, requestMethod(input, init))) {
    return HOME_BACKEND;
  }

  const projectId = namedProjectId(pathname, input, init);
  if (projectId) {
    return backendForProject(projectId, context);
  }
  return backendForProject(context.activeProjectId, context);
}

/** Root-absolute URL of `path` on a backend, for links, downloads and `fetch`. */
export function buildApiUrl(backendId: BackendId, path: string): string {
  if (backendId === HOME_BACKEND || path.startsWith(REMOTE_PROXY_PREFIX)) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${REMOTE_PROXY_PREFIX}${encodeURIComponent(backendId)}${normalizedPath}`;
}

function rewriteInput(input: RequestInfo | URL, backendId: BackendId): RequestInfo | URL {
  if (backendId === HOME_BACKEND) {
    return input;
  }
  if (typeof input === 'string') {
    if (!/^https?:\/\//.test(input)) {
      return buildApiUrl(backendId, input);
    }
    const parsed = new URL(input);
    parsed.pathname = buildApiUrl(backendId, parsed.pathname);
    return parsed.toString();
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    const rewritten = new URL(input.toString());
    rewritten.pathname = buildApiUrl(backendId, rewritten.pathname);
    return rewritten;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const parsed = new URL(input.url);
    parsed.pathname = buildApiUrl(backendId, parsed.pathname);
    return new Request(parsed.toString(), input);
  }
  return input;
}

/**
 * Sends one request to the backend `resolveBackend` picks for it. A
 * `RoutingUnknownError` from resolution surfaces as a rejected promise.
 */
export function createApiFetch(getContext: () => BackendResolutionContext): ApiFetch {
  return async (input, init, options) => {
    const backendId = resolveBackend(input, init, options, getContext());
    return fetch(rewriteInput(input, backendId), init);
  };
}

const NO_PROJECT_CONTEXT: BackendResolutionContext = {
  bindings: new Map(),
  activeProjectId: null,
  authority: 'known',
};
const unboundFetch = createApiFetch(() => NO_PROJECT_CONTEXT);

/**
 * Explicit-backend fetch for home-always and instance-level callers. A
 * `project:<id>` selector throws: without the binding map it would silently go
 * home, so project-scoped calls must use the bound fetch from `BackendProvider`.
 */
export const apiFetch: ExplicitApiFetch = (input, init, options) => {
  if (options.backend.startsWith(PROJECT_SELECTOR_PREFIX)) {
    return Promise.reject(
      new Error(`apiFetch cannot resolve "${options.backend}"; use the bound fetch`),
    );
  }
  return unboundFetch(input, init, options);
};
