import { useCallback, useRef } from 'react';
import { useOptionalWorktreeTab } from './useWorktreeTab';
import {
  MAIN_INSTANCE_API_PREFIXES,
  WORKTREE_PROXY_UNAVAILABLE_EVENT,
  type WorktreeProxyUnavailableDetail,
} from '@/ui/lib/worktree-fetch-interceptor';
import type { WorktreeTabContextValue } from './useWorktreeTab';

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function isMainInstanceApiPath(
  pathname: string,
  mainInstanceApiPrefixes: readonly string[],
): boolean {
  return mainInstanceApiPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isAlreadyPrefixed(pathname: string): boolean {
  return pathname.startsWith('/wt/');
}

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function extractPathname(input: RequestInfo | URL): string | null {
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

function getOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost';
}

async function emitWorktreeUnavailableEvent(
  response: Response,
  requestUrl: string,
  origin: string,
): Promise<void> {
  if (typeof window === 'undefined') return;
  if (response.status !== 503 && response.status !== 404) return;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl, origin);
  } catch {
    return;
  }

  const match = parsedUrl.pathname.match(/^\/wt\/([^/]+)/);
  if (!match || typeof match[1] !== 'string') return;

  let worktreeName: string | null = null;
  try {
    worktreeName = decodeURIComponent(match[1]);
  } catch {
    worktreeName = match[1];
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return;

  let payload: { message?: unknown; worktreeName?: unknown } | null = null;
  try {
    payload = (await response.clone().json()) as unknown as {
      message?: unknown;
      worktreeName?: unknown;
    };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      payload = null;
    }
  } catch {
    payload = null;
  }

  const headerWorktreeName = response.headers.get('X-Worktree-Name')?.trim();
  const payloadWorktreeName =
    typeof payload?.worktreeName === 'string' && payload.worktreeName.trim()
      ? payload.worktreeName.trim()
      : null;

  if (response.status === 404 && !headerWorktreeName && !payloadWorktreeName) return;

  const detailWorktreeName = headerWorktreeName || payloadWorktreeName || worktreeName;
  const message = typeof payload?.message === 'string' ? payload.message : null;

  window.dispatchEvent(
    new CustomEvent<WorktreeProxyUnavailableDetail>(WORKTREE_PROXY_UNAVAILABLE_EVENT, {
      detail: {
        statusCode: response.status,
        worktreeName: detailWorktreeName,
        message,
        requestUrl: parsedUrl.pathname + parsedUrl.search,
      },
    }),
  );
}

export interface WorktreeAwareFetchOptions {
  mainInstanceApiPrefixes?: readonly string[];
}

export function createWorktreeFetch(
  apiBase: string,
  options?: WorktreeAwareFetchOptions,
): typeof fetch {
  const normalizedBase = normalizeApiBase(apiBase);
  const prefixes = options?.mainInstanceApiPrefixes ?? MAIN_INSTANCE_API_PREFIXES;
  const origin = getOrigin();

  if (!normalizedBase) {
    return window.fetch.bind(window);
  }

  const worktreeFetch: typeof fetch = async (input, init) => {
    const pathname = extractPathname(input);
    let rewrittenInput: RequestInfo | URL = input;

    if (
      pathname &&
      !isAlreadyPrefixed(pathname) &&
      isApiPath(pathname) &&
      !isMainInstanceApiPath(pathname, prefixes)
    ) {
      if (typeof input === 'string') {
        const isAbsolute = /^https?:\/\//.test(input);
        if (!isAbsolute) {
          const queryStart = input.indexOf('?');
          const hashStart = input.indexOf('#');
          const pathOnly = queryStart >= 0 ? input.substring(0, queryStart) : input;
          const queryAndHash =
            queryStart >= 0
              ? input.substring(queryStart)
              : hashStart >= 0
                ? input.substring(hashStart)
                : '';
          rewrittenInput = `${normalizedBase}${pathOnly}${queryAndHash}`;
        } else {
          try {
            const parsed = new URL(input);
            parsed.pathname = `${normalizedBase}${parsed.pathname}`;
            rewrittenInput = parsed.toString();
          } catch {
            rewrittenInput = input;
          }
        }
      } else if (typeof URL !== 'undefined' && input instanceof URL) {
        const newUrl = new URL(input.toString(), origin);
        newUrl.pathname = `${normalizedBase}${newUrl.pathname}`;
        rewrittenInput = newUrl;
      } else if (typeof Request !== 'undefined' && input instanceof Request) {
        try {
          const parsed = new URL(input.url, origin);
          parsed.pathname = `${normalizedBase}${parsed.pathname}`;
          rewrittenInput = new Request(parsed.toString(), input);
        } catch {
          rewrittenInput = input;
        }
      }
    }

    const requestUrl =
      typeof rewrittenInput === 'string'
        ? rewrittenInput
        : rewrittenInput instanceof URL
          ? rewrittenInput.toString()
          : rewrittenInput instanceof Request
            ? rewrittenInput.url
            : String(rewrittenInput);

    const response = await window.fetch(rewrittenInput as RequestInfo | URL, init);
    void emitWorktreeUnavailableEvent(response, requestUrl, origin);
    return response;
  };

  return worktreeFetch;
}

export function useFetchFactory(
  options?: WorktreeAwareFetchOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const { apiBase } = useOptionalWorktreeTab();
  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;

  return useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      return createWorktreeFetch(apiBaseRef.current, options)(input, init);
    },
    [options],
  );
}
