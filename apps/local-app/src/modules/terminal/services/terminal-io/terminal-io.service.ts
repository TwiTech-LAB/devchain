import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../../common/logging/logger';
import { EventsService } from '../../../events/services/events.service';
import { ProcessExecutor } from '../process-executor/process-executor.port';
import type {
  SessionTarget,
  CreateSessionOptions,
  CaptureResult,
  CursorPosition,
  HealthResult,
  WaitForOutputOptions,
  DeliveryOptions,
  DeliveryResult,
  ExpectedSessionDestroyPolicy,
  ExpectedSessionDestroyResult,
} from './types';
import * as lifecycle from './lifecycle';
import * as capture from './capture';
import * as monitoring from './monitoring';
import * as deliveryMod from './delivery';
import type { SendGap } from './delivery';
import { TypeCommandFailedError } from './delivery';
import { quoteShellArg } from './quote-shell-arg';

const logger = createLogger('TerminalIOService');

interface HealthMonitorRecord {
  readonly token: number;
  readonly sessionName: string;
  readonly sessionId: string;
  readonly intervalMs: number;
  readonly fence: number;
  readonly interval: NodeJS.Timeout;
}

interface SessionLifecycleState {
  fence: number;
  tail: Promise<void>;
  pendingOperations: number;
  observers: number;
}

@Injectable()
export class TerminalIOService implements OnModuleDestroy {
  private readonly gap: SendGap;
  private readonly draftTracker = new PromptDraftTracker();
  private readonly paneWrites = new PaneWriteQueue();
  private readonly healthMonitors = new Map<string, HealthMonitorRecord>();
  private readonly lifecycleStates = new Map<string, SessionLifecycleState>();
  private nextMonitorToken = 0;
  private destroyed = false;

  constructor(
    private readonly executor: ProcessExecutor,
    private readonly eventsService: EventsService,
  ) {
    this.gap = new InMemorySendGap();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const monitor of this.healthMonitors.values()) {
      clearInterval(monitor.interval);
    }
    this.healthMonitors.clear();
    this.lifecycleStates.clear();
    this.gap.clear();
    this.draftTracker.clearAll();
    this.paneWrites.clear();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async createSession(
    name: string,
    command: string[],
    options: CreateSessionOptions,
  ): Promise<SessionTarget> {
    return lifecycle.createSession(this.executor, name, command, options);
  }

  async destroySession(target: SessionTarget): Promise<void> {
    this.draftTracker.clear(target.name);
    return lifecycle.destroySession(this.executor, target);
  }

  async destroyExpectedSession(
    target: SessionTarget,
    policy: ExpectedSessionDestroyPolicy,
  ): Promise<ExpectedSessionDestroyResult> {
    return this.runSerializedLifecycle(target.name, async (state) => {
      const retiredMonitor = this.healthMonitors.get(target.name);
      state.fence += 1;
      if (retiredMonitor) this.retireMonitor(retiredMonitor);

      const result = await lifecycle.destroyExpectedSession(this.executor, target);
      if (
        result.outcome === 'unknown-error' &&
        policy.onUnknownError === 'rearm' &&
        !this.destroyed &&
        !this.healthMonitors.has(target.name)
      ) {
        this.armHealthCheck(
          target.name,
          policy.sessionId,
          policy.intervalMs ?? retiredMonitor?.intervalMs ?? 5000,
          state,
        );
      }
      return result;
    });
  }

  async listSessions(): Promise<SessionTarget[]> {
    return lifecycle.listSessions(this.executor);
  }

  async sessionExists(target: SessionTarget): Promise<boolean> {
    return lifecycle.sessionExists(this.executor, target);
  }

  async createEmptySession(
    name: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<SessionTarget> {
    return lifecycle.createSession(this.executor, name, [], {
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env,
    });
  }

  /**
   * Explicitly set tmux's per-window alternate-screen option. `enabled=true` keeps
   * alt-screen on (full-screen TUI providers); `false` suppresses it (the default,
   * preserving scrollback for line-streaming CLIs). Setting it explicitly is
   * deterministic even when a global ~/.tmux.conf flips the option the other way.
   */
  async setAlternateScreen(target: SessionTarget, enabled: boolean): Promise<void> {
    await this.executor.run({
      argv: [
        'tmux',
        'set-window-option',
        '-t',
        `=${target.name}`,
        'alternate-screen',
        enabled ? 'on' : 'off',
      ],
      mode: 'pipe',
    });
  }

  async applyWindowTheme(
    target: SessionTarget,
    foreground: string,
    background: string,
  ): Promise<void> {
    return lifecycle.applyWindowTheme(this.executor, target, foreground, background);
  }

  async typeCommand(target: SessionTarget, argv: string[]): Promise<void> {
    if (!argv.length) throw new Error('Attempted to send empty argv command');

    await this.gap.ensureGap(target.name);

    const commandString = argv.map(quoteShellArg).join(' ');

    const literalResult = await this.executor.run({
      argv: ['tmux', 'send-keys', '-t', `=${target.name}:`, '-l', '--', commandString],
      mode: 'pipe',
    });
    if (!literalResult.success || literalResult.timedOut) {
      throw new TypeCommandFailedError(
        target.name,
        'literal',
        literalResult.timedOut
          ? 'timed out'
          : literalResult.stderr || `exit code ${literalResult.exitCode}`,
      );
    }

    const enterResult = await this.executor.run({
      argv: ['tmux', 'send-keys', '-t', `=${target.name}:`, 'Enter'],
      mode: 'pipe',
    });
    this.draftTracker.clear(target.name);
    if (!enterResult.success || enterResult.timedOut) {
      throw new TypeCommandFailedError(
        target.name,
        'enter',
        enterResult.timedOut
          ? 'timed out'
          : enterResult.stderr || `exit code ${enterResult.exitCode}`,
      );
    }
  }

  async listAllSessionNames(): Promise<Set<string>> {
    const result = await this.executor.run({
      argv: ['tmux', 'list-sessions', '-F', '#{session_name}'],
      mode: 'pipe',
    });
    if (!result.success) return new Set();
    return new Set(result.stdout.split('\n').filter(Boolean));
  }

  // ── Capture ─────────────────────────────────────────────────────────────

  async captureHistory(
    target: SessionTarget,
    lines = 2000,
    includeEscapes = true,
  ): Promise<CaptureResult> {
    return capture.captureHistory(this.executor, target, lines, includeEscapes);
  }

  async captureStrict(target: SessionTarget, tailLines = 10): Promise<CaptureResult> {
    return capture.captureStrict(this.executor, target, tailLines);
  }

  async getCursorPosition(target: SessionTarget): Promise<CursorPosition | null> {
    return capture.getCursorPosition(this.executor, target);
  }

  async getSessionCwd(target: SessionTarget): Promise<string | null> {
    return capture.getSessionCwd(this.executor, target);
  }

  // ── Monitoring ──────────────────────────────────────────────────────────

  async waitForOutput(
    target: SessionTarget,
    predicate: (output: string) => boolean,
    options?: WaitForOutputOptions,
  ): Promise<boolean> {
    return monitoring.waitForOutput(this.executor, target, predicate, options);
  }

  async healthCheck(target: SessionTarget): Promise<HealthResult> {
    return monitoring.healthCheck(this.executor, target);
  }

  startHealthCheck(sessionName: string, sessionId: string, intervalMs = 5000): void {
    const existing = this.healthMonitors.get(sessionName);
    if (existing) this.retireMonitor(existing);
    this.armHealthCheck(sessionName, sessionId, intervalMs, this.getLifecycleState(sessionName));
  }

  stopHealthCheck(sessionName: string): void {
    const monitor = this.healthMonitors.get(sessionName);
    if (monitor) this.retireMonitor(monitor);
    const state = this.lifecycleStates.get(sessionName);
    if (state) this.maybeDeleteLifecycleState(sessionName, state);
  }

  private armHealthCheck(
    sessionName: string,
    sessionId: string,
    intervalMs: number,
    state: SessionLifecycleState,
  ): void {
    const token = ++this.nextMonitorToken;
    const monitor: HealthMonitorRecord = {
      token,
      sessionName,
      sessionId,
      intervalMs,
      fence: state.fence,
      interval: setInterval(() => {
        void this.runHealthCheck(monitor).catch((error) => {
          logger.error(
            { sessionName, sessionId, token, fence: monitor.fence, error: String(error) },
            'Health check or crash publication failed',
          );
        });
      }, intervalMs),
    };
    monitor.interval.unref?.();
    this.healthMonitors.set(sessionName, monitor);
    logger.info(
      { sessionName, sessionId, token, fence: state.fence, intervalMs },
      'Started health check',
    );
  }

  private async runHealthCheck(monitor: HealthMonitorRecord): Promise<void> {
    const state = this.lifecycleStates.get(monitor.sessionName);
    if (!state || !this.isActiveMonitor(monitor, state)) return;

    state.observers += 1;
    try {
      const result = await this.healthCheck({ name: monitor.sessionName });
      if (result.alive || !this.isActiveMonitor(monitor, state)) return;

      await this.runSerializedLifecycle(monitor.sessionName, async (serializedState) => {
        if (!this.isActiveMonitor(monitor, serializedState)) return;

        this.retireMonitor(monitor);
        logger.warn(
          {
            sessionName: monitor.sessionName,
            sessionId: monitor.sessionId,
            token: monitor.token,
            fence: monitor.fence,
          },
          'Tmux session lost - publishing crashed event',
        );
        try {
          await this.eventsService.publish('session.crashed', {
            sessionId: monitor.sessionId,
            sessionName: monitor.sessionName,
          });
        } catch (error) {
          if (
            !this.destroyed &&
            serializedState.fence === monitor.fence &&
            !this.healthMonitors.has(monitor.sessionName)
          ) {
            this.armHealthCheck(
              monitor.sessionName,
              monitor.sessionId,
              monitor.intervalMs,
              serializedState,
            );
          }
          throw error;
        }
      });
    } finally {
      state.observers -= 1;
      this.maybeDeleteLifecycleState(monitor.sessionName, state);
    }
  }

  private isActiveMonitor(monitor: HealthMonitorRecord, state: SessionLifecycleState): boolean {
    return (
      this.healthMonitors.get(monitor.sessionName) === monitor && state.fence === monitor.fence
    );
  }

  private retireMonitor(monitor: HealthMonitorRecord): void {
    clearInterval(monitor.interval);
    if (this.healthMonitors.get(monitor.sessionName) !== monitor) return;
    this.healthMonitors.delete(monitor.sessionName);
    logger.info(
      {
        sessionName: monitor.sessionName,
        sessionId: monitor.sessionId,
        token: monitor.token,
        fence: monitor.fence,
      },
      'Stopped health check',
    );
  }

  private getLifecycleState(sessionName: string): SessionLifecycleState {
    const existing = this.lifecycleStates.get(sessionName);
    if (existing) return existing;
    const state: SessionLifecycleState = {
      fence: 0,
      tail: Promise.resolve(),
      pendingOperations: 0,
      observers: 0,
    };
    this.lifecycleStates.set(sessionName, state);
    return state;
  }

  private async runSerializedLifecycle<T>(
    sessionName: string,
    operation: (state: SessionLifecycleState) => Promise<T>,
  ): Promise<T> {
    const state = this.getLifecycleState(sessionName);
    state.pendingOperations += 1;
    const result = state.tail.then(() => operation(state));
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      state.pendingOperations -= 1;
      this.maybeDeleteLifecycleState(sessionName, state);
    }
  }

  private maybeDeleteLifecycleState(sessionName: string, state: SessionLifecycleState): void {
    if (
      this.lifecycleStates.get(sessionName) === state &&
      state.pendingOperations === 0 &&
      state.observers === 0 &&
      !this.healthMonitors.has(sessionName)
    ) {
      this.lifecycleStates.delete(sessionName);
    }
  }

  // ── Delivery ────────────────────────────────────────────────────────────

  async deliver(
    target: SessionTarget,
    text: string,
    options: DeliveryOptions,
  ): Promise<DeliveryResult> {
    return this.paneWrites.run(target.name, async () => {
      const hasPendingDraft = this.draftTracker.hasPendingDraft(target.name);
      logger.debug(
        {
          session: target.name,
          agentId: options.agentId,
          hasPendingDraft,
          hasDraftKeys: Boolean(options.draftKeys),
          multilineDraft: this.draftTracker.hasMultilineDraft(target.name),
          preservesDraft:
            hasPendingDraft &&
            Boolean(options.draftKeys) &&
            !this.draftTracker.hasMultilineDraft(target.name),
        },
        'Delivering to pane',
      );
      const result = await deliveryMod.deliver(this.executor, this.gap, target, text, options, {
        hasPendingDraft,
        draftProbe: this.draftTracker.draftProbe(target.name),
        multilineDraft: this.draftTracker.hasMultilineDraft(target.name),
      });
      this.noteDeliveryCommitted(target, options, hasPendingDraft);
      return result;
    });
  }

  async deliverImmediate(
    target: SessionTarget,
    text: string,
    options: Omit<DeliveryOptions, 'agentId'>,
  ): Promise<DeliveryResult> {
    return this.paneWrites.run(target.name, async () => {
      const hasPendingDraft = this.draftTracker.hasPendingDraft(target.name);
      const result = await deliveryMod.deliverImmediate(this.executor, target, text, options, {
        hasPendingDraft,
        draftProbe: this.draftTracker.draftProbe(target.name),
        multilineDraft: this.draftTracker.hasMultilineDraft(target.name),
      });
      if (!hasPendingDraft || !options.draftKeys) {
        // No draft was preserved, so the pasted text simply joined whatever is in
        // the prompt: it is a new draft when nothing submits it, and otherwise the
        // submit left the prompt empty.
        if ((options.submitKeys ?? ['Enter']).length === 0) {
          this.draftTracker.noteDraftContent(target.name, text);
        } else {
          this.draftTracker.clear(target.name);
        }
      }
      return result;
    });
  }

  async sendControl(target: SessionTarget, keys: readonly string[]): Promise<void> {
    // Queued behind any injection in flight, so the user's keystrokes cannot land
    // between a stashed draft and the submit that follows it. They are held, not
    // dropped, and replay in the order they were typed.
    return this.paneWrites.run(target.name, async () => {
      this.draftTracker.noteTypedKeys(target.name, keys);
      return deliveryMod.sendControl(this.executor, target, keys);
    });
  }

  /**
   * A delivery that ends in a submit key leaves the prompt empty — unless the
   * draft-preserving path ran, which puts the user's text back.
   */
  private noteDeliveryCommitted(
    target: SessionTarget,
    options: Omit<DeliveryOptions, 'agentId'>,
    preservedDraft: boolean,
  ): void {
    if (preservedDraft && options.draftKeys) return;
    if ((options.submitKeys ?? ['Enter']).length === 0) return;
    this.draftTracker.clear(target.name);
  }
}

/**
 * Serializes writes to a pane, one at a time, in the order they were requested.
 *
 * The pane is written to by both the user (keystrokes forwarded from a terminal
 * view) and by delivery. A draft-preserving delivery has to clear the prompt,
 * paste, wait for the provider to assemble the paste, and only then submit — so
 * for the length of that window a keystroke arriving in between would be caught
 * by the submit. Queuing holds those keystrokes and replays them afterwards
 * instead, which costs the typist the duration of an injection in latency and is
 * the reason the injection is kept as short as it can be.
 */
class PaneWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(pane: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(pane) ?? Promise.resolve();
    // `task` runs whether or not the previous write settled: one failed write
    // must not strand everything queued behind it.
    const result = previous.then(task, task);
    const tail: Promise<void> = result.then(
      () => {},
      () => {},
    );
    this.tails.set(pane, tail);
    void tail.then(() => {
      if (this.tails.get(pane) === tail) this.tails.delete(pane);
    });
    return result;
  }

  clear(): void {
    this.tails.clear();
  }
}

/** How much of a draft's start to remember, for verifying that a stash worked. */
const DRAFT_PROBE_CHARS = 32;
/**
 * Shorter than this and a probe risks matching unrelated text in a capture. Kept
 * low deliberately: a draft of "line 1" has to be long enough to check, and a
 * false match only costs preservation — delivery then behaves as it always did.
 */
const DRAFT_PROBE_MIN_CHARS = 4;

/** tmux key names that leave the provider's prompt empty. */
const PROMPT_CLEARING_KEYS: ReadonlySet<string> = new Set(['Enter', 'Escape', 'C-c', 'C-u', 'C-g']);
/** The same actions as raw bytes, for input forwarded literally. */
const PROMPT_CLEARING_BYTES: ReadonlySet<string> = new Set(['\r', '\n', '\x1b', '\x03', '\x15']);

/**
 * Tracks, per pane, whether the user has typed something they have not submitted
 * yet. Delivery needs this: stashing and restoring a draft that is not there
 * would yank stale text out of the provider's kill ring and into the prompt.
 *
 * Every write DevChain makes to a pane passes through TerminalIOService, so this
 * sees the input it forwards — but not input from a terminal attached to tmux
 * directly, which reaches the pty without passing here. For those there is no
 * draft to know about and delivery behaves as it did before. Only a length and a
 * short prefix are kept, never the whole draft: the provider's own kill ring does
 * the stashing, so all this needs to answer is whether something is there and
 * whether it went away.
 *
 * It is an approximation: editing keys DevChain does not model (word kills,
 * history recall) can leave the count non-zero over an empty prompt. The
 * consequence is bounded — a stash/restore that yanks previously killed text
 * back into the prompt, visible to the user and never submitted on its own —
 * whereas missing a real draft merges it into an agent's message.
 */
class PromptDraftTracker {
  private readonly pendingChars = new Map<string, number>();
  private readonly probes = new Map<string, string>();
  private readonly multiline = new Set<string>();

  hasPendingDraft(pane: string): boolean {
    return (this.pendingChars.get(pane) ?? 0) > 0;
  }

  /**
   * The start of the draft, for checking afterwards that a stash really cleared
   * the prompt. The START specifically: the stash keys clear a single line, so a
   * multiline draft keeps its first line, and looking for the beginning of the
   * text is what catches that.
   */
  /**
   * Whether the draft is known to span more than one line. The stash keys clear a
   * single line, so such a draft cannot be moved aside and delivery must not try.
   */
  hasMultilineDraft(pane: string): boolean {
    return this.multiline.has(pane);
  }

  draftProbe(pane: string): string | undefined {
    const probe = this.probes.get(pane);
    return probe && probe.length >= DRAFT_PROBE_MIN_CHARS ? probe : undefined;
  }

  /** Input the user typed, as the argv tail of a `tmux send-keys` call. */
  noteTypedKeys(pane: string, keys: readonly string[]): void {
    if (keys.length === 0) return;

    // `send-keys -l -- <text>`: characters forwarded literally.
    if (keys[0] === '-l') {
      this.noteTypedText(pane, keys[keys.length - 1] ?? '');
      return;
    }
    if (keys.some((key) => PROMPT_CLEARING_KEYS.has(key))) {
      this.clear(pane);
      return;
    }
    if (keys.includes('BSpace')) this.add(pane, -1);
  }

  /**
   * Text the user typed. A submit at the end of the chunk empties the prompt;
   * terminals batch fast typing, so `abc\r` has to count as a submit too.
   */
  private noteTypedText(pane: string, text: string): void {
    if (text.length === 0) return;
    // An escape-prefixed return is how terminals send the "insert a newline"
    // binding (alt/shift+enter). It grows the draft rather than submitting it, and
    // reading it as a submit would lose track of the draft entirely.
    if (/^\x1b[\r\n]$/.test(text)) {
      this.add(pane, 1);
      this.markMultiline(pane);
      return;
    }
    if (text.endsWith('\r') || text.endsWith('\n')) {
      this.clear(pane);
      return;
    }
    if (text.length === 1 && PROMPT_CLEARING_BYTES.has(text)) {
      this.clear(pane);
      return;
    }
    this.add(pane, text.length);
    this.extendProbe(pane, text);
  }

  /**
   * Text placed into the prompt without submitting it (a paste). Never a submit,
   * whatever it contains — so newlines in it are draft content, not a commit.
   */
  noteDraftContent(pane: string, text: string): void {
    this.add(pane, text.length);
    this.noteNewlinesIn(pane, text);
    this.extendProbe(pane, text);
  }

  clear(pane: string): void {
    this.pendingChars.delete(pane);
    this.probes.delete(pane);
    this.multiline.delete(pane);
  }

  clearAll(): void {
    this.pendingChars.clear();
    this.probes.clear();
    this.multiline.clear();
  }

  private markMultiline(pane: string): void {
    this.multiline.add(pane);
  }

  private noteNewlinesIn(pane: string, text: string): void {
    if (/[\r\n]/.test(text)) this.markMultiline(pane);
  }

  private extendProbe(pane: string, text: string): void {
    const current = this.probes.get(pane) ?? '';
    if (current.length >= DRAFT_PROBE_CHARS) return;
    // Only the first line is usable: the capture it gets compared against holds
    // one prompt line at a time.
    const firstLine = (current + text).slice(0, DRAFT_PROBE_CHARS).split(/[\r\n]/)[0] ?? '';
    this.probes.set(pane, firstLine);
  }

  private add(pane: string, delta: number): void {
    const next = (this.pendingChars.get(pane) ?? 0) + delta;
    if (next <= 0) this.pendingChars.delete(pane);
    else this.pendingChars.set(pane, next);
  }
}

class InMemorySendGap implements SendGap {
  private lastByAgent = new Map<string, number>();
  private tailByAgent = new Map<string, Promise<void>>();
  private expiryByAgent = new Map<string, NodeJS.Timeout>();
  private destroyed = false;

  async ensureGap(agentId: string, minMs = 500): Promise<void> {
    const prev = this.tailByAgent.get(agentId) ?? Promise.resolve();

    const next = prev.then(async () => {
      const now = Date.now();
      const last = this.lastByAgent.get(agentId) ?? 0;
      const delta = now - last;
      if (delta < minMs) {
        await new Promise((r) => setTimeout(r, minMs - delta));
      }
      this.lastByAgent.set(agentId, Date.now());
    });

    const tail = next.catch(() => {});
    this.tailByAgent.set(agentId, tail);
    void tail.finally(() => {
      if (this.tailByAgent.get(agentId) === tail) this.tailByAgent.delete(agentId);
      if (this.destroyed) return;
      const existingExpiry = this.expiryByAgent.get(agentId);
      if (existingExpiry) clearTimeout(existingExpiry);
      const expiry = setTimeout(
        () => {
          this.lastByAgent.delete(agentId);
          this.expiryByAgent.delete(agentId);
        },
        5 * 60 * 1000,
      );
      expiry.unref();
      this.expiryByAgent.set(agentId, expiry);
    });
    return next;
  }

  clear(): void {
    this.destroyed = true;
    for (const expiry of this.expiryByAgent.values()) clearTimeout(expiry);
    this.expiryByAgent.clear();
    this.lastByAgent.clear();
    this.tailByAgent.clear();
  }
}
