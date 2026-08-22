import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
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
  GuardedDeliveryResult,
  GuardedDeliveryMutationFence,
} from './types';
import * as lifecycle from './lifecycle';
import * as capture from './capture';
import * as monitoring from './monitoring';
import * as deliveryMod from './delivery';
import type { SendGap } from './delivery';
import { TypeCommandFailedError } from './delivery';
import { quoteShellArg } from './quote-shell-arg';
import {
  HumanPromptStateService,
  type HumanPromptQuietSnapshot,
  sanitizeTmuxSessionName,
} from '../human-prompt-state.service';

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

interface PaneDeliveryState {
  tail: Promise<void>;
  pendingOperations: number;
}

export class TerminalIOClosingError extends Error {
  constructor() {
    super('Terminal IO is shutting down');
    this.name = 'TerminalIOClosingError';
  }
}

@Injectable()
export class TerminalIOService implements BeforeApplicationShutdown {
  private readonly gap: SendGap;
  private readonly healthMonitors = new Map<string, HealthMonitorRecord>();
  private readonly lifecycleStates = new Map<string, SessionLifecycleState>();
  private readonly paneDeliveryStates = new Map<string, PaneDeliveryState>();
  private nextMonitorToken = 0;
  private destroyed = false;
  private closing = false;

  constructor(
    private readonly executor: ProcessExecutor,
    private readonly eventsService: EventsService,
    private readonly humanPromptState: HumanPromptStateService,
  ) {
    this.gap = new InMemorySendGap();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    this.destroyed = true;
    for (const monitor of this.healthMonitors.values()) {
      clearInterval(monitor.interval);
    }
    this.healthMonitors.clear();

    const deliveryTails = [...this.paneDeliveryStates.values()].map((state) => state.tail);
    if (deliveryTails.length > 0) {
      await Promise.all(deliveryTails);
    }

    this.paneDeliveryStates.clear();
    this.lifecycleStates.clear();
    this.gap.clear();
    this.humanPromptState.clear();
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
    await lifecycle.destroySession(this.executor, target);
    this.humanPromptState.clearSession(target.name);
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
      if (result.outcome !== 'unknown-error' || policy.onUnknownError === 'retire') {
        this.humanPromptState.clearSession(target.name);
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
    return this.runPaneOperation(target, () =>
      deliveryMod.deliver(this.executor, this.gap, target, text, options),
    );
  }

  async deliverImmediate(
    target: SessionTarget,
    text: string,
    options: Omit<DeliveryOptions, 'agentId'>,
  ): Promise<DeliveryResult> {
    return this.runPaneOperation(target, () =>
      deliveryMod.deliverImmediate(this.executor, target, text, options),
    );
  }

  async sendControl(target: SessionTarget, keys: readonly string[]): Promise<void> {
    return this.runPaneOperation(target, () =>
      deliveryMod.sendControl(this.executor, target, keys),
    );
  }

  async deliverGuarded(
    target: SessionTarget,
    text: string,
    options: DeliveryOptions,
    quietSnapshot: HumanPromptQuietSnapshot | undefined,
    mutationFence?: GuardedDeliveryMutationFence,
  ): Promise<GuardedDeliveryResult> {
    return this.runPaneOperation<GuardedDeliveryResult>(target, () =>
      deliveryMod.deliverGuarded(this.executor, this.gap, target, text, options, () => {
        // Cancellation, prompt release, and claim mutation form one synchronous commit boundary.
        if (mutationFence && !mutationFence.canStartMutation()) return false;
        if (quietSnapshot && !this.humanPromptState.releaseIfQuiet(target.name, quietSnapshot)) {
          return false;
        }
        mutationFence?.markMutationStarted();
        return true;
      }),
    );
  }

  private runPaneOperation<T>(target: SessionTarget, operation: () => Promise<T> | T): Promise<T> {
    if (this.closing) return Promise.reject(new TerminalIOClosingError());

    const key = sanitizeTmuxSessionName(target.name);
    if (!key) return Promise.reject(new Error('Tmux session name must contain a safe character'));

    let state = this.paneDeliveryStates.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), pendingOperations: 0 };
      this.paneDeliveryStates.set(key, state);
    }

    state.pendingOperations += 1;
    const result = state.tail.then(operation);
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      state.pendingOperations -= 1;
      if (state.pendingOperations === 0 && this.paneDeliveryStates.get(key) === state) {
        this.paneDeliveryStates.delete(key);
      }
    });
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
