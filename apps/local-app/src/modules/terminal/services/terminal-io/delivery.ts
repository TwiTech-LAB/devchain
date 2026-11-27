import type { ProcessExecutor } from '../process-executor/process-executor.port';
import type {
  SessionTarget,
  PinnedPane,
  DeliveryOptions,
  DeliveryResult,
  GuardedDeliveryResult,
} from './types';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { providerTraits } from '../../../providers/adapters/provider-traits';
import type { ProviderTraits } from '../../../providers/provider-traits.types';
import { captureHistory, captureStrict } from './capture';
import { readForegroundState } from './foreground';
import { generateDeliveryNonce } from '../../../../common/delivery-nonce';
import { FOLLOW_NOTE } from '../../../../common/follow-note';
import { createLogger } from '../../../../common/logging/logger';

const logger = createLogger('TerminalIODelivery');

const DEFAULT_POST_PASTE_DELAY_MS = 250;
const MAX_POST_PASTE_DELAY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_CONFIRM_TIMEOUT_MS = 2000;
const CONFIRM_POLL_INTERVAL_MS = 150;
const CONFIRM_TAIL_LINES = 10;
const MIN_FOLLOW_NOTE_DELAY_MS = 100;
const SUBMIT_CHECK_INTERVAL_MS = 150;
const SUBMIT_CHECK_TIMEOUT_MS = 2000;

interface ConfirmationBaseline {
  readonly output: string | undefined;
}

interface PreparedBuffer {
  readonly name: string;
}

export type ForegroundCheck = () => Promise<void>;
// False when a human gave DevChain input to the pane after the delivery took the pane lock.
export type SubmitGuard = () => boolean;

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
  signal?: AbortSignal,
): Promise<void> {
  const result = await executor.run({
    argv: ['tmux', 'load-buffer', '-b', bufferName, '-'],
    mode: 'pipe',
    input: content,
    signal,
  });
  if (!result.success) {
    throw new Error(`Failed to load tmux buffer "${bufferName}": ${result.stderr}`);
  }
}

async function pasteBuffer(
  executor: ProcessExecutor,
  bufferName: string,
  sessionName: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await executor.run({
    argv: ['tmux', 'paste-buffer', '-b', bufferName, '-t', sessionName],
    mode: 'pipe',
    signal,
  });
  if (!result.success) {
    throw new Error(`Failed to paste tmux buffer: ${result.stderr}`);
  }
}

async function deleteBuffer(
  executor: ProcessExecutor,
  bufferName: string,
  signal?: AbortSignal,
): Promise<void> {
  await executor.run({
    argv: ['tmux', 'delete-buffer', '-b', bufferName],
    mode: 'pipe',
    signal,
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

// Provider (`/compact`) and shell (`!git status`) commands would absorb the note.
function shouldTypeFollowNote(
  text: string,
  options: { followNote?: boolean; bracketed: boolean; submitKeys: readonly string[] },
): boolean {
  return (
    options.followNote === true &&
    options.bracketed &&
    options.submitKeys.length > 0 &&
    !/^\s*[/!]/.test(text)
  );
}

async function typeFollowNote(
  executor: ProcessExecutor,
  target: SessionTarget,
  postPasteDelayMs: number,
  foregroundCheck?: ForegroundCheck,
): Promise<void> {
  await foregroundCheck?.();
  try {
    await sendKeys(executor, target, ['-l', '--', FOLLOW_NOTE]);
  } catch {
    return;
  }
  await new Promise((r) => setTimeout(r, Math.max(postPasteDelayMs, MIN_FOLLOW_NOTE_DELAY_MS)));
}

async function sendSubmitKeysWithRetry(
  executor: ProcessExecutor,
  target: SessionTarget,
  keys: readonly string[],
  foregroundCheck?: ForegroundCheck,
  firstWriteChecked = false,
): Promise<void> {
  if (keys.length === 0) return;
  if (!firstWriteChecked) await foregroundCheck?.();
  try {
    await sendKeys(executor, target, keys);
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    await foregroundCheck?.();
    await sendKeys(executor, target, keys);
  }
}

// The input box is the last line that starts with the marker, through the end of the capture.
// Transcript lines can start with the marker too, but they always sit above the input box.
function isMessageInInputBox(output: string, marker: string, nonce: string | undefined): boolean {
  const lines = output.split('\n');
  let inputStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith(marker)) {
      inputStart = i;
      break;
    }
  }
  if (inputStart === -1) return false;
  const inputBox = lines.slice(inputStart).join('\n');
  return (nonce != null && inputBox.includes(`[MsgId:${nonce}]`)) || /\[Pasted/i.test(inputBox);
}

// Presses the submit keys once more when the message is still in the input box 2 s after
// the first submit. Never throws: the delivery has already happened, and a failed
// delivery is resent, which would duplicate the message. Logs never include pane text.
async function resubmitIfStillInInputBox(
  executor: ProcessExecutor,
  target: SessionTarget,
  options: { marker: string; nonce?: string; submitKeys: readonly string[] },
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
): Promise<void> {
  const startedAt = Date.now();
  let polls = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, SUBMIT_CHECK_INTERVAL_MS));
    const result = await captureStrict(executor, target, CONFIRM_TAIL_LINES).catch(() => undefined);
    if (!result?.ok) return;
    polls += 1;
    if (!isMessageInInputBox(result.output, options.marker, options.nonce)) return;
    if (Date.now() - startedAt + SUBMIT_CHECK_INTERVAL_MS > SUBMIT_CHECK_TIMEOUT_MS) break;
  }

  try {
    await foregroundCheck?.();
    if (submitGuard && !submitGuard()) return;
  } catch {
    return;
  }

  const logContext = {
    sessionName: target.name,
    nonce: options.nonce,
    polls,
    elapsedMs: Date.now() - startedAt,
  };
  logger.warn(logContext, 'Message still in the input box after submit; submitting once more');
  try {
    await sendSubmitKeysWithRetry(executor, target, options.submitKeys, foregroundCheck, true);
  } catch (error) {
    logger.warn(
      { ...logContext, error: error instanceof Error ? error.message : String(error) },
      'Extra submit failed',
    );
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
    followNote?: boolean;
    firstWriteChecked?: boolean;
    inputPromptMarker?: string;
  },
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
): Promise<{ method?: 'nonce' | 'paste_indicator' | 'paste_changed' }> {
  // Set while a tmux buffer exists that this call must delete on failure.
  let pendingBuffer = options.preparedBuffer;
  let firstWriteChecked = options.firstWriteChecked === true;
  try {
    if (options.preKeys?.length) {
      if (!firstWriteChecked) await foregroundCheck?.();
      firstWriteChecked = false;
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

    pendingBuffer ??= await prepareBuffer(executor, target, text, options.bracketed);

    if (!firstWriteChecked) await foregroundCheck?.();
    await pasteBuffer(executor, pendingBuffer.name, target.name);
    await deleteBuffer(executor, pendingBuffer.name);
    pendingBuffer = undefined;

    let method: 'nonce' | 'paste_indicator' | 'paste_changed' | undefined;
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
      method = confirmation.method;
    } else if (options.postPasteDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.postPasteDelayMs));
    }

    if (shouldTypeFollowNote(text, options)) {
      await typeFollowNote(executor, target, options.postPasteDelayMs, foregroundCheck);
    }
    await sendSubmitKeysWithRetry(executor, target, options.submitKeys, foregroundCheck);
    if (options.inputPromptMarker && options.submitKeys.length > 0) {
      await resubmitIfStillInInputBox(
        executor,
        target,
        { marker: options.inputPromptMarker, nonce: options.nonce, submitKeys: options.submitKeys },
        foregroundCheck,
        submitGuard,
      );
    }

    return { method };
  } catch (error) {
    if (pendingBuffer) {
      await deleteBuffer(executor, pendingBuffer.name);
    }
    throw error;
  }
}

async function prepareBuffer(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  bracketed: boolean,
  signal?: AbortSignal,
): Promise<PreparedBuffer> {
  const prepared = text.replace(/\r?\n/g, '\r');
  const payload = bracketed ? `\x1b[200~${prepared}\x1b[201~` : prepared;
  const safeSession = target.name.replace(/[^a-zA-Z0-9_.-]/g, '');
  const name = `devchain-${safeSession}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await loadBuffer(executor, name, payload, signal);
  } catch (error) {
    if (signal) discardComposerBuffer(executor, name);
    throw error;
  }
  return { name };
}

// Each buffer has a unique name. Its cleanup can finish outside the pane queue after cancellation.
function discardComposerBuffer(executor: ProcessExecutor, name: string): void {
  void deleteBuffer(executor, name, AbortSignal.timeout(2000)).catch(() => undefined);
}

export type ImageWriteResult = 'delivered' | 'recognized' | 'unconfirmed' | 'uncertain';

export function draftChipCount(
  screen: string,
  filename: string,
  chip: NonNullable<ProviderTraits['imagePasteChip']>,
): number {
  const lines = screen.split('\n');
  const rules = lines.flatMap((line, i) => (/^\s*[─━]{3}/.test(line) ? [i] : []));
  if (rules.length < 2) return 0;
  let editor = '';
  for (const row of lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1])) {
    // Copilot indents continuations by two columns and can consume the space after a chip label.
    const indented = row.startsWith('  ');
    const text = indented ? row.slice(2) : row;
    if (
      indented &&
      !text.startsWith(' ') &&
      chip.prefixes.some((prefix) => editor.endsWith(prefix.trimEnd()))
    ) {
      editor += ' ';
    }
    editor += text;
  }
  if (!editor.trimStart().startsWith(chip.prompt)) return 0;
  return chip.prefixes.reduce(
    (count, prefix) => count + editor.split(prefix + filename + ']').length - 1,
    0,
  );
}

export type ComposerGuard = (paneId?: string) => void;

async function resolveComposerPane(
  executor: ProcessExecutor,
  target: SessionTarget,
  signal: AbortSignal,
): Promise<PinnedPane> {
  const pane = await executor.run({
    argv: ['tmux', 'display-message', '-p', '-t', `=${target.name}:`, '#{pane_id}'],
    mode: 'pipe',
    signal,
  });
  const id = pane.stdout.trim();
  if (!pane.success || pane.timedOut || pane.truncated || !/^%\d+$/.test(id)) {
    throw new Error('Agent pane is unavailable');
  }
  return { name: target.name, paneId: id };
}

async function pasteComposerBuffer(
  executor: ProcessExecutor,
  pane: PinnedPane,
  text: string,
  assertCurrent: ComposerGuard,
  signal: AbortSignal,
): Promise<'delivered' | 'uncertain'> {
  const buffer = await prepareBuffer(executor, pane, text, true, signal);
  try {
    await requireForegroundProgram(executor, pane, signal);
    signal.throwIfAborted();
    assertCurrent(pane.paneId);
    try {
      await pasteBuffer(executor, buffer.name, pane.paneId, signal);
      return 'delivered';
    } catch {
      return 'uncertain';
    }
  } finally {
    discardComposerBuffer(executor, buffer.name);
  }
}

export async function pasteDraftText(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  assertCurrent: ComposerGuard,
  signal: AbortSignal,
): Promise<'delivered' | 'uncertain'> {
  const pane = await resolveComposerPane(executor, target, signal);
  const result = await pasteComposerBuffer(executor, pane, text, assertCurrent, signal);
  if (result === 'delivered')
    await delay(DEFAULT_POST_PASTE_DELAY_MS, undefined, { signal }).catch(() => undefined);
  return result;
}

export async function submitDraft(
  executor: ProcessExecutor,
  target: SessionTarget,
  assertCurrent: ComposerGuard,
  invalidate: () => void,
  signal: AbortSignal,
): Promise<'submitted' | 'uncertain'> {
  const pane = await resolveComposerPane(executor, target, signal);
  await requireForegroundProgram(executor, pane, signal);
  signal.throwIfAborted();
  assertCurrent(pane.paneId);
  try {
    const result = await executor.run({
      argv: ['tmux', 'send-keys', '-t', pane.paneId, 'Enter'],
      mode: 'pipe',
      signal,
    });
    return result.success && !result.timedOut ? 'submitted' : 'uncertain';
  } catch {
    return 'uncertain';
  } finally {
    invalidate();
  }
}

/** Called under the pane FIFO. The final guard and paste-buffer invocation must stay adjacent. */
export async function pasteDraftImage(
  executor: ProcessExecutor,
  target: SessionTarget,
  path: string,
  provider: string,
  assertCurrent: ComposerGuard,
  signal: AbortSignal,
): Promise<ImageWriteResult> {
  if (/[\u0000-\u001f\u007f]/u.test(path))
    throw new Error('Image path contains terminal control bytes');
  const traits = providerTraits(provider);
  const encoded =
    traits.fileUrlForEscapedImagePath && /["\\]/.test(path)
      ? pathToFileURL(path).href.replace(/'/g, '%27')
      : path.replace(/["\\]/g, '\\$&');
  const pane = await resolveComposerPane(executor, target, signal);
  const capture = (signal: AbortSignal) =>
    captureHistory(executor, pane, 0, false, { joinWrappedLines: true, signal });
  const filename = basename(path);
  const chip = traits.imagePasteChip;
  const before = chip ? await capture(signal) : null;
  if (before && !before.ok) throw new Error('Cannot inspect the active composer');
  const count = before && chip ? draftChipCount(before.output, filename, chip) : 0;
  const result = await pasteComposerBuffer(executor, pane, `"${encoded}"`, assertCurrent, signal);
  if (result === 'uncertain' || !chip) return result;
  const recognition = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
  try {
    while (!recognition.aborted) {
      assertCurrent(pane.paneId);
      const frame = await capture(recognition);
      if (!frame.ok) return 'unconfirmed';
      if (draftChipCount(frame.output, filename, chip) > count) return 'recognized';
      await delay(50, undefined, { signal: recognition });
    }
  } catch {
    return 'unconfirmed';
  }
  return 'unconfirmed';
}

/** `DeliveryOptions.firstMutationGuard` refused the first write; the pane is unchanged. */
export class DeliveryRefusedError extends Error {
  constructor(readonly sessionName: string) {
    super(`Delivery refused before the first write to session "${sessionName}"`);
    this.name = 'DeliveryRefusedError';
  }
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

export class ShellForegroundError extends Error {
  constructor(readonly sessionName: string) {
    super(`The CLI is not running in session "${sessionName}"; automated delivery refused`);
    this.name = 'ShellForegroundError';
  }
}

export async function requireForegroundProgram(
  executor: ProcessExecutor,
  target: SessionTarget | PinnedPane,
  signal?: AbortSignal,
): Promise<void> {
  const foreground = await readForegroundState(executor, target, signal);
  if (!foreground || foreground.shellInFront) {
    throw new ShellForegroundError(target.name);
  }
}

export class TypeCommandFailedError extends Error {
  constructor(
    readonly sessionName: string,
    readonly phase: 'length' | 'literal' | 'enter',
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

/**
 * Does every await that a guarded delivery needs before its first pane write. The caller runs
 * the guard right after this resolves and then writes with no await in between. With
 * `baselineAfterPreKeys` and pre-keys, the first write is a pre-key and `pasteAndSubmit` reads
 * the confirmation baseline after them, as an unguarded delivery does.
 */
async function prepareGuardedFirstWrite(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  options: {
    bracketed: boolean;
    confirm: boolean;
    preKeys?: readonly string[];
    baselineAfterPreKeys: boolean;
  },
  foregroundCheck?: ForegroundCheck,
): Promise<{ preparedBuffer: PreparedBuffer; confirmationBaseline?: ConfirmationBaseline }> {
  const confirmationBaseline =
    options.confirm && !(options.baselineAfterPreKeys && options.preKeys?.length)
      ? await captureConfirmationBaseline(executor, target)
      : undefined;
  const preparedBuffer = await prepareBuffer(executor, target, text, options.bracketed);
  try {
    await foregroundCheck?.();
  } catch (error) {
    await deleteBuffer(executor, preparedBuffer.name);
    throw error;
  }
  return { preparedBuffer, confirmationBaseline };
}

function deliverWithFirstMutationGuard(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: undefined,
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
): Promise<DeliveryResult>;
function deliverWithFirstMutationGuard(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: () => boolean,
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
  baselineAfterPreKeys?: boolean,
): Promise<GuardedDeliveryResult>;
async function deliverWithFirstMutationGuard(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: (() => boolean) | undefined,
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
  baselineAfterPreKeys = false,
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
    if (attempt === 0 && firstMutationGuard) {
      ({ preparedBuffer, confirmationBaseline } = await prepareGuardedFirstWrite(
        executor,
        target,
        textWithNonce,
        { bracketed, confirm, preKeys: options.preKeys, baselineAfterPreKeys },
        foregroundCheck,
      ));
      if (!firstMutationGuard()) {
        await deleteBuffer(executor, preparedBuffer.name);
        return { deferred: 'human_draft' };
      }
    }

    try {
      const result = await pasteAndSubmit(
        executor,
        target,
        textWithNonce,
        {
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
          followNote: options.followNote,
          // Prepared input lets the synchronous mutation fence protect the already-checked first write.
          firstWriteChecked: attempt === 0 && Boolean(firstMutationGuard),
          inputPromptMarker: options.inputPromptMarker,
        },
        foregroundCheck,
        submitGuard,
      );

      return { confirmed: true, nonce: lastNonce, retryCount: attempt, method: result.method };
    } catch (error) {
      if (error instanceof PasteNotConfirmedError && attempt < maxAttempts - 1) {
        await foregroundCheck?.();
        try {
          await sendKeys(executor, target, ['Escape']);
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      if (error instanceof PasteNotConfirmedError) {
        if (submitKeys.length > 0) await foregroundCheck?.();
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
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
): Promise<DeliveryResult> {
  if (!options.firstMutationGuard) {
    return deliverWithFirstMutationGuard(
      executor,
      gap,
      target,
      text,
      options,
      undefined,
      foregroundCheck,
      submitGuard,
    );
  }
  const result = await deliverWithFirstMutationGuard(
    executor,
    gap,
    target,
    text,
    options,
    options.firstMutationGuard,
    foregroundCheck,
    submitGuard,
    true,
  );
  if ('deferred' in result) throw new DeliveryRefusedError(target.name);
  return result;
}

export async function deliverGuarded(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  firstMutationGuard: () => boolean,
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
): Promise<GuardedDeliveryResult> {
  return deliverWithFirstMutationGuard(
    executor,
    gap,
    target,
    text,
    options,
    firstMutationGuard,
    foregroundCheck,
    submitGuard,
  );
}

export async function deliverImmediate(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  options: Omit<DeliveryOptions, 'agentId'>,
  foregroundCheck?: ForegroundCheck,
  submitGuard?: SubmitGuard,
): Promise<DeliveryResult> {
  const submitKeys = options.submitKeys ?? ['Enter'];
  const bracketed = options.bracketed ?? true;
  const postPasteDelayMs = clampDelay(options.postPasteDelayMs, DEFAULT_POST_PASTE_DELAY_MS);
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirm = options.confirm ?? false;

  const nonce = generateDeliveryNonce();
  const textWithNonce = confirm ? `${text}\n[MsgId:${nonce}]` : text;

  let prepared: Awaited<ReturnType<typeof prepareGuardedFirstWrite>> | undefined;
  if (options.firstMutationGuard) {
    prepared = await prepareGuardedFirstWrite(
      executor,
      target,
      textWithNonce,
      { bracketed, confirm, preKeys: options.preKeys, baselineAfterPreKeys: true },
      foregroundCheck,
    );
    if (!options.firstMutationGuard()) {
      await deleteBuffer(executor, prepared.preparedBuffer.name);
      throw new DeliveryRefusedError(target.name);
    }
  }

  const result = await pasteAndSubmit(
    executor,
    target,
    textWithNonce,
    {
      bracketed,
      submitKeys,
      preKeys: options.preKeys,
      preDelayMs: options.preDelayMs,
      postPasteDelayMs,
      confirm,
      nonce: confirm ? nonce : undefined,
      confirmTimeoutMs,
      followNote: options.followNote,
      inputPromptMarker: options.inputPromptMarker,
      preparedBuffer: prepared?.preparedBuffer,
      confirmationBaseline: prepared?.confirmationBaseline,
      // The guard above already ran the foreground check for the first write.
      firstWriteChecked: prepared !== undefined,
    },
    foregroundCheck,
    submitGuard,
  );

  return { confirmed: true, nonce, retryCount: 0, method: result.method };
}

export async function sendControl(
  executor: ProcessExecutor,
  target: SessionTarget,
  keys: readonly string[],
): Promise<void> {
  await sendKeys(executor, target, keys);
}
