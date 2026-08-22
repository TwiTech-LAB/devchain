import { isIP } from 'node:net';

export type SafeVendorHttpFailureReason =
  | 'unsafe_url'
  | 'redirect_rejected'
  | 'timeout'
  | 'response_too_large'
  | 'invalid_response'
  | 'http_error'
  | 'network_error'
  | 'concurrency_limit';

const FAILURE_MESSAGES: Record<SafeVendorHttpFailureReason, string> = {
  unsafe_url: 'Vendor request URL is not allowed',
  redirect_rejected: 'Vendor redirect was rejected',
  timeout: 'Vendor request timed out',
  response_too_large: 'Vendor response exceeded the size limit',
  invalid_response: 'Vendor returned an invalid response',
  http_error: 'Vendor returned an unsuccessful response',
  network_error: 'Vendor request failed',
  concurrency_limit: 'Vendor request concurrency limit reached',
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_QUEUED_REQUESTS = 32;

export class SafeVendorHttpError extends Error {
  /**
   * True when the request was already handed to the transport when it
   * failed. For mutations such a failure has an unknown outcome — the vendor
   * may or may not have applied it. False means the request never left this
   * process (URL validation, queue admission), so nothing was applied.
   */
  public readonly dispatched: boolean;

  constructor(
    public readonly reason: SafeVendorHttpFailureReason,
    public readonly upstreamStatus?: number,
    public readonly retryAt?: string,
    dispatched = false,
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = 'SafeVendorHttpError';
    this.dispatched = dispatched;
  }
}

export interface SafeVendorHttpClientOptions {
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
  defaultMaxResponseBytes?: number;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
}

export interface SafeVendorJsonRequest {
  url: string;
  allowedOrigins: readonly string[];
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type SafeVendorNoContentRequest = Omit<SafeVendorJsonRequest, 'maxResponseBytes'>;

interface QueueWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: SafeVendorHttpError) => void;
  onAbort: () => void;
}

export class SafeVendorHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxResponseBytes: number;
  private readonly maxConcurrentRequests: number;
  private readonly maxQueuedRequests: number;
  private activeRequests = 0;
  private readonly queue: QueueWaiter[] = [];

  constructor(options: SafeVendorHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.defaultTimeoutMs = this.requirePositive(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    );
    this.defaultMaxResponseBytes = this.requirePositive(
      options.defaultMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'defaultMaxResponseBytes',
    );
    this.maxConcurrentRequests = this.requirePositive(
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
      'maxConcurrentRequests',
    );
    this.maxQueuedRequests = this.requirePositive(
      options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS,
      'maxQueuedRequests',
    );
  }

  async requestJson(request: SafeVendorJsonRequest): Promise<unknown> {
    const maxResponseBytes = this.requirePositive(
      request.maxResponseBytes ?? this.defaultMaxResponseBytes,
      'maxResponseBytes',
    );
    return this.executeRequest(request, (response) => this.readJson(response, maxResponseBytes));
  }

  async requestNoContent(request: SafeVendorNoContentRequest): Promise<void> {
    await this.executeRequest(request, async (response) => {
      const contentLength = response.headers.get('content-length');
      if (
        response.status !== 204 ||
        response.body !== null ||
        (contentLength !== null && contentLength !== '0')
      ) {
        await this.disposeBody(response);
        throw new SafeVendorHttpError('invalid_response');
      }
    });
  }

  private async executeRequest<T>(
    request: SafeVendorJsonRequest,
    handleSuccess: (response: Response) => Promise<T>,
  ): Promise<T> {
    const url = this.validateUrl(request.url, request.allowedOrigins);
    const timeoutMs = this.requirePositive(request.timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let release: (() => void) | undefined;
    // Treat the request as dispatched immediately before calling fetchImpl.
    // This deliberately classifies synchronous fetch failures conservatively:
    // the caller must verify the vendor outcome instead of retrying blindly.
    let dispatched = false;

    try {
      release = await this.acquire(controller.signal);
      dispatched = true;
      const response = await this.fetchImpl(url.toString(), {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        await this.disposeBody(response);
        throw new SafeVendorHttpError('redirect_rejected', undefined, undefined, dispatched);
      }
      if (!response.ok) {
        const retryAt =
          response.status === 429
            ? (this.parseRetryAfter(response.headers.get('retry-after')) ??
              this.parseRateLimitReset(response.headers.get('x-ratelimit-reset')))
            : undefined;
        await this.disposeBody(response);
        // A 5xx after dispatch means the vendor received (or processed) the
        // mutation but answered unusably — outcome unknown, not a clean 4xx.
        throw new SafeVendorHttpError(
          'http_error',
          response.status,
          retryAt,
          dispatched && response.status >= 500,
        );
      }

      try {
        return await handleSuccess(response);
      } catch (error) {
        // Response-handling failures (parse, size, content type) occur after
        // the vendor already received the request, so they carry dispatched —
        // decided by position after fetch, never by the reason string. The
        // status-based classification above stays untouched.
        if (error instanceof SafeVendorHttpError && !error.dispatched) {
          throw new SafeVendorHttpError(error.reason, error.upstreamStatus, error.retryAt, true);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SafeVendorHttpError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new SafeVendorHttpError('timeout', undefined, undefined, dispatched);
      }
      throw new SafeVendorHttpError('network_error', undefined, undefined, dispatched);
    } finally {
      clearTimeout(timeout);
      release?.();
    }
  }

  private validateUrl(value: string, allowedOrigins: readonly string[]): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SafeVendorHttpError('unsafe_url');
    }

    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      this.isUnsafeHostname(url.hostname)
    ) {
      throw new SafeVendorHttpError('unsafe_url');
    }

    const normalizedOrigins = new Set<string>();
    for (const allowedOrigin of allowedOrigins) {
      try {
        const parsed = new URL(allowedOrigin);
        if (
          parsed.protocol !== 'https:' ||
          parsed.username !== '' ||
          parsed.password !== '' ||
          parsed.port !== '' ||
          parsed.pathname !== '/' ||
          parsed.search !== '' ||
          parsed.hash !== '' ||
          this.isUnsafeHostname(parsed.hostname)
        ) {
          throw new Error('invalid origin');
        }
        normalizedOrigins.add(parsed.origin);
      } catch {
        throw new SafeVendorHttpError('unsafe_url');
      }
    }

    if (!normalizedOrigins.has(url.origin)) {
      throw new SafeVendorHttpError('unsafe_url');
    }
    return url;
  }

  private isUnsafeHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    return (
      isIP(normalized) !== 0 ||
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized.endsWith('.local')
    );
  }

  private async readJson(response: Response, maxResponseBytes: number): Promise<unknown> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      await this.disposeBody(response);
      throw new SafeVendorHttpError('invalid_response');
    }

    const advertisedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedLength) && advertisedLength > maxResponseBytes) {
      await this.disposeBody(response);
      throw new SafeVendorHttpError('response_too_large');
    }
    if (!response.body) {
      throw new SafeVendorHttpError('invalid_response');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new SafeVendorHttpError('response_too_large');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof SafeVendorHttpError) {
        throw error;
      }
      await reader.cancel().catch(() => undefined);
      throw new SafeVendorHttpError('invalid_response');
    } finally {
      reader.releaseLock();
    }
  }

  private async disposeBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new SafeVendorHttpError('timeout'));
    }
    if (this.activeRequests < this.maxConcurrentRequests) {
      this.activeRequests += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= this.maxQueuedRequests) {
      return Promise.reject(new SafeVendorHttpError('concurrency_limit'));
    }

    return new Promise((resolve, reject) => {
      const waiter: QueueWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new SafeVendorHttpError('timeout'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        continue;
      }
      this.activeRequests += 1;
      waiter.resolve(() => this.release());
      break;
    }
  }

  private requirePositive(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive safe integer`);
    }
    return value;
  }

  private parseRateLimitReset(value: string | null): string | undefined {
    if (!value || !/^\d{1,13}$/.test(value)) {
      return undefined;
    }
    const milliseconds = Number(value) * 1000;
    if (!Number.isSafeInteger(milliseconds)) {
      return undefined;
    }
    try {
      return new Date(milliseconds).toISOString();
    } catch {
      return undefined;
    }
  }

  private parseRetryAfter(value: string | null): string | undefined {
    if (!value) {
      return undefined;
    }
    if (/^\d{1,9}$/.test(value)) {
      const milliseconds = Date.now() + Number(value) * 1000;
      if (!Number.isSafeInteger(milliseconds)) {
        return undefined;
      }
      return new Date(milliseconds).toISOString();
    }
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && milliseconds >= Date.now()
      ? new Date(milliseconds).toISOString()
      : undefined;
  }
}
