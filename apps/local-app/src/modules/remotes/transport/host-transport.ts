import { Readable } from 'node:stream';
import { AppError } from '../../../common/errors/error-types';
import { remoteAuthorization } from '../auth/remote-api-key.service';
import type {
  HostRoute,
  HostRouteBody,
  HostRouteParams,
  HostRouteResult,
} from '../contract/host-routes';
import { remoteFetch } from './remote-tls';
import type { RemoteFetchInit } from './remote-tls';

export interface HostTarget {
  baseUrl: string;
  certificate: string;
  apiKey: string | null;
  label: string;
  remoteId?: string;
}

/** A host request failed: unreachable, timed out, or answered with an unexpected status or body. */
export class RemoteHostRequestError extends AppError {
  constructor(
    message: string,
    details: { remoteId: string; path: string; status: number | null; hostCode: string | null },
  ) {
    super(message, 'REMOTE_HOST_REQUEST_FAILED', 502, details);
  }

  get status(): number | null {
    return (this.details?.status as number | null | undefined) ?? null;
  }
}

/** The host answered, but its answer does not match the contract; `path` may carry a query. */
export function invalidHostAnswer(
  remoteId: string,
  path: string,
  status: number,
): RemoteHostRequestError {
  return new RemoteHostRequestError(`Host returned an invalid answer to ${path.split('?')[0]}.`, {
    remoteId,
    path,
    status,
    hostCode: null,
  });
}

export interface HostSendOptions<R extends HostRoute> {
  body?: HostRouteBody<R> | Readable;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function send<R extends HostRoute>(
  target: HostTarget,
  route: R,
  params: HostRouteParams<R>,
  options: HostSendOptions<R> = {},
): Promise<HostRouteResult<R>> {
  const path = route.path(params);
  const remoteId = target.remoteId ?? target.baseUrl;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(abort, options.timeoutMs ?? route.timeoutMs);
  timeout.unref?.();
  let response: Response | undefined;
  try {
    const init: RemoteFetchInit = {
      method: route.method,
      headers: {
        ...remoteAuthorization(target.apiKey),
        ...(options.body !== undefined && {
          'content-type': route.contentType ?? 'application/json',
        }),
      },
      signal: controller.signal,
      ...(options.body !== undefined && {
        body:
          options.body instanceof Readable
            ? (options.body as unknown as BodyInit)
            : JSON.stringify(options.body),
        ...(options.body instanceof Readable && { duplex: 'half' as const }),
      }),
    };
    try {
      controller.signal.throwIfAborted();
      response = await remoteFetch(
        `${target.baseUrl.replace(/\/+$/, '')}${path}`,
        init,
        target.certificate,
      );
    } catch (error) {
      throw new RemoteHostRequestError(
        `${target.label} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { remoteId, path, status: null, hostCode: null },
      );
    }
    const status = response.status;
    const bodySchema = route.statuses[status];
    if (bodySchema === undefined) {
      const hostCode = await readErrorCode(response);
      const message =
        (hostCode && route.hostCodes?.[hostCode]) ||
        `${target.label} answered ${status} to ${route.method} ${path.split('?')[0]}${hostCode ? ` (${hostCode})` : ''}.`;
      throw new RemoteHostRequestError(message, { remoteId, path, status, hostCode });
    }
    let body: unknown;
    if (bodySchema === 'error-code') {
      body = await readErrorCode(response);
    } else if (bodySchema !== 'none') {
      const parsed = bodySchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw invalidHostAnswer(remoteId, path, status);
      body = parsed.data;
    }
    // The HTTP status selects its schema at runtime; that pairing is the
    // discriminant exposed to callers by the route's mapped result type.
    return { status, body } as HostRouteResult<R>;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    if (response) await discardBody(response);
  }
}

/** Releases the pooled connection; an unread body holds it until garbage collection. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown; details?: { code?: unknown } } | null;
    const detailCode = body?.details?.code;
    if (typeof detailCode === 'string') return detailCode;
    return typeof body?.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}
