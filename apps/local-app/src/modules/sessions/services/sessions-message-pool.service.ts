import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
  type MessageDeliveryMode,
  deliveryModeFromLegacyImmediate,
  isMessageDeliveryMode,
  type PooledMessage,
  type EnqueueOptions,
  type EnqueueResult,
  type FlushResult,
  type DeliveryFailureCode,
  type FailureDisclosurePolicy,
  type MessageLogEntry,
  type PoolDetails,
} from './message-pool.types';
import type { SessionActivityChangedEventPayload } from '../../events/catalog/session.activity.changed';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';
import {
  classifyDeliveryFailure,
  getStrictestFailureDisclosure,
  PROJECT_SAFE_DELIVERY_ERROR,
} from './delivery-failure-disclosure';
export {
  FAILURE_NOTICE_SOURCE,
  type MessageDeliveryMode,
  type MessagePoolConfig,
  type PooledMessage,
  type EnqueueOptions,
  type EnqueueResult,
  type FlushResult,
  type DeliveryFailureCode,
  type FailureDisclosurePolicy,
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

interface AgentIdleLane {
  readonly sessionId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly messages: PooledMessage[];
  readonly firstEnqueueTime: number;
  separator: string;
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
  private idleLanes = new Map<string, AgentIdleLane>();
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

  private getConfigForProject(
    projectId: string,
    failureDisclosure: FailureDisclosurePolicy = 'legacy',
  ): MessagePoolConfig {
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
      logger.warn(
        { projectId, error: this.disclosedLogError(failureDisclosure, error) },
        'Failed to load project config, using global config',
      );
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

  private resolveDeliveryMode(options: EnqueueOptions): MessageDeliveryMode {
    if (isMessageDeliveryMode(options.deliveryMode)) {
      return options.deliveryMode;
    }
    return deliveryModeFromLegacyImmediate(options.immediate);
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
          logger.error(
            {
              agentId,
              error: this.disclosedLogError(getStrictestFailureDisclosure(pool.messages), err),
            },
            'Immediate flush after config reload failed',
          );
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
        logger.error(
          {
            agentId,
            error: this.disclosedLogError(getStrictestFailureDisclosure(pool.messages), err),
          },
          'Max wait flush failed',
        );
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
      preKeys,
      preDelayMs,
      senderAgentId,
      clientMessageId,
      failureDisclosure = 'legacy',
    } = options;

    const { projectId, agentName } = await this.resolveProjectInfo(agentId, options);
    const logEntryId = randomUUID();
    const timestamp = Date.now();
    const deliveryMode = this.resolveDeliveryMode(options);

    if (deliveryMode === 'on_idle') {
      return this.enqueueOnIdle({
        agentId,
        text,
        source,
        submitKeys,
        senderAgentId,
        clientMessageId,
        failureDisclosure,
        projectId,
        agentName,
        logEntryId,
        timestamp,
      });
    }

    const projectConfig = this.getConfigForProject(projectId, failureDisclosure);
    const immediateDelivery = deliveryMode === 'immediate';

    if (immediateDelivery || !projectConfig.enabled) {
      const reason = immediateDelivery ? 'delivery mode' : 'pooling disabled';
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
        clientMessageId,
        status: 'queued',
        immediate: true,
      };
      // IDEMPOTENCY INVARIANT: this dedup check and `addEntry` below MUST stay
      // adjacent with ZERO `await` between them. `findByClientMessageId` and
      // `addEntry` are both synchronous, so under JS single-threading the
      // check→return-or-add is atomic: two concurrent same-clientMessageId
      // enqueues (both suspended at `resolveProjectInfo` above) cannot both miss.
      // Do NOT hoist this to method entry — that placement is racy (both callers
      // pass it while suspended, then both add).
      if (clientMessageId) {
        const existing = this.messageLog.findByClientMessageId(clientMessageId, agentId, source);
        if (existing) {
          logger.debug(
            { agentId, source, clientMessageId, logEntryId: existing.id },
            'Duplicate clientMessageId — returning existing entry, skipping re-delivery',
          );
          return { status: existing.status, logEntryId: existing.id };
        }
      }
      this.messageLog.addEntry(logEntry);
      this.activityStream.broadcastEnqueued(logEntry);
      this.broadcastPoolsUpdate();

      try {
        const {
          nonce: deliveredNonce,
          unconfirmed,
          skipped,
          retryCount,
        } = await this.deliverMessage(agentId, text, submitKeys, {
          skipConfirmation: immediateDelivery,
          preKeys,
          preDelayMs,
        });
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
        return { status, logEntryId };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const failure = classifyDeliveryFailure(failureDisclosure, errorMsg, 'tmux_error');
        logger.error({ agentId, source, error: failure.error }, 'Immediate delivery failed');
        this.messageLog.update(logEntryId, {
          status: 'failed',
          error: failure.error,
          failureCode: failure.failureCode,
        });
        const failedEntry = this.messageLog.getById(logEntryId);
        if (failedEntry) {
          this.activityStream.broadcastFailed(failedEntry);
        }
        return { status: 'failed', error: failure.error, logEntryId };
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
      const scheduledPool = pool;

      pool.maxWaitTimer = setTimeout(() => {
        logger.debug({ agentId, projectId }, 'Max wait timer triggered');
        this.flushNow(agentId).catch((err) => {
          logger.error(
            {
              agentId,
              error: this.disclosedLogError(
                getStrictestFailureDisclosure(scheduledPool.messages),
                err,
              ),
            },
            'Max wait flush failed',
          );
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
      clientMessageId,
      status: 'queued',
      immediate: false,
    };
    // IDEMPOTENCY INVARIANT (pooled path): same rule as the immediate path above
    // — dedup check and `addEntry` stay adjacent with ZERO intervening `await`
    // so the check→return-or-add block is atomic under JS single-threading.
    if (clientMessageId) {
      const existing = this.messageLog.findByClientMessageId(clientMessageId, agentId, source);
      if (existing) {
        logger.debug(
          { agentId, source, clientMessageId, logEntryId: existing.id },
          'Duplicate clientMessageId — returning existing entry, skipping re-enqueue',
        );
        return { status: existing.status, logEntryId: existing.id };
      }
    }
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
      clientMessageId,
      failureDisclosure,
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
    const scheduledPool = pool;
    pool.timer = setTimeout(() => {
      logger.debug({ agentId, projectId }, 'Debounce timer triggered');
      this.flushNow(agentId).catch((err) => {
        logger.error(
          {
            agentId,
            error: this.disclosedLogError(
              getStrictestFailureDisclosure(scheduledPool.messages),
              err,
            ),
          },
          'Debounce flush failed',
        );
      });
    }, pool.config.delayMs);

    return { status: 'queued', poolSize: pool.messages.length, logEntryId };
  }

  private async enqueueOnIdle(input: {
    agentId: string;
    text: string;
    source: string;
    submitKeys: string[];
    senderAgentId?: string;
    clientMessageId?: string;
    failureDisclosure: FailureDisclosurePolicy;
    projectId: string;
    agentName: string;
    logEntryId: string;
    timestamp: number;
  }): Promise<EnqueueResult> {
    const activeSession = this.sessions.getActiveSessionForAgent(input.agentId);

    if (input.clientMessageId) {
      const existing = this.messageLog.findByClientMessageId(
        input.clientMessageId,
        input.agentId,
        input.source,
      );
      if (existing) {
        return { status: existing.status, logEntryId: existing.id };
      }
    }

    let detachedLane: AgentIdleLane | undefined;
    const currentLane = this.idleLanes.get(input.agentId);
    if (currentLane && currentLane.sessionId !== activeSession?.id) {
      this.idleLanes.delete(input.agentId);
      detachedLane = currentLane;
    }

    if (!activeSession) {
      const failure = classifyDeliveryFailure(
        input.failureDisclosure,
        'No active session',
        'no_active_session',
      );
      if (detachedLane) {
        await this.failIdleLane(detachedLane, 'Target session is no longer active');
      }
      return { status: 'failed', error: failure.error };
    }

    const projectConfig = this.getConfigForProject(input.projectId, input.failureDisclosure);
    let lane = this.idleLanes.get(input.agentId);
    if (lane) {
      lane.separator = projectConfig.separator;
    }
    if ((lane?.messages.length ?? 0) >= projectConfig.maxMessages) {
      const failure = classifyDeliveryFailure(
        input.failureDisclosure,
        'Message pool capacity reached',
        'pool_capacity_exceeded',
      );
      return { status: 'failed', error: failure.error };
    }

    if (!lane) {
      lane = {
        sessionId: activeSession.id,
        agentId: input.agentId,
        projectId: input.projectId,
        messages: [],
        firstEnqueueTime: input.timestamp,
        separator: projectConfig.separator,
      };
      this.idleLanes.set(input.agentId, lane);
    }

    const logEntry: MessageLogEntry = {
      id: input.logEntryId,
      timestamp: input.timestamp,
      projectId: input.projectId,
      agentId: input.agentId,
      agentName: input.agentName,
      text: input.text,
      source: input.source,
      senderAgentId: input.senderAgentId,
      clientMessageId: input.clientMessageId,
      status: 'queued',
      immediate: false,
    };
    this.messageLog.addEntry(logEntry);
    lane.messages.push({
      text: input.text,
      source: input.source,
      timestamp: input.timestamp,
      submitKeys: input.submitKeys,
      senderAgentId: input.senderAgentId,
      logEntryId: input.logEntryId,
      clientMessageId: input.clientMessageId,
      failureDisclosure: input.failureDisclosure,
    });
    this.activityStream.broadcastEnqueued(logEntry);
    this.broadcastPoolsUpdate();
    const exactSessionIsIdle = activeSession.activityState === 'idle';

    const detachedFailure = detachedLane
      ? this.failIdleLane(detachedLane, 'Target session was replaced before idle delivery')
      : Promise.resolve();

    if (exactSessionIsIdle) {
      const [, flushResult] = await Promise.all([
        detachedFailure,
        this.flushIdleLane(input.agentId, activeSession.id),
      ]);
      if (!flushResult.success) {
        return { status: 'failed', error: flushResult.reason, logEntryId: input.logEntryId };
      }
      if (flushResult.deliveredCount === 0) {
        const logEntry = this.messageLog.getById(input.logEntryId);
        return {
          status: logEntry?.status ?? 'queued',
          ...(logEntry?.error ? { error: logEntry.error } : {}),
          logEntryId: input.logEntryId,
        };
      }
      return {
        status: flushResult.outcome === 'unconfirmed' ? 'unconfirmed' : 'delivered',
        logEntryId: input.logEntryId,
      };
    }

    await detachedFailure;
    return { status: 'queued', poolSize: lane.messages.length, logEntryId: input.logEntryId };
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
    const pendingPools = Array.from(this.pools.entries()).map(([agentId, pool]) => ({
      agentId,
      failureDisclosure: getStrictestFailureDisclosure(pool.messages),
    }));
    logger.info({ agentCount: pendingPools.length }, 'Flushing all message pools');

    await Promise.all(
      pendingPools.map(({ agentId, failureDisclosure }) =>
        this.flushNow(agentId).catch((err) => {
          logger.error(
            { agentId, error: this.disclosedLogError(failureDisclosure, err) },
            'Failed to flush pool during flushAll',
          );
        }),
      ),
    );
  }

  getPoolStats(): { agentId: string; messageCount: number; waitingMs: number }[] {
    const now = Date.now();
    const agentIds = new Set([...this.pools.keys(), ...this.idleLanes.keys()]);
    return Array.from(agentIds).map((agentId) => {
      const pool = this.pools.get(agentId);
      const idleLane = this.idleLanes.get(agentId);
      const oldestMessageTime = Math.min(
        pool?.messages[0]?.timestamp ?? Number.POSITIVE_INFINITY,
        idleLane?.firstEnqueueTime ?? Number.POSITIVE_INFINITY,
      );
      return {
        agentId,
        messageCount: (pool?.messages.length ?? 0) + (idleLane?.messages.length ?? 0),
        waitingMs: now - oldestMessageTime,
      };
    });
  }

  getPoolDetails(projectId?: string): PoolDetails[] {
    const now = Date.now();
    const PREVIEW_LENGTH = 100;
    const details: PoolDetails[] = [];

    const agentIds = new Set([...this.pools.keys(), ...this.idleLanes.keys()]);
    for (const agentId of agentIds) {
      const pool = this.pools.get(agentId);
      const idleLane = this.idleLanes.get(agentId);
      const pooledMessages = [...(pool?.messages ?? []), ...(idleLane?.messages ?? [])].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      if (pooledMessages.length === 0) continue;

      const firstMessage = pooledMessages[0];
      const logEntry = this.messageLog.getById(firstMessage.logEntryId);

      const poolProjectId =
        logEntry?.projectId ?? pool?.projectId ?? idleLane?.projectId ?? 'unknown';
      const agentName = logEntry?.agentName ?? 'unknown';

      if (projectId && poolProjectId !== projectId) continue;

      const messages = pooledMessages.map((msg) => {
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
        messageCount: pooledMessages.length,
        waitingMs: now - firstMessage.timestamp,
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
      'Shutting down message pool, flushing default lanes and clearing idle lanes...',
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

    const idleLanes = Array.from(this.idleLanes.values());
    this.idleLanes.clear();
    if (idleLanes.length > 0) {
      logger.info(
        {
          agentCount: idleLanes.length,
          totalMessages: idleLanes.reduce((sum, lane) => sum + lane.messages.length, 0),
        },
        'Clearing idle delivery lanes without terminal delivery',
      );
      await Promise.all(
        idleLanes.map((lane) =>
          this.failIdleLane(lane, 'Service stopped before idle delivery', false),
        ),
      );
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

  @OnEvent('session.activity.changed', { async: true })
  async handleSessionActivityChanged(event: SessionActivityChangedEventPayload): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId || event.state !== 'idle') return;

    await this.flushIdleLane(session.agentId, event.sessionId);
  }

  @OnEvent('session.stopped', { async: true })
  async handleSessionStopped(event: SessionStoppedEventPayload): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId) return;

    await this.failMatchingIdleLane(
      session.agentId,
      event.sessionId,
      'Target session stopped before idle delivery',
    );
  }

  @OnEvent('session.crashed', { async: true })
  async handleSessionCrashed(event: SessionCrashedEventPayload): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId) return;

    await this.failMatchingIdleLane(
      session.agentId,
      event.sessionId,
      'Target session crashed before idle delivery',
    );
  }

  // ─── Private delivery methods ──────────────────────────────────────────

  private async flushIdleLane(agentId: string, expectedSessionId: string): Promise<FlushResult> {
    let result: FlushResult = { success: true, deliveredCount: 0 };
    await this.coordinator.withAgentLock(agentId, async () => {
      const expectedSession = this.sessions.getSession(expectedSessionId);
      const activeSession = this.sessions.getActiveSessionForAgent(agentId);
      const lane = this.idleLanes.get(agentId);

      if (
        !lane ||
        lane.sessionId !== expectedSessionId ||
        expectedSession?.status !== 'running' ||
        expectedSession.activityState !== 'idle' ||
        activeSession?.id !== expectedSessionId
      ) {
        return;
      }

      this.idleLanes.delete(agentId);
      result = await this.deliverBatch(agentId, [...lane.messages], lane.separator);
    });
    return result;
  }

  private async failMatchingIdleLane(
    agentId: string,
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const lane = this.idleLanes.get(agentId);
    if (!lane || lane.sessionId !== sessionId) return;

    this.idleLanes.delete(agentId);
    await this.failIdleLane(lane, reason);
  }

  private async failIdleLane(
    lane: AgentIdleLane,
    reason: string,
    notifySenders = true,
  ): Promise<void> {
    const batchId = randomUUID();
    const failureDisclosure = getStrictestFailureDisclosure(lane.messages);
    const batchFailure = classifyDeliveryFailure(failureDisclosure, reason, 'no_active_session');

    for (const message of lane.messages) {
      const failure = classifyDeliveryFailure(
        message.failureDisclosure,
        reason,
        'no_active_session',
      );
      this.messageLog.update(message.logEntryId, {
        status: 'failed',
        batchId,
        error: failure.error,
        failureCode: failure.failureCode,
      });
      const entry = this.messageLog.getById(message.logEntryId);
      if (entry) this.activityStream.broadcastFailed(entry);
    }
    this.broadcastPoolsUpdate();

    logger.warn(
      {
        agentId: lane.agentId,
        sessionId: lane.sessionId,
        messageCount: lane.messages.length,
        error: batchFailure.error,
      },
      'Idle delivery lane discarded',
    );

    if (!notifySenders) return;
    await this.failureNotifier
      .notifySendersOfFailure(lane.messages, lane.agentId, batchFailure.error)
      .catch((error: unknown) =>
        logger.warn(
          {
            agentId: lane.agentId,
            error: this.disclosedLogError(failureDisclosure, error),
          },
          'Failure notification error (best-effort)',
        ),
      );
  }

  private async deliverBatch(
    agentId: string,
    messages: PooledMessage[],
    separator: string = this.config.separator,
  ): Promise<FlushResult> {
    const batchId = randomUUID();
    const failureDisclosure = getStrictestFailureDisclosure(messages);

    const activeSessions = await this.sessions.listActiveSessions();
    const session = activeSessions.find((s) => s.agentId === agentId);

    if (!session || !session.tmuxSessionId) {
      const rawReason = 'No active session';
      const batchFailure = classifyDeliveryFailure(
        failureDisclosure,
        rawReason,
        'no_active_session',
      );
      logger.warn(
        { agentId, messageCount: messages.length },
        'No active session for agent, messages discarded',
      );
      for (const msg of messages) {
        const failure = classifyDeliveryFailure(
          msg.failureDisclosure,
          rawReason,
          'no_active_session',
        );
        this.messageLog.update(msg.logEntryId, {
          status: 'failed',
          batchId,
          error: failure.error,
          failureCode: failure.failureCode,
        });
        const entry = this.messageLog.getById(msg.logEntryId);
        if (entry) {
          this.activityStream.broadcastFailed(entry);
        }
      }
      this.broadcastPoolsUpdate();
      await this.failureNotifier
        .notifySendersOfFailure(messages, agentId, batchFailure.error)
        .catch((err: unknown) =>
          logger.warn(
            {
              agentId,
              error: failureDisclosure === 'project-safe' ? PROJECT_SAFE_DELIVERY_ERROR : err,
            },
            'Failure notification error (best-effort)',
          ),
        );
      return { success: false, discardedCount: messages.length, reason: batchFailure.error };
    }

    const tmuxSessionId = session.tmuxSessionId;
    const baseText = messages.map((m) => m.text).join(separator);
    const submitKeys = messages[messages.length - 1]?.submitKeys ?? ['Enter'];

    try {
      const postPasteDelayMs =
        await this.providerAdapterFactory.getPostPasteDelayMsForAgent(agentId);
      const draftKeys = await this.providerAdapterFactory.getPromptDraftKeysForAgent(agentId);
      const result = await this.terminalIO.deliver({ name: tmuxSessionId }, baseText, {
        agentId,
        submitKeys,
        postPasteDelayMs,
        draftKeys,
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
      const failureCode: DeliveryFailureCode = errorMsg.includes('send keys')
        ? 'send_keys_failed'
        : 'tmux_error';
      const batchFailure = classifyDeliveryFailure(failureDisclosure, errorMsg, failureCode);
      logger.error(
        { agentId, sessionId: session.id, error: batchFailure.error },
        'Failed to deliver batch to agent session',
      );
      for (const msg of messages) {
        const failure = classifyDeliveryFailure(msg.failureDisclosure, errorMsg, failureCode);
        this.messageLog.update(msg.logEntryId, {
          status: 'failed',
          batchId,
          error: failure.error,
          failureCode: failure.failureCode,
        });
        const entry = this.messageLog.getById(msg.logEntryId);
        if (entry) this.activityStream.broadcastFailed(entry);
      }
      this.broadcastPoolsUpdate();
      await this.failureNotifier
        .notifySendersOfFailure(messages, agentId, batchFailure.error)
        .catch((err: unknown) =>
          logger.warn(
            {
              agentId,
              error: failureDisclosure === 'project-safe' ? PROJECT_SAFE_DELIVERY_ERROR : err,
            },
            'Failure notification error (best-effort)',
          ),
        );
      return { success: false, discardedCount: messages.length, reason: batchFailure.error };
    }
  }

  private async deliverMessage(
    agentId: string,
    text: string,
    submitKeys: string[],
    opts?: { skipConfirmation?: boolean; preKeys?: string[]; preDelayMs?: number },
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
      const draftKeys = await this.providerAdapterFactory.getPromptDraftKeysForAgent(agentId);
      if (opts?.skipConfirmation) {
        const delivery = await this.terminalIO.deliverImmediate(
          { name: session.tmuxSessionId! },
          text,
          {
            submitKeys,
            postPasteDelayMs,
            confirm: false,
            preKeys: opts?.preKeys,
            preDelayMs: opts?.preDelayMs,
            draftKeys,
          },
        );
        result = { nonce: delivery.nonce, skipped: true, retryCount: 0 };
      } else {
        const delivery = await this.terminalIO.deliver({ name: session.tmuxSessionId! }, text, {
          agentId,
          submitKeys,
          postPasteDelayMs,
          preKeys: opts?.preKeys,
          preDelayMs: opts?.preDelayMs,
          draftKeys,
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
        logger.debug(
          { agentId, error: this.disclosedLogError(options.failureDisclosure, error) },
          'Failed to resolve project info from storage',
        );
      }
    }

    return { projectId, agentName };
  }

  private disclosedLogError(
    failureDisclosure: FailureDisclosurePolicy | undefined,
    error: unknown,
  ): unknown {
    return failureDisclosure === 'project-safe' ? PROJECT_SAFE_DELIVERY_ERROR : error;
  }
}
