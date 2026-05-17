import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SessionsService } from './sessions.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { MessageActivityStreamService } from './message-activity-stream.service';
import { MessageLogService } from './message-log.service';
import { DeliveryFailureNotifierService } from './delivery-failure-notifier.service';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type AgentStorage } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import {
  type MessagePoolConfig,
  type PooledMessage,
  type EnqueueOptions,
  type EnqueueResult,
  type FlushResult,
  type DeliveryFailureCode,
  type MessageLogEntry,
  type PoolDetails,
} from './message-pool.types';
export {
  FAILURE_NOTICE_SOURCE,
  type MessagePoolConfig,
  type PooledMessage,
  type EnqueueOptions,
  type EnqueueResult,
  type FlushResult,
  type DeliveryFailureCode,
  type MessageLogEntry,
  type PoolDetails,
} from './message-pool.types';

const logger = createLogger('SessionsMessagePoolService');

interface AgentPool {
  messages: PooledMessage[];
  timer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
  firstEnqueueTime: number;
  config: MessagePoolConfig;
  projectId: string;
}

const DEFAULT_CONFIG: MessagePoolConfig = {
  enabled: true,
  delayMs: 10000,
  maxWaitMs: 30000,
  maxMessages: 10,
  separator: '\n---\n',
};

@Injectable()
export class SessionsMessagePoolService implements OnModuleDestroy {
  private pools = new Map<string, AgentPool>();
  private config: MessagePoolConfig;

  constructor(
    private readonly sessions: SessionsService,
    private readonly coordinator: SessionCoordinatorService,
    private readonly terminalIO: TerminalIOService,
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: AgentStorage,
    private readonly activityStream: MessageActivityStreamService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly messageLog: MessageLogService,
    private readonly failureNotifier: DeliveryFailureNotifierService,
  ) {
    this.config = this.loadConfigFromSettings();
    logger.info({ config: this.config }, 'SessionsMessagePoolService initialized with config');
  }

  private loadConfigFromSettings(): MessagePoolConfig {
    try {
      const settingsConfig = this.settings.getMessagePoolConfig();
      return {
        enabled: settingsConfig.enabled,
        delayMs: settingsConfig.delayMs,
        maxWaitMs: settingsConfig.maxWaitMs,
        maxMessages: settingsConfig.maxMessages,
        separator: settingsConfig.separator,
      };
    } catch (error) {
      logger.warn({ error }, 'Failed to load config from settings, using defaults');
      return { ...DEFAULT_CONFIG };
    }
  }

  private getConfigForProject(projectId: string): MessagePoolConfig {
    try {
      const settingsConfig = this.settings.getMessagePoolConfigForProject(projectId);
      return {
        enabled: settingsConfig.enabled,
        delayMs: settingsConfig.delayMs,
        maxWaitMs: settingsConfig.maxWaitMs,
        maxMessages: settingsConfig.maxMessages,
        separator: settingsConfig.separator,
      };
    } catch (error) {
      logger.warn({ projectId, error }, 'Failed to load project config, using global config');
      return this.config;
    }
  }

  reloadConfig(): void {
    this.config = this.loadConfigFromSettings();
    logger.info({ config: this.config }, 'Message pool configuration reloaded');
  }

  configure(config: Partial<MessagePoolConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Message pool configuration updated');
  }

  private configsEqual(a: MessagePoolConfig, b: MessagePoolConfig): boolean {
    return (
      a.enabled === b.enabled &&
      a.delayMs === b.delayMs &&
      a.maxWaitMs === b.maxWaitMs &&
      a.maxMessages === b.maxMessages &&
      a.separator === b.separator
    );
  }

  private resetPoolTimers(agentId: string, pool: AgentPool, newConfig: MessagePoolConfig): void {
    if (pool.timer) {
      clearTimeout(pool.timer);
      pool.timer = null;
    }
    if (pool.maxWaitTimer) {
      clearTimeout(pool.maxWaitTimer);
      pool.maxWaitTimer = null;
    }

    const elapsed = Date.now() - pool.firstEnqueueTime;
    const remaining = newConfig.maxWaitMs - elapsed;

    if (remaining <= 0) {
      logger.debug(
        { agentId, projectId: pool.projectId, elapsed, maxWaitMs: newConfig.maxWaitMs },
        'Max wait already exceeded after config reload, scheduling immediate flush',
      );
      setTimeout(() => {
        this.flushNow(agentId).catch((err) => {
          logger.error({ agentId, error: err }, 'Immediate flush after config reload failed');
        });
      }, 0);
      return;
    }

    pool.maxWaitTimer = setTimeout(() => {
      logger.debug(
        { agentId, projectId: pool.projectId },
        'Max wait timer triggered (after config reload)',
      );
      this.flushNow(agentId).catch((err) => {
        logger.error({ agentId, error: err }, 'Max wait flush failed');
      });
    }, remaining);
  }

  async enqueue(
    agentId: string,
    text: string,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const {
      source = 'unknown',
      submitKeys = ['Enter'],
      senderAgentId,
      immediate = false,
    } = options;

    const { projectId, agentName } = await this.resolveProjectInfo(agentId, options);
    const projectConfig = this.getConfigForProject(projectId);

    const logEntryId = randomUUID();
    const timestamp = Date.now();

    if (immediate || !projectConfig.enabled) {
      const reason = immediate ? 'immediate flag' : 'pooling disabled';
      logger.debug(
        { agentId, projectId, source, reason },
        'Bypassing pool, delivering immediately',
      );

      const logEntry: MessageLogEntry = {
        id: logEntryId,
        timestamp,
        projectId,
        agentId,
        agentName,
        text,
        source,
        senderAgentId,
        status: 'queued',
        immediate: true,
      };
      this.messageLog.addEntry(logEntry);
      this.activityStream.broadcastEnqueued(logEntry);
      this.broadcastPoolsUpdate();

      try {
        const {
          nonce: deliveredNonce,
          unconfirmed,
          skipped,
          retryCount,
        } = await this.deliverMessage(agentId, text, submitKeys, { skipConfirmation: immediate });
        const status = unconfirmed ? 'unconfirmed' : 'delivered';
        const deliveredAt = Date.now();
        this.messageLog.update(logEntryId, {
          status,
          deliveredAt,
          nonce: skipped ? undefined : deliveredNonce,
          confirmedAt: skipped || unconfirmed ? undefined : deliveredAt,
          retryCount,
          failureCode: unconfirmed ? 'paste_not_confirmed' : undefined,
        });
        const updatedEntry = this.messageLog.getById(logEntryId);
        if (updatedEntry) {
          if (unconfirmed) {
            this.activityStream.broadcastUnconfirmed(logEntryId, [updatedEntry]);
          } else {
            this.activityStream.broadcastDelivered(logEntryId, [updatedEntry]);
          }
        }
        return { status };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ agentId, source, error: errorMsg }, 'Immediate delivery failed');
        this.messageLog.update(logEntryId, {
          status: 'failed',
          error: errorMsg,
          failureCode: 'tmux_error',
        });
        const failedEntry = this.messageLog.getById(logEntryId);
        if (failedEntry) {
          this.activityStream.broadcastFailed(failedEntry);
        }
        return { status: 'failed', error: errorMsg };
      }
    }

    let pool = this.pools.get(agentId);
    if (!pool) {
      pool = {
        messages: [],
        timer: null,
        maxWaitTimer: null,
        firstEnqueueTime: Date.now(),
        config: projectConfig,
        projectId,
      };
      this.pools.set(agentId, pool);

      pool.maxWaitTimer = setTimeout(() => {
        logger.debug({ agentId, projectId }, 'Max wait timer triggered');
        this.flushNow(agentId).catch((err) => {
          logger.error({ agentId, error: err }, 'Max wait flush failed');
        });
      }, projectConfig.maxWaitMs);

      logger.debug(
        { agentId, projectId, config: projectConfig },
        'Created new pool with project-specific config',
      );
    } else {
      if (!this.configsEqual(pool.config, projectConfig)) {
        logger.debug(
          { agentId, projectId, oldConfig: pool.config, newConfig: projectConfig },
          'Pool config changed, updating timers',
        );
        const oldMaxMessages = pool.config.maxMessages;
        pool.config = projectConfig;
        if (pool.messages.length > 0) {
          this.resetPoolTimers(agentId, pool, projectConfig);
        }
        if (
          projectConfig.maxMessages < oldMaxMessages &&
          pool.messages.length >= projectConfig.maxMessages
        ) {
          logger.debug(
            {
              agentId,
              projectId,
              count: pool.messages.length,
              newMaxMessages: projectConfig.maxMessages,
            },
            'Config reduced maxMessages below current count, will flush after adding message',
          );
        }
      }
    }

    const logEntry: MessageLogEntry = {
      id: logEntryId,
      timestamp,
      projectId,
      agentId,
      agentName,
      text,
      source,
      senderAgentId,
      status: 'queued',
      immediate: false,
    };
    this.messageLog.addEntry(logEntry);
    this.activityStream.broadcastEnqueued(logEntry);
    this.broadcastPoolsUpdate();

    const message: PooledMessage = {
      text,
      source,
      timestamp,
      submitKeys,
      senderAgentId,
      logEntryId,
    };
    pool.messages.push(message);

    logger.debug(
      { agentId, projectId, source, poolSize: pool.messages.length },
      'Message enqueued to pool',
    );

    if (pool.messages.length >= pool.config.maxMessages) {
      logger.debug(
        { agentId, projectId, count: pool.messages.length, maxMessages: pool.config.maxMessages },
        'Max messages reached, flushing',
      );
      const flushResult = await this.flushNow(agentId);
      if (!flushResult.success) {
        return { status: 'failed', error: flushResult.reason };
      }
      return { status: flushResult.outcome === 'unconfirmed' ? 'unconfirmed' : 'delivered' };
    }

    if (pool.timer) {
      clearTimeout(pool.timer);
    }
    pool.timer = setTimeout(() => {
      logger.debug({ agentId, projectId }, 'Debounce timer triggered');
      this.flushNow(agentId).catch((err) => {
        logger.error({ agentId, error: err }, 'Debounce flush failed');
      });
    }, pool.config.delayMs);

    return { status: 'queued', poolSize: pool.messages.length };
  }

  async flushNow(agentId: string): Promise<FlushResult> {
    const pool = this.pools.get(agentId);
    if (!pool || pool.messages.length === 0) {
      logger.debug({ agentId }, 'No messages to flush');
      return { success: true, deliveredCount: 0 };
    }

    if (pool.timer) {
      clearTimeout(pool.timer);
      pool.timer = null;
    }
    if (pool.maxWaitTimer) {
      clearTimeout(pool.maxWaitTimer);
      pool.maxWaitTimer = null;
    }

    const messages = [...pool.messages];
    const poolConfig = pool.config;
    this.pools.delete(agentId);

    logger.info(
      { agentId, projectId: pool.projectId, messageCount: messages.length },
      'Flushing message pool',
    );

    let result: FlushResult = { success: true, deliveredCount: messages.length };
    await this.coordinator.withAgentLock(agentId, async () => {
      result = await this.deliverBatch(agentId, messages, poolConfig.separator);
    });
    return result;
  }

  async flushAll(): Promise<void> {
    const agentIds = Array.from(this.pools.keys());
    logger.info({ agentCount: agentIds.length }, 'Flushing all message pools');

    await Promise.all(
      agentIds.map((agentId) =>
        this.flushNow(agentId).catch((err) => {
          logger.error({ agentId, error: err }, 'Failed to flush pool during flushAll');
        }),
      ),
    );
  }

  getPoolStats(): { agentId: string; messageCount: number; waitingMs: number }[] {
    const now = Date.now();
    return Array.from(this.pools.entries()).map(([agentId, pool]) => ({
      agentId,
      messageCount: pool.messages.length,
      waitingMs: now - pool.firstEnqueueTime,
    }));
  }

  getPoolDetails(projectId?: string): PoolDetails[] {
    const now = Date.now();
    const PREVIEW_LENGTH = 100;
    const details: PoolDetails[] = [];

    for (const [agentId, pool] of this.pools.entries()) {
      if (pool.messages.length === 0) continue;

      const firstMessage = pool.messages[0];
      const logEntry = this.messageLog.getById(firstMessage.logEntryId);

      const poolProjectId = logEntry?.projectId ?? 'unknown';
      const agentName = logEntry?.agentName ?? 'unknown';

      if (projectId && poolProjectId !== projectId) continue;

      const messages = pool.messages.map((msg) => {
        const preview =
          msg.text.length > PREVIEW_LENGTH ? msg.text.slice(0, PREVIEW_LENGTH) + '...' : msg.text;
        return {
          id: msg.logEntryId,
          preview,
          source: msg.source,
          timestamp: msg.timestamp,
        };
      });

      details.push({
        agentId,
        agentName,
        projectId: poolProjectId,
        messageCount: pool.messages.length,
        waitingMs: now - pool.firstEnqueueTime,
        messages,
      });
    }

    details.sort((a, b) => b.waitingMs - a.waitingMs);
    return details;
  }

  async onModuleDestroy(): Promise<void> {
    const poolStats = this.getPoolStats();
    const totalMessages = poolStats.reduce((sum, p) => sum + p.messageCount, 0);

    logger.info(
      { agentCount: poolStats.length, totalMessages },
      'Shutting down message pool, flushing pending messages...',
    );

    for (const [agentId, pool] of this.pools.entries()) {
      if (pool.timer) {
        clearTimeout(pool.timer);
        pool.timer = null;
      }
      if (pool.maxWaitTimer) {
        clearTimeout(pool.maxWaitTimer);
        pool.maxWaitTimer = null;
      }
      logger.debug({ agentId }, 'Cleared timers for agent pool');
    }

    const SHUTDOWN_TIMEOUT_MS = 5000;
    const flushPromise = this.flushAll();
    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(() => {
        const remainingPools = this.pools.size;
        const remainingMessages = Array.from(this.pools.values()).reduce(
          (sum, p) => sum + p.messages.length,
          0,
        );
        if (remainingMessages > 0) {
          logger.warn(
            { remainingPools, remainingMessages, timeoutMs: SHUTDOWN_TIMEOUT_MS },
            'Shutdown flush timeout reached, some messages may be lost',
          );
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS),
    );

    await Promise.race([flushPromise, timeoutPromise]);
    logger.info('Message pool shutdown complete');
  }

  // ─── Public log accessors (delegate to MessageLogService) ──────────────

  getMessageLog(options?: {
    projectId?: string;
    agentId?: string;
    status?: MessageLogEntry['status'];
    source?: string;
    limit?: number;
  }): MessageLogEntry[] {
    return this.messageLog.query(options);
  }

  getLogStats(): { entryCount: number; bytesUsed: number; maxEntries: number; maxBytes: number } {
    return this.messageLog.getStats();
  }

  getMessageById(messageId: string): MessageLogEntry | null {
    return this.messageLog.getMessageById(messageId);
  }

  // ─── Private delivery methods ──────────────────────────────────────────

  private async deliverBatch(
    agentId: string,
    messages: PooledMessage[],
    separator: string = this.config.separator,
  ): Promise<FlushResult> {
    const batchId = randomUUID();

    const activeSessions = await this.sessions.listActiveSessions();
    const session = activeSessions.find((s) => s.agentId === agentId);

    if (!session || !session.tmuxSessionId) {
      logger.warn(
        { agentId, messageCount: messages.length },
        'No active session for agent, messages discarded',
      );
      for (const msg of messages) {
        this.messageLog.update(msg.logEntryId, {
          status: 'failed',
          batchId,
          error: 'No active session',
          failureCode: 'no_active_session',
        });
        const entry = this.messageLog.getById(msg.logEntryId);
        if (entry) {
          this.activityStream.broadcastFailed(entry);
        }
      }
      this.broadcastPoolsUpdate();
      await this.failureNotifier
        .notifySendersOfFailure(messages, agentId, 'No active session')
        .catch((err: unknown) =>
          logger.warn({ agentId, error: err }, 'Failure notification error (best-effort)'),
        );
      return { success: false, discardedCount: messages.length, reason: 'No active session' };
    }

    const tmuxSessionId = session.tmuxSessionId;
    const baseText = messages.map((m) => m.text).join(separator);
    const submitKeys = messages[messages.length - 1]?.submitKeys ?? ['Enter'];

    try {
      const postPasteDelayMs =
        await this.providerAdapterFactory.getPostPasteDelayMsForAgent(agentId);
      const result = await this.terminalIO.deliver({ name: tmuxSessionId }, baseText, {
        agentId,
        submitKeys,
        postPasteDelayMs,
      });

      const deliveredAt = Date.now();
      const status = result.confirmed ? 'delivered' : 'unconfirmed';
      const entries: MessageLogEntry[] = [];
      for (const msg of messages) {
        this.messageLog.update(msg.logEntryId, {
          status,
          batchId,
          deliveredAt,
          nonce: result.nonce,
          confirmedAt: result.confirmed ? deliveredAt : undefined,
          retryCount: result.retryCount,
          failureCode: result.confirmed ? undefined : 'paste_not_confirmed',
        });
        const entry = this.messageLog.getById(msg.logEntryId);
        if (entry) entries.push(entry);
      }

      if (result.confirmed) {
        this.activityStream.broadcastDelivered(batchId, entries);
      } else {
        this.activityStream.broadcastUnconfirmed(batchId, entries);
      }
      this.broadcastPoolsUpdate();

      logger.info(
        {
          agentId,
          sessionId: session.id,
          messageCount: messages.length,
          batchId,
          confirmed: result.confirmed,
        },
        'Batch delivered to agent session',
      );

      return {
        success: true,
        deliveredCount: messages.length,
        outcome: result.confirmed ? 'delivered' : 'unconfirmed',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, sessionId: session.id, error: errorMsg },
        'Failed to deliver batch to agent session',
      );
      const failureCode: DeliveryFailureCode = errorMsg.includes('send keys')
        ? 'send_keys_failed'
        : 'tmux_error';
      for (const msg of messages) {
        this.messageLog.update(msg.logEntryId, {
          status: 'failed',
          batchId,
          error: errorMsg,
          failureCode,
        });
        const entry = this.messageLog.getById(msg.logEntryId);
        if (entry) this.activityStream.broadcastFailed(entry);
      }
      this.broadcastPoolsUpdate();
      await this.failureNotifier
        .notifySendersOfFailure(messages, agentId, errorMsg)
        .catch((err: unknown) =>
          logger.warn({ agentId, error: err }, 'Failure notification error (best-effort)'),
        );
      return { success: false, discardedCount: messages.length, reason: errorMsg };
    }
  }

  private async deliverMessage(
    agentId: string,
    text: string,
    submitKeys: string[],
    opts?: { skipConfirmation?: boolean },
  ): Promise<{ nonce: string; unconfirmed?: boolean; skipped?: boolean; retryCount: number }> {
    const activeSessions = await this.sessions.listActiveSessions();
    const session = activeSessions.find((s) => s.agentId === agentId);

    if (!session || !session.tmuxSessionId) {
      throw new Error(`No active session for agent ${agentId}`);
    }

    let result: { nonce: string; unconfirmed?: boolean; skipped?: boolean; retryCount: number } = {
      nonce: '',
      retryCount: 0,
    };

    await this.coordinator.withAgentLock(agentId, async () => {
      const postPasteDelayMs =
        await this.providerAdapterFactory.getPostPasteDelayMsForAgent(agentId);
      if (opts?.skipConfirmation) {
        const delivery = await this.terminalIO.deliverImmediate(
          { name: session.tmuxSessionId! },
          text,
          { submitKeys, postPasteDelayMs, confirm: false },
        );
        result = { nonce: delivery.nonce, skipped: true, retryCount: 0 };
      } else {
        const delivery = await this.terminalIO.deliver({ name: session.tmuxSessionId! }, text, {
          agentId,
          submitKeys,
          postPasteDelayMs,
        });
        result = {
          nonce: delivery.nonce,
          unconfirmed: !delivery.confirmed,
          retryCount: delivery.retryCount,
        };
      }
    });

    logger.info(
      { agentId, sessionId: session.id, unconfirmed: result.unconfirmed },
      'Immediate message delivered',
    );

    return result;
  }

  private broadcastPoolsUpdate(): void {
    const pools = this.getPoolDetails();
    this.activityStream.broadcastPoolsUpdated(pools);
  }

  private async resolveProjectInfo(
    agentId: string,
    options: EnqueueOptions,
  ): Promise<{ projectId: string; agentName: string }> {
    let projectId = options.projectId ?? 'unknown';
    let agentName = options.agentName ?? 'unknown';

    if (!options.projectId || !options.agentName) {
      try {
        const agent = await this.storage.getAgent(agentId);
        if (!options.agentName) agentName = agent.name;
        if (!options.projectId && agent.projectId) projectId = agent.projectId;
      } catch (error) {
        logger.debug({ agentId, error }, 'Failed to resolve project info from storage');
      }
    }

    return { projectId, agentName };
  }
}
