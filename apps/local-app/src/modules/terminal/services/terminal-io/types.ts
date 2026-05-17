export interface SessionTarget {
  readonly name: string;
}

export interface CreateSessionOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CaptureResult {
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
}

export interface CursorPosition {
  readonly x: number;
  readonly y: number;
}

export interface HealthResult {
  readonly alive: boolean;
}

export interface WaitForOutputOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly settleMs?: number;
  readonly lines?: number;
}

export interface DeliveryOptions {
  readonly agentId: string;
  readonly bracketed?: boolean;
  readonly submitKeys?: readonly string[];
  readonly preKeys?: readonly string[];
  readonly preDelayMs?: number;
  readonly postPasteDelayMs?: number;
  readonly confirm?: boolean;
  readonly confirmTimeoutMs?: number;
  readonly maxAttempts?: number;
}

export interface DeliveryResult {
  readonly confirmed: boolean;
  readonly nonce: string;
  readonly retryCount: number;
  readonly method?: 'nonce' | 'paste_indicator' | 'paste_changed';
}
