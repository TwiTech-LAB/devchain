import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { isLoopbackHost, normalizeHost } from '../config/integration-admission';

export const BROWSER_ORIGIN_REJECTION = {
  statusCode: 403,
  code: 'BROWSER_ORIGIN_REJECTED',
  message: 'Browser origin rejected',
} as const;

export type BrowserRequestRefusal = typeof BROWSER_ORIGIN_REJECTION;

export function guardBrowserRequest(
  headers: IncomingHttpHeaders,
  path: string,
  method: string | undefined,
  allowedHostnames: readonly string[],
): BrowserRequestRefusal | null {
  if (
    headers['sec-fetch-site'] === 'cross-site' &&
    !isCloudCallbackNavigation(headers, path, method)
  ) {
    return BROWSER_ORIGIN_REJECTION;
  }

  const host = headers.host;
  if (!host || !isHostAdmitted(host, allowedHostnames)) return BROWSER_ORIGIN_REJECTION;
  if (headers.origin !== undefined && !isOriginAdmitted(headers.origin, host)) {
    return BROWSER_ORIGIN_REJECTION;
  }
  return null;
}

// OAuth redirects retain cross-site metadata even after returning to the local app.
function isCloudCallbackNavigation(
  headers: IncomingHttpHeaders,
  path: string,
  method: string | undefined,
): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    path.split('?', 1)[0] === '/auth/cloud/callback' &&
    headers['sec-fetch-mode'] === 'navigate' &&
    headers['sec-fetch-dest'] === 'document'
  );
}

function isHostAdmitted(host: string, allowedHostnames: readonly string[]): boolean {
  if (/[\s/\\@?#]/.test(host)) return false;
  try {
    const hostname = normalizeHost(new URL(`http://${host}`).hostname);
    return (
      isLoopbackHost(hostname) ||
      isIP(hostname) !== 0 ||
      allowedHostnames.some((allowed) => normalizeHost(allowed) === hostname)
    );
  } catch {
    return false;
  }
}

function isOriginAdmitted(value: string, host: string): boolean {
  try {
    const origin = new URL(value);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      return false;
    }
    return (
      isLoopbackHost(origin.hostname) || origin.host === new URL(`${origin.protocol}//${host}`).host
    );
  } catch {
    return false;
  }
}
