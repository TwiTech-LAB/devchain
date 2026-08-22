import type { ProcessExecutor } from '../process-executor/process-executor.port';
import type {
  SessionTarget,
  DeliveryOptions,
  DeliveryResult,
  GuardedDeliveryResult,
} from './types';
import { captureStrict } from './capture';
import { generateDeliveryNonce } from '../../../../common/delivery-nonce';

const DEFAULT_POST_PASTE_DELAY_MS = 250;
const MAX_POST_PASTE_DELAY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_CONFIRM_TIMEOUT_MS = 2000;
const CONFIRM_POLL_INTERVAL_MS = 150;
const CONFIRM_TAIL_LINES = 10;

interface ConfirmationBaseline {
  readonly output: string | undefined;
}

interface PreparedBuffer {
  readonly name: string;
}

function clampDelay(raw: number | undefined, fallback: number): number {
  const v = raw ?? fallback;
  return Number.isFinite(v) ? Math.min(MAX_POST_PASTE_DELAY_MS, Math.max(0, v)) : 0;
}

function extractPasteIndicatorLines(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /pasted/i.test(l)),
  );
}

async function confirmPasteDelivery(
  executor: ProcessExecutor,
  target: SessionTarget,
  nonce: string,
  baseline: string | undefined,
  timeoutMs: number,
): Promise<{
  confirmed: boolean;
  method?: 'nonce' | 'paste_indicator' | 'paste_changed';
  captureError?: boolean;
}> {
  const baselinePasteLines = baseline != null ? extractPasteIndicatorLines(baseline) : null;
  const startedAt = Date.now();

  while (true) {
    const result = await captureStrict(executor, target, CONFIRM_TAIL_LINES);

    if (!result.ok) {
      return { confirmed: false, captureError: true };
    }

    if (result.output.includes(nonce)) {
      return { confirmed: true, method: 'nonce' };
    }

    if (baselinePasteLines != null) {
      const currentPasteLines = extractPasteIndicatorLines(result.output);
      const hasNewLine = [...currentPasteLines].some((l) => !baselinePasteLines.has(l));
      if (hasNewLine) {
        return { confirmed: true, method: 'paste_indicator' };
      }
      if (result.output !== baseline && currentPasteLines.size > 0) {
        return { confirmed: true, method: 'paste_changed' };
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return { confirmed: false };
    }

    await new Promise<void>((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS));
  }
}

async function loadBuffer(
  executor: ProcessExecutor,
  bufferName: string,
  content: string,
): Promise<void> {
  const result = await executor.run({
    argv: ['tmux', 'load-buffer', '-b', bufferName, '-'],
    mode: 'pipe',
    input: content,
  });
  if (!result.success) {
    throw new Error(`Failed to load tmux buffer "${bufferName}": ${result.stderr}`);
  }
}

async function pasteBuffer(
  executor: ProcessExecutor,
  bufferName: string,
  sessionName: string,
): Promise<void> {
  const result = await executor.run({
    argv: ['tmux', 'paste-buffer', '-b', bufferName, '-t', sessionName],
    mode: 'pipe',
  });
  if (!result.success) {
    throw new Error(`Failed to paste tmux buffer: ${result.stderr}`);
  }
}

async function deleteBuffer(executor: ProcessExecutor, bufferName: string): Promise<void> {
  await executor.run({
    argv: ['tmux', 'delete-buffer', '-b', bufferName],
    mode: 'pipe',
  });
}

async function sendKeys(
  executor: ProcessExecutor,
  target: SessionTarget,
  keys: readonly string[],
): Promise<void> {
  if (!keys.length) return;
  const result = await executor.run({
    argv: ['tmux', 'send-keys', '-t', `=${target.name}:`, ...keys],
    mode: 'pipe',
  });
  if (!result.success) {
    throw new Error(`Failed to send keys to "${target.name}": ${result.stderr}`);
  }
}

async function sendSubmitKeysWithRetry(
  executor: ProcessExecutor,
  target: SessionTarget,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await sendKeys(executor, target, keys);
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    await sendKeys(executor, target, keys);
  }
}

async function pasteAndSubmit(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  options: {
    bracketed: boolean;
    submitKeys: readonly string[];
    preKeys?: readonly string[];
    preDelayMs?: number;
    postPasteDelayMs: number;
    confirm: boolean;
    nonce?: string;
    confirmTimeoutMs: number;
    confirmationBaseline?: ConfirmationBaseline;
    preparedBuffer?: PreparedBuffer;
  },
): Promise<{ method?: 'nonce' | 'paste_indicator' | 'paste_changed' }> {
  let preparedBufferNeedsCleanup = Boolean(options.preparedBuffer);
  try {
    if (options.preKeys?.length) {
      await sendKeys(executor, target, options.preKeys);
      if (options.preDelayMs && options.preDelayMs > 0) {
        await new Promise((r) => setTimeout(r, options.preDelayMs));
      }
    }

    let baseline: string | undefined;
    if (options.confirm && options.nonce) {
      if (options.confirmationBaseline) {
        baseline = options.confirmationBaseline.output;
      } else {
        const baselineResult = await captureStrict(executor, target, CONFIRM_TAIL_LINES);
        if (baselineResult.ok) {
          baseline = baselineResult.output;
        }
      }
    }

    const preparedBuffer =
      options.preparedBuffer ?? (await prepareBuffer(executor, target, text, options.bracketed));

    await pasteBuffer(executor, preparedBuffer.name, target.name);
    await deleteBuffer(executor, preparedBuffer.name);
    preparedBufferNeedsCleanup = false;

    if (options.confirm && options.nonce) {
      const confirmation = await confirmPasteDelivery(
        executor,
        target,
        options.nonce,
        baseline,
        options.confirmTimeoutMs,
      );

      if (confirmation.confirmed) {
        if (options.postPasteDelayMs > 0) {
          await new Promise((r) => setTimeout(r, options.postPasteDelayMs));
        }
      } else if (confirmation.captureError) {
        await new Promise((r) => setTimeout(r, options.postPasteDelayMs));
      } else {
        throw new PasteNotConfirmedError(target.name, options.nonce);
      }

      await sendSubmitKeysWithRetry(executor, target, options.submitKeys);

      return { method: confirmation.method };
    }

    if (options.postPasteDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.postPasteDelayMs));
    }

    await sendSubmitKeysWithRetry(executor, target, options.submitKeys);

    return {};
  } catch (error) {
    if (preparedBufferNeedsCleanup && options.preparedBuffer) {
      await deleteBuffer(executor, options.preparedBuffer.name);
    }
    throw error;
  }
}

async function prepareBuffer(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  bracketed: boolean,
): Promise<PreparedBuffer> {
  const prepared = text.replace(/\r?\n/g, '\r');
  const payload = bracketed ? `\x1b[200~${prepared}\x1b[201~` : prepared;
  const safeSession = target.name.replace(/[^a-zA-Z0-9_.-]/g, '');
  const name = `devchain-${safeSession}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  await loadBuffer(executor, name, payload);
  return { name };
}

export class PasteNotConfirmedError extends Error {
  constructor(
    readonly sessionName: string,
    readonly nonce: string,
  ) {
    super(`Paste not confirmed for session "${sessionName}" (nonce: ${nonce})`);
    this.name = 'PasteNotConfirmedError';
  }
}

export class TypeCommandFailedError extends Error {
  constructor(
    readonly sessionName: string,
    readonly phase: 'literal' | 'enter',
    readonly cause?: string,
  ) {
    super(
      `typeCommand failed for session "${sessionName}" at phase "${phase}"${cause ? `: ${cause}` : ''}`,
    );
    this.name = 'TypeCommandFailedError';
  }
}

export interface SendGap {
  ensureGap(agentId: string, minMs?: number): Promise<void>;
  clear(): void;
}

async function captureConfirmationBaseline(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<ConfirmationBaseline> {
  const result = await captureStrict(executor, target, CONFIRM_TAIL_LINES);
  return { output: result.ok ? result.output : undefined };
}

function deliverWithFirstMutationGuard(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: undefined,
): Promise<DeliveryResult>;
function deliverWithFirstMutationGuard(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: () => boolean,
): Promise<GuardedDeliveryResult>;
async function deliverWithFirstMutationGuard(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: (() => boolean) | undefined,
): Promise<GuardedDeliveryResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const submitKeys = options.submitKeys ?? ['Enter'];
  const bracketed = options.bracketed ?? true;
  const postPasteDelayMs = clampDelay(options.postPasteDelayMs, DEFAULT_POST_PASTE_DELAY_MS);
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirm = options.confirm ?? true;

  let lastNonce = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastNonce = generateDeliveryNonce();
    const textWithNonce = `${text}\n[MsgId:${lastNonce}]`;

    await gap.ensureGap(options.agentId);

    let confirmationBaseline: ConfirmationBaseline | undefined;
    let preparedBuffer: PreparedBuffer | undefined;
    if (attempt === 0 && firstMutationGuard && confirm) {
      confirmationBaseline = await captureConfirmationBaseline(executor, target);
    }
    if (attempt === 0 && firstMutationGuard) {
      preparedBuffer = await prepareBuffer(executor, target, textWithNonce, bracketed);
    }
    if (attempt === 0 && firstMutationGuard && !firstMutationGuard()) {
      await deleteBuffer(executor, preparedBuffer!.name);
      return { deferred: 'human_draft' };
    }

    try {
      const result = await pasteAndSubmit(executor, target, textWithNonce, {
        bracketed,
        submitKeys,
        preKeys: attempt === 0 ? options.preKeys : undefined,
        preDelayMs: options.preDelayMs,
        postPasteDelayMs,
        confirm,
        nonce: lastNonce,
        confirmTimeoutMs,
        confirmationBaseline,
        preparedBuffer,
      });

      return { confirmed: true, nonce: lastNonce, retryCount: attempt, method: result.method };
    } catch (error) {
      if (error instanceof PasteNotConfirmedError && attempt < maxAttempts - 1) {
        try {
          await sendKeys(executor, target, ['Escape']);
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      if (error instanceof PasteNotConfirmedError) {
        try {
          await sendKeys(executor, target, submitKeys);
        } catch {}
        return { confirmed: false, nonce: lastNonce, retryCount: attempt };
      }

      throw error;
    }
  }

  return { confirmed: false, nonce: lastNonce, retryCount: maxAttempts - 1 };
}

export async function deliver(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  return deliverWithFirstMutationGuard(executor, gap, target, text, options, undefined);
}

export async function deliverGuarded(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: () => boolean,
): Promise<GuardedDeliveryResult> {
  return deliverWithFirstMutationGuard(executor, gap, target, text, options, firstMutationGuard);
}

export async function deliverImmediate(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  options: Omit<DeliveryOptions, 'agentId'>,
): Promise<DeliveryResult> {
  const submitKeys = options.submitKeys ?? ['Enter'];
  const bracketed = options.bracketed ?? true;
  const postPasteDelayMs = clampDelay(options.postPasteDelayMs, DEFAULT_POST_PASTE_DELAY_MS);
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirm = options.confirm ?? false;

  const nonce = generateDeliveryNonce();
  const textWithNonce = confirm ? `${text}\n[MsgId:${nonce}]` : text;

  const result = await pasteAndSubmit(executor, target, textWithNonce, {
    bracketed,
    submitKeys,
    preKeys: options.preKeys,
    preDelayMs: options.preDelayMs,
    postPasteDelayMs,
    confirm,
    nonce: confirm ? nonce : undefined,
    confirmTimeoutMs,
  });

  return { confirmed: true, nonce, retryCount: 0, method: result.method };
}

export async function sendControl(
  executor: ProcessExecutor,
  target: SessionTarget,
  keys: readonly string[],
): Promise<void> {
  await sendKeys(executor, target, keys);
}
