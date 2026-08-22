export interface SessionTarget {
  readonly name: string;
}

export type ExpectedSessionDestroyResult =
  | { readonly outcome: 'destroyed' }
  | { readonly outcome: 'known-absent' }
  | { readonly outcome: 'unknown-error'; readonly error: Error };

export type ExpectedSessionDestroyPolicy =
  | {
      readonly onUnknownError: 'rearm';
      readonly sessionId: string;
      readonly intervalMs?: number;
    }
  | { readonly onUnknownError: 'retire' };

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

/**
 * Keys that move an in-progress user draft out of the prompt before an injected
 * message is submitted, and put it back afterwards. Providers declare these; see
 * `RuntimePromptBehavior.promptDraftKeys`.
 */
export interface PromptDraftKeys {
  /** Clears the prompt from any cursor position, retaining the text. */
  readonly stash: readonly string[];
  /** Restores the stashed text verbatim. */
  readonly restore: readonly string[];
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
  /**
   * Provider keys used to protect an unsent user draft. Supplied only when the
   * provider declares support; delivery additionally requires the pane to
   * actually hold a draft before using them.
   */
  readonly draftKeys?: PromptDraftKeys;
}

export interface DeliveryResult {
  readonly confirmed: boolean;
  readonly nonce: string;
  readonly retryCount: number;
  readonly method?: 'nonce' | 'paste_indicator' | 'paste_changed';
}
