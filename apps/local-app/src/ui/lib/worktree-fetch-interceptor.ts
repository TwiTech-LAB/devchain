export const MAIN_INSTANCE_API_PREFIXES = [
  '/api/worktrees',
  '/api/templates',
  '/api/runtime',
  '/api/registry',
];
export const WORKTREE_PROXY_UNAVAILABLE_EVENT = 'devchain:worktree-proxy-unavailable';

export interface WorktreeProxyUnavailableDetail {
  statusCode: number;
  worktreeName: string;
  message: string | null;
  requestUrl: string;
}

export interface RewriteApiRequestUrlOptions {
  apiBase: string;
  origin?: string;
  mainInstanceApiPrefixes?: readonly string[];
}

export interface WorktreeFetchInterceptorOptions {
  getApiBase: () => string;
  origin?: string;
  mainInstanceApiPrefixes?: readonly string[];
}

interface ProxyErrorPayload {
  message?: unknown;
  worktreeName?: unknown;
}

function getOrigin(origin?: string): string {
  if (origin) {
    return origin;
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost';
}

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value) || value.startsWith('//');
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function extractWorktreeName(pathname: string): string | null {
  const match = pathname.match(/^\/wt\/([^/]+)/);
  if (!match || typeof match[1] !== 'string') {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function readProxyErrorPayload(response: Response): Promise<ProxyErrorPayload | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return null;
  }

  try {
    const payload = (await response.clone().json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    return payload as ProxyErrorPayload;
  } catch {
    return null;
  }
}

async function emitWorktreeUnavailableEvent(
  response: Response,
  requestUrl: string,
  origin: string,
) {
  if (typeof window === 'undefined') {
    return;
  }
  if (response.status !== 503 && response.status !== 404) {
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl, origin);
  } catch {
    return;
  }

  const worktreeName = extractWorktreeName(parsedUrl.pathname);
  if (!worktreeName) {
    return;
  }

  const payload = await readProxyErrorPayload(response);
  const message = typeof payload?.message === 'string' ? payload.message : null;
  const payloadWorktreeName =
    typeof payload?.worktreeName === 'string' ? payload.worktreeName : worktreeName;

  window.dispatchEvent(
    new CustomEvent<WorktreeProxyUnavailableDetail>(WORKTREE_PROXY_UNAVAILABLE_EVENT, {
      detail: {
        statusCode: response.status,
        worktreeName: payloadWorktreeName,
        message,
        requestUrl: parsedUrl.pathname + parsedUrl.search,
      },
    }),
  );
}

function isMainInstanceApiPath(
  pathname: string,
  mainInstanceApiPrefixes: readonly string[],
): boolean {
  return mainInstanceApiPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function rewriteFetchInput(
  input: RequestInfo | URL,
  apiBase: string,
  origin: string,
  mainInstanceApiPrefixes: readonly string[],
): RequestInfo | URL {
  if (typeof input === 'string') {
    return rewriteApiRequestUrl(input, { apiBase, origin, mainInstanceApiPrefixes });
  }

  if (typeof URL !== 'undefined' && input instanceof URL) {
    const rewrittenUrl = rewriteApiRequestUrl(input.toString(), {
      apiBase,
      origin,
      mainInstanceApiPrefixes,
    });
    return rewrittenUrl === input.toString() ? input : new URL(rewrittenUrl, origin);
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    const rewrittenUrl = rewriteApiRequestUrl(input.url, {
      apiBase,
      origin,
      mainInstanceApiPrefixes,
    });
    if (rewrittenUrl === input.url) {
      return input;
    }
    return new Request(rewrittenUrl, input);
  }

  return input;
}

export function rewriteApiRequestUrl(url: string, options: RewriteApiRequestUrlOptions): string {
  const normalizedApiBase = normalizeApiBase(options.apiBase);
  if (!normalizedApiBase) {
    return url;
  }

  const origin = getOrigin(options.origin);
  const mainInstanceApiPrefixes = options.mainInstanceApiPrefixes ?? MAIN_INSTANCE_API_PREFIXES;
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url, origin);
  } catch {
    return url;
  }

  if (parsedUrl.origin !== origin) {
    return url;
  }

  const { pathname, search, hash } = parsedUrl;
  if (pathname.startsWith('/wt/')) {
    return url;
  }

  if (!isApiPath(pathname)) {
    return url;
  }

  if (isMainInstanceApiPath(pathname, mainInstanceApiPrefixes)) {
    return url;
  }

  const rewrittenPath = `${normalizedApiBase}${pathname}`;

  if (!isAbsoluteUrl(url)) {
    return `${rewrittenPath}${search}${hash}`;
  }

  parsedUrl.pathname = rewrittenPath;
  return parsedUrl.toString();
}

export function installWorktreeFetchInterceptor(
  options: WorktreeFetchInterceptorOptions,
): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return () => undefined;
  }

  const origin = getOrigin(options.origin);
  const mainInstanceApiPrefixes = options.mainInstanceApiPrefixes ?? MAIN_INSTANCE_API_PREFIXES;
  const previousFetch = window.fetch;
  const originalFetch = window.fetch.bind(window);

  const interceptedFetch: typeof window.fetch = async (input, init) => {
    const rewrittenInput = rewriteFetchInput(
      input,
      options.getApiBase(),
      origin,
      mainInstanceApiPrefixes,
    );
    const requestUrl = getRequestUrl(rewrittenInput as RequestInfo | URL);
    const response = await originalFetch(rewrittenInput as RequestInfo | URL, init);
    void emitWorktreeUnavailableEvent(response, requestUrl, origin);
    return response;
  };

  window.fetch = interceptedFetch;

  return () => {
    if (window.fetch === interceptedFetch) {
      window.fetch = previousFetch;
    }
  };
}
