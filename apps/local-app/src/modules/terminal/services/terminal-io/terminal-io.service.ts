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
} from './types';
import * as lifecycle from './lifecycle';
import * as capture from './capture';
import * as monitoring from './monitoring';
import * as deliveryMod from './delivery';
import type { SendGap } from './delivery';
import { TypeCommandFailedError } from './delivery';
import { quoteShellArg } from './quote-shell-arg';

const logger = createLogger('TerminalIOService');

@Injectable()
export class TerminalIOService implements OnModuleDestroy {
  private readonly gap: SendGap;
  private readonly healthCheckIntervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly executor: ProcessExecutor,
    private readonly eventsService: EventsService,
  ) {
    this.gap = new InMemorySendGap();
  }

  onModuleDestroy(): void {
    for (const interval of this.healthCheckIntervals.values()) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();
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
    return lifecycle.destroySession(this.executor, target);
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

  async disableAlternateScreen(target: SessionTarget): Promise<void> {
    await this.executor.run({
      argv: ['tmux', 'set-window-option', '-t', `=${target.name}`, 'alternate-screen', 'off'],
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
    this.stopHealthCheck(sessionName);

    const interval = setInterval(async () => {
      try {
        const result = await this.healthCheck({ name: sessionName });
        if (!result.alive) {
          logger.warn({ sessionName, sessionId }, 'Tmux session lost - emitting crashed event');
          await this.eventsService.publish('session.crashed', { sessionId, sessionName });
          this.stopHealthCheck(sessionName);
        }
      } catch (error) {
        logger.error({ sessionName, sessionId, error: String(error) }, 'Health check failed');
      }
    }, intervalMs);

    this.healthCheckIntervals.set(sessionName, interval);
    logger.info({ sessionName, intervalMs }, 'Started health check');
  }

  stopHealthCheck(sessionName: string): void {
    const interval = this.healthCheckIntervals.get(sessionName);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(sessionName);
      logger.info({ sessionName }, 'Stopped health check');
    }
  }

  // ── Delivery ────────────────────────────────────────────────────────────

  async deliver(
    target: SessionTarget,
    text: string,
    options: DeliveryOptions,
  ): Promise<DeliveryResult> {
    return deliveryMod.deliver(this.executor, this.gap, target, text, options);
  }

  async deliverImmediate(
    target: SessionTarget,
    text: string,
    options: Omit<DeliveryOptions, 'agentId'>,
  ): Promise<DeliveryResult> {
    return deliveryMod.deliverImmediate(this.executor, target, text, options);
  }

  async sendControl(target: SessionTarget, keys: readonly string[]): Promise<void> {
    return deliveryMod.sendControl(this.executor, target, keys);
  }
}

class InMemorySendGap implements SendGap {
  private lastByAgent = new Map<string, number>();
  private tailByAgent = new Map<string, Promise<void>>();

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

    this.tailByAgent.set(
      agentId,
      next.catch(() => {}),
    );
    return next;
  }
}
