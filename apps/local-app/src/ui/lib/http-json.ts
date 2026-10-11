import type { FetchFn } from './api-transport';

// Payload contract from common/filters/http-exception.filter.ts.
export interface ApiErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  details?: {
    code?: string;
    providerId?: string;
    providerName?: string;
    mcpStatus?: string;
    mcpMessage?: string;
    [key: string]: unknown;
  };
  timestamp: string;
  path: string;
}

export class SessionApiError extends Error {
  public readonly status: number;
  public readonly payload?: ApiErrorPayload;

  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message);
    this.name = 'SessionApiError';
    this.status = status;
    this.payload = payload;
  }

  hasCode(code: string): boolean {
    return this.payload?.details?.code === code;
  }
}

export type { FetchFn };

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'message' in payload) {
    return String((payload as { message: unknown }).message);
  }
  return fallback;
}

export async function fetchJsonOrThrow<T>(
  url: string,
  options: RequestInit = {},
  fallbackError: string = 'Request failed',
  fetchFn: FetchFn,
): Promise<T> {
  const response = await fetchFn(url, options);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = extractErrorMessage(payload, fallbackError);
    throw new SessionApiError(message, response.status, payload ?? undefined);
  }

  return response.json() as Promise<T>;
}

export async function fetchOrThrow(
  url: string,
  options: RequestInit = {},
  fallbackError: string = 'Request failed',
  fetchFn: FetchFn,
): Promise<void> {
  const response = await fetchFn(url, options);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = extractErrorMessage(payload, fallbackError);
    throw new SessionApiError(message, response.status, payload ?? undefined);
  }
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof payload.message === 'string' &&
    payload.message.trim().length > 0
  ) {
    return payload.message;
  }
  return fallback;
}

export async function fetchJsonWithMessageOrThrow<T>(
  fetchFn: FetchFn,
  url: string,
  options: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetchFn(url, options);
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, fallbackError));
  }
  return response.json() as Promise<T>;
}
