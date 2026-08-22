import type { ProcessExecutor } from '../process-executor/process-executor.port';
import type { SessionTarget, DeliveryOptions, DeliveryResult, PromptDraftKeys } from './types';
import { captureStrict } from './capture';
import { generateDeliveryNonce } from '../../../../common/delivery-nonce';

const DEFAULT_POST_PASTE_DELAY_MS = 250;
const MAX_POST_PASTE_DELAY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_CONFIRM_TIMEOUT_MS = 2000;
const CONFIRM_POLL_INTERVAL_MS = 150;
const CONFIRM_TAIL_LINES = 10;
/**
 * Pause after a key send that changes the prompt, before a paste is issued into
 * it. Covers both the provider applying the keys and the fact that keys and
 * pastes reach the pane by different routes.
 */
const KEY_SETTLE_MS = 150;
/**
 * Pause after the submit, before the draft is yanked back. Submitting sends the
 * provider into a re-render, during which a yank arriving immediately is dropped
 * and the draft stays in the kill ring instead of the prompt.
 */
const SUBMIT_SETTLE_MS = 250;
/** How long to keep looking for the restored draft before repairing it. */
const RESTORE_CONFIRM_TIMEOUT_MS = 1500;

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

/**
 * Poll until the pane shows `probe`. A restored draft can take a moment to render,
 * and a slow render is indistinguishable from a lost yank at any single instant —
 * which is exactly the mistake that produced both an empty prompt and a doubled
 * one, depending on which way the race fell.
 */
async function waitForPaneText(
  executor: ProcessExecutor,
  target: SessionTarget,
  probe: string,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    const capture = await captureStrict(executor, target, CONFIRM_TAIL_LINES);
    if (capture.ok && capture.output.includes(probe)) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS));
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

/**
 * Deliver into a pane that currently holds an unsent user draft.
 *
 * The prompt is a shared surface: the user types into the same pane we inject
 * into. Submitting a message therefore commits whatever the user has typed so
 * far along with it, and their remaining keystrokes become a second, contextless
 * message. To avoid that, the draft is stashed out of the prompt, the message is
 * pasted and submitted alone, and the draft is put back.
 *
 * Keys and pastes do not reach the pane by the same route. `send-keys` goes
 * through tmux's key handling, which a pane in copy-mode consumes for its own
 * bindings, while `paste-buffer` writes into the application regardless. A pane
 * enters copy-mode whenever the user scrolls it. So a stash issued into a pane in
 * copy-mode silently does nothing while the paste still lands — at the text
 * cursor, in the middle of the draft, which is then submitted around it.
 *
 * Each step is therefore issued on its own and checked, and the provider is given
 * time to apply it before the next:
 *
 *   1. cancel any tmux mode — otherwise the keys below go to copy-mode
 *   2. stash, then check the pane changed and no longer shows the draft's start
 *   3. paste, then wait for the provider to assemble it
 *   4. confirm — the message is still unsubmitted, so a paste that never landed
 *      is caught before anything is committed
 *   5. submit, wait out the re-render it triggers, then restore; a yank sent into
 *      that re-render is dropped, leaving the draft in the kill ring
 *
 * The restore is polled for rather than checked once, because a slow render and a
 * lost yank look identical at any single instant. If it really did not arrive, a
 * stash-then-restore repairs it: that holds whether the draft is absent or merely
 * rendered late, so the prompt ends up with exactly one copy either way.
 *
 * When the stash cannot be verified, whatever it took is handed back and the
 * caller is told, which falls back to delivering without preservation: the message
 * still arrives, merged into the draft as it was before this path existed. Every
 * failure degrades to the old behaviour rather than to a lost, doubled, or
 * corrupted message.
 *
 * A draft spanning several lines never reaches here — the stash keys clear one
 * line, so it cannot be moved aside at all.
 */
async function pasteAndSubmitPreservingDraft(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  options: {
    bracketed: boolean;
    submitKeys: readonly string[];
    draftKeys: PromptDraftKeys;
    draftProbe?: string;
    postPasteDelayMs: number;
    nonce?: string;
    confirmTimeoutMs: number;
  },
): Promise<{
  confirmed: boolean;
  stashFailed?: boolean;
  method?: 'nonce' | 'paste_indicator' | 'paste_changed';
}> {
  const paneTarget = `=${target.name}:`;
  const commandList = (commands: ReadonlyArray<readonly string[]>): string[] => {
    const argv: string[] = ['tmux'];
    for (const command of commands) {
      if (argv.length > 1) argv.push(';');
      argv.push(...command);
    }
    return argv;
  };
  const runCommandList = async (
    commands: ReadonlyArray<readonly string[]>,
    phase: string,
  ): Promise<void> => {
    if (commands.length === 0) return;
    const result = await executor.run({ argv: commandList(commands), mode: 'pipe' });
    if (!result.success) {
      throw new Error(
        `Failed to ${phase} for draft-preserving delivery to "${target.name}": ${result.stderr}`,
      );
    }
  };
  const sendKeysCommand = (keys: readonly string[]): string[][] =>
    keys.map((key) => ['send-keys', '-t', paneTarget, key]);

  // A pane in copy-mode eats the stash keys, so leave any mode before sending them.
  await runCommandList(
    [
      [
        'if-shell',
        '-F',
        '-t',
        paneTarget,
        '#{pane_in_mode}',
        `send-keys -X -t '${paneTarget}' cancel`,
      ],
    ],
    'leave any tmux mode',
  );

  const beforeStash = await captureStrict(executor, target, CONFIRM_TAIL_LINES);
  const baseline = beforeStash.ok ? beforeStash.output : undefined;

  const prepared = text.replace(/\r?\n/g, '\r');
  const payload = options.bracketed ? `\x1b[200~${prepared}\x1b[201~` : prepared;

  const safeSession = target.name.replace(/[^a-zA-Z0-9_.-]/g, '');
  const bufferName = `devchain-${safeSession}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  await runCommandList(sendKeysCommand(options.draftKeys.stash), 'stash the draft');
  await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));

  // Two ways the stash can fall short, both of which would drop the message into
  // the middle of the draft if we pasted now: the keys never reached the provider
  // (an unchanged pane), or they cleared only part of the draft — the stash keys
  // act on one line, so a multiline draft keeps its other lines. Either way, give
  // up on preserving and let the caller deliver the ordinary way.
  const afterStash = await captureStrict(executor, target, CONFIRM_TAIL_LINES);
  if (afterStash.ok) {
    const unchanged = baseline !== undefined && afterStash.output === baseline;
    const draftStillVisible =
      options.draftProbe !== undefined && afterStash.output.includes(options.draftProbe);
    if (unchanged || draftStillVisible) {
      // A partial stash has part of the draft in the kill ring; hand it back before
      // giving up, or the ordinary delivery would submit the draft without it. When
      // the pane never changed nothing was killed, and yanking then would pull
      // whatever the ring held from before into the prompt.
      if (!unchanged) {
        await runCommandList(sendKeysCommand(options.draftKeys.restore), 'undo a partial stash');
      }
      return { confirmed: false, stashFailed: true };
    }
  }

  await loadBuffer(executor, bufferName, payload);
  try {
    await runCommandList(
      [['paste-buffer', '-b', bufferName, '-t', target.name]],
      'paste the message',
    );
  } finally {
    await deleteBuffer(executor, bufferName);
  }

  if (options.postPasteDelayMs > 0) {
    await new Promise((r) => setTimeout(r, options.postPasteDelayMs));
  }

  let method: 'nonce' | 'paste_indicator' | 'paste_changed' | undefined;
  if (options.nonce) {
    const confirmation = await confirmPasteDelivery(
      executor,
      target,
      options.nonce,
      baseline,
      options.confirmTimeoutMs,
    );
    if (!confirmation.confirmed && !confirmation.captureError) {
      // Nothing has been submitted: give the draft back and report the failure.
      await runCommandList(sendKeysCommand(options.draftKeys.restore), 'restore the draft');
      return { confirmed: false };
    }
    method = confirmation.method;
  }

  await runCommandList(sendKeysCommand(options.submitKeys), 'submit the message');

  // The submit puts the provider into a re-render; a yank sent into that is lost.
  await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS));
  await runCommandList(sendKeysCommand(options.draftKeys.restore), 'restore the draft');

  // The draft only exists in the provider's kill ring now, so a yank the provider
  // dropped would leave the prompt empty.
  if (options.draftProbe !== undefined) {
    const restored = await waitForPaneText(
      executor,
      target,
      options.draftProbe,
      RESTORE_CONFIRM_TIMEOUT_MS,
    );
    if (!restored) {
      // Stash-then-restore rather than a second bare yank: if the draft is in fact
      // there and merely rendered late, the stash takes it back into the kill ring
      // and the yank returns it, so either way the prompt ends up holding exactly
      // one copy. A second bare yank would append another.
      await runCommandList(sendKeysCommand(options.draftKeys.stash), 'restash before repair');
      await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
      await runCommandList(sendKeysCommand(options.draftKeys.restore), 'repair the restore');
    }
  }

  return { confirmed: true, method };
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
  },
): Promise<{ method?: 'nonce' | 'paste_indicator' | 'paste_changed' }> {
  if (options.preKeys?.length) {
    await sendKeys(executor, target, options.preKeys);
    if (options.preDelayMs && options.preDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.preDelayMs));
    }
  }

  let baseline: string | undefined;
  if (options.confirm && options.nonce) {
    const baselineResult = await captureStrict(executor, target, CONFIRM_TAIL_LINES);
    if (baselineResult.ok) {
      baseline = baselineResult.output;
    }
  }

  const prepared = text.replace(/\r?\n/g, '\r');
  const payload = options.bracketed ? `\x1b[200~${prepared}\x1b[201~` : prepared;

  const safeSession = target.name.replace(/[^a-zA-Z0-9_.-]/g, '');
  const bufferName = `devchain-${safeSession}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  await loadBuffer(executor, bufferName, payload);
  await pasteBuffer(executor, bufferName, target.name);
  await deleteBuffer(executor, bufferName);

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

/**
 * Live pane state, as opposed to caller intent in `DeliveryOptions`. Tracked by
 * `TerminalIOService`, which sees every write to a pane.
 */
export interface DeliveryRuntimeState {
  /** The pane holds text the user has typed but not yet submitted. */
  readonly hasPendingDraft?: boolean;
  /** The start of that draft, used to verify the stash cleared the prompt. */
  readonly draftProbe?: string;
  /**
   * The draft spans more than one line. The stash keys clear a single line, so
   * such a draft cannot be moved aside and delivery does not try.
   */
  readonly multilineDraft?: boolean;
}

export async function deliver(
  executor: ProcessExecutor,
  gap: SendGap,
  target: SessionTarget,
  text: string,
  options: DeliveryOptions,
  runtime: DeliveryRuntimeState = {},
): Promise<DeliveryResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const submitKeys = options.submitKeys ?? ['Enter'];
  const bracketed = options.bracketed ?? true;
  const postPasteDelayMs = clampDelay(options.postPasteDelayMs, DEFAULT_POST_PASTE_DELAY_MS);
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirm = options.confirm ?? true;

  // `preKeys` belongs to the launch handshake, which runs before any user can
  // have typed; leave that path exactly as it was rather than reordering it.
  const draftKeys =
    runtime.hasPendingDraft && !runtime.multilineDraft && !options.preKeys?.length
      ? options.draftKeys
      : undefined;
  if (draftKeys) {
    const nonce = generateDeliveryNonce();
    await gap.ensureGap(options.agentId);
    const preserved = await pasteAndSubmitPreservingDraft(
      executor,
      target,
      `${text}\n[MsgId:${nonce}]`,
      {
        bracketed,
        submitKeys,
        draftKeys,
        draftProbe: runtime.draftProbe,
        postPasteDelayMs,
        nonce: confirm ? nonce : undefined,
        confirmTimeoutMs,
      },
    );
    // A stash that could not be verified leaves the draft untouched, so fall
    // through to ordinary delivery rather than dropping the message.
    if (!preserved.stashFailed) {
      return { confirmed: preserved.confirmed, nonce, retryCount: 0, method: preserved.method };
    }
  }

  let lastNonce = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastNonce = generateDeliveryNonce();
    const textWithNonce = `${text}\n[MsgId:${lastNonce}]`;

    try {
      await gap.ensureGap(options.agentId);

      const result = await pasteAndSubmit(executor, target, textWithNonce, {
        bracketed,
        submitKeys,
        preKeys: attempt === 0 ? options.preKeys : undefined,
        preDelayMs: options.preDelayMs,
        postPasteDelayMs,
        confirm,
        nonce: lastNonce,
        confirmTimeoutMs,
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

export async function deliverImmediate(
  executor: ProcessExecutor,
  target: SessionTarget,
  text: string,
  options: Omit<DeliveryOptions, 'agentId'>,
  runtime: DeliveryRuntimeState = {},
): Promise<DeliveryResult> {
  const submitKeys = options.submitKeys ?? ['Enter'];
  const bracketed = options.bracketed ?? true;
  const postPasteDelayMs = clampDelay(options.postPasteDelayMs, DEFAULT_POST_PASTE_DELAY_MS);
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirm = options.confirm ?? false;

  const nonce = generateDeliveryNonce();
  const textWithNonce = confirm ? `${text}\n[MsgId:${nonce}]` : text;

  // `preKeys` belongs to the launch handshake, which runs before any user can
  // have typed; leave that path exactly as it was rather than reordering it.
  const draftKeys =
    runtime.hasPendingDraft && !options.preKeys?.length ? options.draftKeys : undefined;
  if (draftKeys) {
    const preserved = await pasteAndSubmitPreservingDraft(executor, target, textWithNonce, {
      bracketed,
      submitKeys,
      draftKeys,
      draftProbe: runtime.draftProbe,
      postPasteDelayMs,
      nonce: confirm ? nonce : undefined,
      confirmTimeoutMs,
    });
    // A stash that could not be verified leaves the draft untouched, so fall
    // through to ordinary delivery rather than dropping the message.
    if (!preserved.stashFailed) {
      return { confirmed: preserved.confirmed, nonce, retryCount: 0, method: preserved.method };
    }
  }

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
