import { Injectable, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SessionsService } from './sessions.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { MessageActivityStreamService } from './message-activity-stream.service';
import { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { TmuxService } from '../../terminal/services/tmux.service';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('SessionsMessagePoolService');

/** Source identifier for failure notifications (used for loop prevention) */
export const FAILURE_NOTICE_SOURCE = 'pool.failure_notice';

/**
 * Configuration for message pooling behavior.
 */
export interface MessagePoolConfig {
  /** Whether pooling is enabled. When false, all messages are delivered immediately. */
  enabled: boolean;
  /** Debounce delay before flushing (resets on each enqueue). Default: 10000ms */
  delayMs: number;
  /** Maximum wait time from first enqueue to flush (prevents starvation). Default: 30000ms */
  maxWaitMs: number;
  /** Maximum messages before forced flush. Default: 10 */
  maxMessages: number;
  /** Separator between concatenated messages. Default: '\n---\n' */
  separator: string;
}

/**
 * A message queued in the pool awaiting delivery.
 */
export interface PooledMessage {
  /** The message text to deliver */
  text: string;
  /** Source of the message (e.g., 'epic.assigned', 'mcp.send_message', 'chat.message') */
  source: string;
  /** Timestamp when message was enqueued */
  timestamp: number;
  /** Keys to submit after pasting (default: ['Enter']) */
  submitKeys: string[];
  /** Agent ID of the sender (for failure notification) */
  senderAgentId?: string;
  /** ID of the corresponding log entry (for lifecycle tracking) */
  logEntryId: string;
}

/**
 * Pool state for a single agent.
 */
interface AgentPool {
  /** Queued messages awaiting delivery */
  messages: PooledMessage[];
  /** Debounce timer (reset on each enqueue) */
  timer: NodeJS.Timeout | null;
  /** Max-wait timer (fires after maxWaitMs from first enqueue) */
  maxWaitTimer: NodeJS.Timeout | null;
  /** Timestamp of first enqueue in current batch */
  firstEnqueueTime: number;
  /** Project-specific config for this pool */
  config: MessagePoolConfig;
  /** Project ID this pool belongs to */
  projectId: string;
}

/**
 * Options for enqueuing a message.
 */
export interface EnqueueOptions {
  /** Source identifier for the message */
  source?: string;
  /** Keys to submit after pasting */
  submitKeys?: string[];
  /** Agent ID of the sender (for failure notification) */
  senderAgentId?: string;
  /** If true, bypass pool and deliver immediately */
  immediate?: boolean;
  /** Project ID (optional, avoids DB lookup when provided) */
  projectId?: string;
  /** Agent display name (optional, for logging/display) */
  agentName?: string;
}

/**
 * Result of an enqueue operation.
 */
export interface EnqueueResult {
  /** Whether the message was queued or delivered immediately */
  status: 'queued' | 'delivered' | 'failed';
  /** Number of messages currently in the pool for this agent */
  poolSize?: number;
  /** Error message if status is 'failed' */
  error?: string;
}

/**
 * Result of a flush operation.
 */
export interface FlushResult {
  /** Whether the flush succeeded */
  success: boolean;
  /** Number of messages that were delivered (if successful) */
  deliveredCount?: number;
  /** Number of messages that were discarded (if failed) */
  discardedCount?: number;
  /** Reason for failure (if failed) */
  reason?: string;
}

/**
 * Log entry for tracking message lifecycle.
 * Used for monitoring/debugging message delivery.
 */
export interface MessageLogEntry {
  /** Unique identifier for this log entry */
  id: string;
  /** Timestamp when the message was enqueued */
  timestamp: number;
  /** Project ID (resolved from options or storage) */
  projectId: string;
  /** Target agent ID */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** Message text content */
  text: string;
  /** Source of the message (e.g., 'epic.assigned', 'chat.message') */
  source: string;
  /** Agent ID of the sender (if applicable) */
  senderAgentId?: string;
  /** Current status of the message */
  status: 'queued' | 'delivered' | 'failed';
  /** Batch ID (set at flush time when multiple messages are grouped) */
  batchId?: string;
  /** Timestamp when message was delivered */
  deliveredAt?: number;
  /** Error message if delivery failed */
  error?: string;
  /** Whether message was delivered immediately (bypassed pool) */
  immediate: boolean;
}

/**
 * Extended pool information for UI display.
 * Includes message previews and agent context.
 */
export interface PoolDetails {
  /** Target agent ID */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** Project ID */
  projectId: string;
  /** Number of messages in pool */
  messageCount: number;
  /** Time since first message was enqueued (ms) */
  waitingMs: number;
  /** Message previews for display */
  messages: Array<{
    /** Message log entry ID */
    id: string;
    /** First 100 chars of message text */
    preview: string;
    /** Message source */
    source: string;
    /** Enqueue timestamp */
    timestamp: number;
  }>;
}

const DEFAULT_CONFIG: MessagePoolConfig = {
  enabled: true,
  delayMs: 10000,
  maxWaitMs: 30000,
  maxMessages: 10,
  separator: '\n---\n',
};

/**
 * Pools messages destined for agent sessions to batch them before delivery.
 *
 * This service collects messages per agent and delivers them as a single batch
 * after a configurable delay, preventing fragmented context from rapid-fire events.
 *
 * Features:
 * - Debounce timer resets on each enqueue
 * - maxWaitMs prevents starvation from continuous activity
 * - maxMessages triggers immediate flush when buffer is full
 * - immediate flag bypasses pooling for system-critical messages
 * - Uses agent locking to prevent race conditions during flush
 * - Configuration loaded from SettingsService (runtime updateable)
 */
/** Memory limits for message log */
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB
const LOG_WARNING_THRESHOLD = 0.8; // Warn at 80%

@Injectable()
export class SessionsMessagePoolService implements OnModuleDestroy {
  private pools = new Map<string, AgentPool>();
  private config: MessagePoolConfig;

  /** In-memory message log for monitoring */
  private messageLog: MessageLogEntry[] = [];
  /** Total bytes of message text in log */
  private logBytes = 0;
  /** Map of message ID to log entry index for quick updates */
  private logIndex = new Map<string, number>();

  constructor(
    @Inject(forwardRef(() => SessionsService))
    private readonly sessions: SessionsService,
    private readonly coordinator: SessionCoordinatorService,
    @Inject(forwardRef(() => TerminalSendCoordinatorService))
    private readonly sendCoordinator: TerminalSendCoordinatorService,
    @Inject(forwardRef(() => TmuxService))
    private readonly tmux: TmuxService,
    @Inject(forwardRef(() => SettingsService))
    private readonly settings: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => MessageActivityStreamService))
    private readonly activityStream: MessageActivityStreamService,
  ) {
    // Load initial config from settings
    this.config = this.loadConfigFromSettings();
    logger.info({ config: this.config }, 'SessionsMessagePoolService initialized with config');
  }

  /**
   * Load configuration from SettingsService.
   */
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

  /**
   * Get configuration for a specific project.
   * Uses project-specific overrides if defined, otherwise falls back to global config.
   */
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

  /**
   * Reload configuration from SettingsService.
   * Call this after settings are updated to apply changes.
   */
  reloadConfig(): void {
    this.config = this.loadConfigFromSettings();
    logger.info({ config: this.config }, 'Message pool configuration reloaded');
  }

  /**
   * Update pool configuration. Partial updates are merged with defaults.
   */
  configure(config: Partial<MessagePoolConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Message pool configuration updated');
  }

  /**
   * Compare two pool configs for equality.
   * Used to detect config changes for hot-reload.
   */
  private configsEqual(a: MessagePoolConfig, b: MessagePoolConfig): boolean {
    return (
      a.enabled === b.enabled &&
      a.delayMs === b.delayMs &&
      a.maxWaitMs === b.maxWaitMs &&
      a.maxMessages === b.maxMessages &&
      a.separator === b.separator
    );
  }

  /**
   * Reset pool timers with new config values.
   * Preserves first-message timestamp for max-wait calculation.
   */
  private resetPoolTimers(agentId: string, pool: AgentPool, newConfig: MessagePoolConfig): void {
    // Clear existing timers
    if (pool.timer) {
      clearTimeout(pool.timer);
      pool.timer = null;
    }
    if (pool.maxWaitTimer) {
      clearTimeout(pool.maxWaitTimer);
      pool.maxWaitTimer = null;
    }

    // Recalculate max-wait from first message timestamp
    const elapsed = Date.now() - pool.firstEnqueueTime;
    const remaining = newConfig.maxWaitMs - elapsed;

    if (remaining <= 0) {
      // Max wait already exceeded; schedule a next-tick flush so the current enqueue can finish
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

  /**
   * Enqueue a message for delivery to an agent's session.
   *
   * @param agentId - Target agent ID
   * @param text - Message text to deliver
   * @param options - Enqueue options
   * @returns Result indicating queued, delivered, or failed status
   */
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

    // Resolve project info for logging and config lookup
    const { projectId, agentName } = await this.resolveProjectInfo(agentId, options);

    // Get project-specific config (falls back to global if no project overrides)
    const projectConfig = this.getConfigForProject(projectId);

    const logEntryId = randomUUID();
    const timestamp = Date.now();

    // Immediate delivery bypasses the pool
    // Also bypass if pooling is disabled (check project-specific config)
    if (immediate || !projectConfig.enabled) {
      const reason = immediate ? 'immediate flag' : 'pooling disabled';
      logger.debug(
        { agentId, projectId, source, reason },
        'Bypassing pool, delivering immediately',
      );

      // Create log entry for immediate message
      const logEntry: MessageLogEntry = {
        id: logEntryId,
        timestamp,
        projectId,
        agentId,
        agentName,
        text,
        source,
        senderAgentId,
        status: 'queued', // Will be updated after delivery attempt
        immediate: true,
      };
      this.addLogEntry(logEntry);

      try {
        await this.deliverMessage(agentId, text, submitKeys);
        this.updateLogEntry(logEntryId, { status: 'delivered', deliveredAt: Date.now() });
        // Broadcast delivered (immediate messages have no batchId)
        const deliveredEntry = this.getLogEntryById(logEntryId);
        if (deliveredEntry) {
          this.activityStream.broadcastDelivered(logEntryId, [deliveredEntry]);
        }
        return { status: 'delivered' };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ agentId, source, error: errorMsg }, 'Immediate delivery failed');
        this.updateLogEntry(logEntryId, { status: 'failed', error: errorMsg });
        // Broadcast failure
        const failedEntry = this.getLogEntryById(logEntryId);
        if (failedEntry) {
          this.activityStream.broadcastFailed(failedEntry);
        }
        return { status: 'failed', error: errorMsg };
      }
    }

    // Get or create pool for this agent
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

      // Start max-wait timer on first enqueue (using project-specific maxWaitMs)
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
      // HOT-RELOAD: Check if config has changed since pool was created
      if (!this.configsEqual(pool.config, projectConfig)) {
        logger.debug(
          { agentId, projectId, oldConfig: pool.config, newConfig: projectConfig },
          'Pool config changed, updating timers',
        );

        // Store old maxMessages to detect threshold reduction
        const oldMaxMessages = pool.config.maxMessages;

        // Update stored config
        pool.config = projectConfig;

        // Reset timers with new values if pool has pending messages
        if (pool.messages.length > 0) {
          this.resetPoolTimers(agentId, pool, projectConfig);
        }

        // Edge case: If maxMessages was reduced below current message count,
        // trigger immediate flush (after adding the new message below)
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

    // Create log entry for pooled message
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
    this.addLogEntry(logEntry);

    // Add message to pool
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

    // Check if max messages reached (using pool's project-specific config)
    if (pool.messages.length >= pool.config.maxMessages) {
      logger.debug(
        { agentId, projectId, count: pool.messages.length, maxMessages: pool.config.maxMessages },
        'Max messages reached, flushing',
      );
      const flushResult = await this.flushNow(agentId);
      if (!flushResult.success) {
        return { status: 'failed', error: flushResult.reason };
      }
      return { status: 'delivered' };
    }

    // Reset debounce timer (using pool's project-specific delayMs)
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

  /**
   * Immediately flush all pending messages for a specific agent.
   *
   * @param agentId - Target agent ID
   * @returns FlushResult indicating success/failure with delivery counts
   */
  async flushNow(agentId: string): Promise<FlushResult> {
    const pool = this.pools.get(agentId);
    if (!pool || pool.messages.length === 0) {
      logger.debug({ agentId }, 'No messages to flush');
      return { success: true, deliveredCount: 0 };
    }

    // Clear timers
    if (pool.timer) {
      clearTimeout(pool.timer);
      pool.timer = null;
    }
    if (pool.maxWaitTimer) {
      clearTimeout(pool.maxWaitTimer);
      pool.maxWaitTimer = null;
    }

    // Extract messages and config before deleting pool
    const messages = [...pool.messages];
    const poolConfig = pool.config;
    this.pools.delete(agentId);

    logger.info(
      { agentId, projectId: pool.projectId, messageCount: messages.length },
      'Flushing message pool',
    );

    // Use agent lock to prevent race conditions
    let result: FlushResult = { success: true, deliveredCount: messages.length };
    await this.coordinator.withAgentLock(agentId, async () => {
      result = await this.deliverBatch(agentId, messages, poolConfig.separator);
    });
    return result;
  }

  /**
   * Flush all pending message pools for all agents.
   * Useful for graceful shutdown.
   */
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

  /**
   * Get current pool statistics for monitoring.
   */
  getPoolStats(): { agentId: string; messageCount: number; waitingMs: number }[] {
    const now = Date.now();
    return Array.from(this.pools.entries()).map(([agentId, pool]) => ({
      agentId,
      messageCount: pool.messages.length,
      waitingMs: now - pool.firstEnqueueTime,
    }));
  }

  /**
   * Get extended pool details for UI display.
   * Includes message previews and agent context.
   *
   * @param projectId - Optional filter by project ID
   * @returns Array of pool details, sorted by waitingMs descending (longest waiting first)
   */
  getPoolDetails(projectId?: string): PoolDetails[] {
    const now = Date.now();
    const PREVIEW_LENGTH = 100;

    const details: PoolDetails[] = [];

    for (const [agentId, pool] of this.pools.entries()) {
      if (pool.messages.length === 0) continue;

      // Get agent name and project ID from first message's log entry
      const firstMessage = pool.messages[0];
      const logEntryIndex = this.logIndex.get(firstMessage.logEntryId);
      const logEntry = logEntryIndex !== undefined ? this.messageLog[logEntryIndex] : null;

      const poolProjectId = logEntry?.projectId ?? 'unknown';
      const agentName = logEntry?.agentName ?? 'unknown';

      // Filter by projectId if provided
      if (projectId && poolProjectId !== projectId) {
        continue;
      }

      // Build message previews
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

    // Sort by waitingMs descending (longest waiting first)
    details.sort((a, b) => b.waitingMs - a.waitingMs);

    return details;
  }

  /**
   * Lifecycle hook: flush all pools on module destroy with timeout.
   * Ensures graceful shutdown by attempting to deliver pending messages
   * while not blocking shutdown indefinitely.
   */
  async onModuleDestroy(): Promise<void> {
    const poolStats = this.getPoolStats();
    const totalMessages = poolStats.reduce((sum, p) => sum + p.messageCount, 0);

    logger.info(
      { agentCount: poolStats.length, totalMessages },
      'Shutting down message pool, flushing pending messages...',
    );

    // Clear all timers to prevent new flushes during shutdown
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

    // Flush all pools with a 5 second timeout
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

  /**
   * Notify senders of delivery failure (best-effort, with loop prevention).
   *
   * @param messages - The messages that failed to deliver
   * @param recipientAgentId - The agent whose session was unavailable
   * @param reason - The failure reason
   */
  private async notifySendersOfFailure(
    messages: PooledMessage[],
    recipientAgentId: string,
    reason: string,
  ): Promise<void> {
    // Collect unique sender agent IDs, excluding failure notices (loop prevention)
    const senderAgentIds = new Set<string>();
    for (const msg of messages) {
      if (msg.senderAgentId && msg.source !== FAILURE_NOTICE_SOURCE) {
        senderAgentIds.add(msg.senderAgentId);
      }
    }

    if (senderAgentIds.size === 0) {
      logger.debug({ recipientAgentId }, 'No senders to notify of failure');
      return;
    }

    logger.info(
      { recipientAgentId, senderCount: senderAgentIds.size, reason },
      'Notifying senders of delivery failure',
    );

    // Notify each sender (best-effort, errors swallowed)
    for (const senderAgentId of senderAgentIds) {
      try {
        const failureMessage = `[Delivery Failed] Message to agent ${recipientAgentId} could not be delivered: ${reason}`;

        await this.enqueue(senderAgentId, failureMessage, {
          source: FAILURE_NOTICE_SOURCE,
          immediate: true, // Bypass pool to ensure immediate delivery
          submitKeys: ['Enter'],
        });

        logger.debug({ senderAgentId, recipientAgentId }, 'Failure notification sent to sender');
      } catch (error) {
        // Best-effort: swallow errors, just log
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(
          { senderAgentId, recipientAgentId, error: errorMsg },
          'Failed to notify sender of delivery failure (best-effort, ignored)',
        );
      }
    }
  }

  /**
   * Deliver a batch of messages to an agent's session.
   * @param agentId - Target agent ID
   * @param messages - Messages to deliver
   * @param separator - Separator for concatenating messages (from pool's project config)
   * @returns FlushResult indicating success/failure
   */
  private async deliverBatch(
    agentId: string,
    messages: PooledMessage[],
    separator: string = this.config.separator,
  ): Promise<FlushResult> {
    // Generate batch ID for this delivery
    const batchId = randomUUID();

    // Find active session for agent
    const activeSessions = await this.sessions.listActiveSessions();
    const session = activeSessions.find((s) => s.agentId === agentId);

    if (!session || !session.tmuxSessionId) {
      logger.warn(
        { agentId, messageCount: messages.length },
        'No active session for agent, messages discarded',
      );
      // Update log entries with failure status and broadcast
      for (const msg of messages) {
        this.updateLogEntry(msg.logEntryId, {
          status: 'failed',
          batchId,
          error: 'No active session',
        });
        const entry = this.getLogEntryById(msg.logEntryId);
        if (entry) {
          this.activityStream.broadcastFailed(entry);
        }
      }
      this.broadcastPoolsUpdate();
      // Notify senders of failure (best-effort)
      await this.notifySendersOfFailure(messages, agentId, 'No active session');
      return { success: false, discardedCount: messages.length, reason: 'No active session' };
    }

    const tmuxSessionId = session.tmuxSessionId;

    // Concatenate messages with separator (using project-specific separator)
    const combinedText = messages.map((m) => m.text).join(separator);

    // Use last message's submit keys (or default)
    const submitKeys = messages[messages.length - 1]?.submitKeys ?? ['Enter'];

    try {
      // Ensure gap before sending
      await this.sendCoordinator.ensureAgentGap(agentId, 1000);

      // Paste and submit
      await this.tmux.pasteAndSubmit(tmuxSessionId, combinedText, {
        bracketed: true,
        submitKeys,
      });

      // Update log entries with delivered status
      const deliveredAt = Date.now();
      const deliveredEntries: MessageLogEntry[] = [];
      for (const msg of messages) {
        this.updateLogEntry(msg.logEntryId, {
          status: 'delivered',
          batchId,
          deliveredAt,
        });
        const entry = this.getLogEntryById(msg.logEntryId);
        if (entry) {
          deliveredEntries.push(entry);
        }
      }

      // Broadcast delivered batch and pool update
      this.activityStream.broadcastDelivered(batchId, deliveredEntries);
      this.broadcastPoolsUpdate();

      logger.info(
        { agentId, sessionId: session.id, messageCount: messages.length, batchId },
        'Batch delivered to agent session',
      );

      return { success: true, deliveredCount: messages.length };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, sessionId: session.id, error: errorMsg },
        'Failed to deliver batch to agent session',
      );
      // Update log entries with failure status and broadcast
      for (const msg of messages) {
        this.updateLogEntry(msg.logEntryId, {
          status: 'failed',
          batchId,
          error: errorMsg,
        });
        const entry = this.getLogEntryById(msg.logEntryId);
        if (entry) {
          this.activityStream.broadcastFailed(entry);
        }
      }
      this.broadcastPoolsUpdate();
      // Notify senders of failure (best-effort)
      await this.notifySendersOfFailure(messages, agentId, errorMsg);
      return { success: false, discardedCount: messages.length, reason: errorMsg };
    }
  }

  /**
   * Deliver a single message immediately (for immediate mode).
   */
  private async deliverMessage(agentId: string, text: string, submitKeys: string[]): Promise<void> {
    // Find active session for agent
    const activeSessions = await this.sessions.listActiveSessions();
    const session = activeSessions.find((s) => s.agentId === agentId);

    if (!session || !session.tmuxSessionId) {
      throw new Error(`No active session for agent ${agentId}`);
    }

    const tmuxSessionId = session.tmuxSessionId;

    // Use agent lock for consistency
    await this.coordinator.withAgentLock(agentId, async () => {
      await this.sendCoordinator.ensureAgentGap(agentId, 1000);
      await this.tmux.pasteAndSubmit(tmuxSessionId, text, {
        bracketed: true,
        submitKeys,
      });
    });

    logger.info({ agentId, sessionId: session.id }, 'Immediate message delivered');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Log Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the message log, optionally filtered.
   *
   * @param options - Filter options
   * @returns Array of log entries (newest first)
   */
  getMessageLog(options?: {
    projectId?: string;
    agentId?: string;
    status?: MessageLogEntry['status'];
    source?: string;
    limit?: number;
  }): MessageLogEntry[] {
    let entries = [...this.messageLog].reverse(); // Newest first

    if (options?.projectId) {
      entries = entries.filter((e) => e.projectId === options.projectId);
    }
    if (options?.agentId) {
      entries = entries.filter((e) => e.agentId === options.agentId);
    }
    if (options?.status) {
      entries = entries.filter((e) => e.status === options.status);
    }
    if (options?.source) {
      entries = entries.filter((e) => e.source === options.source);
    }
    if (options?.limit && options.limit > 0) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Get log statistics for monitoring.
   */
  getLogStats(): { entryCount: number; bytesUsed: number; maxEntries: number; maxBytes: number } {
    return {
      entryCount: this.messageLog.length,
      bytesUsed: this.logBytes,
      maxEntries: MAX_LOG_ENTRIES,
      maxBytes: MAX_LOG_BYTES,
    };
  }

  /**
   * Get a single message by ID.
   *
   * @param messageId - The message ID to look up
   * @returns The message log entry, or null if not found
   */
  getMessageById(messageId: string): MessageLogEntry | null {
    const index = this.logIndex.get(messageId);
    if (index === undefined) {
      return null;
    }
    return this.messageLog[index] ?? null;
  }

  /**
   * Add a new entry to the message log.
   */
  private addLogEntry(entry: MessageLogEntry): void {
    this.pruneLogIfNeeded(entry.text.length);

    this.messageLog.push(entry);
    this.logBytes += entry.text.length;
    this.logIndex.set(entry.id, this.messageLog.length - 1);

    logger.debug(
      { messageId: entry.id, logSize: this.messageLog.length, logBytes: this.logBytes },
      'Message log entry added',
    );

    // Broadcast activity update
    this.activityStream.broadcastEnqueued(entry);
    this.broadcastPoolsUpdate();
  }

  /**
   * Broadcast current pool state to connected clients.
   */
  private broadcastPoolsUpdate(): void {
    const pools = this.getPoolDetails();
    this.activityStream.broadcastPoolsUpdated(pools);
  }

  /**
   * Get a log entry by ID.
   */
  private getLogEntryById(messageId: string): MessageLogEntry | null {
    const index = this.logIndex.get(messageId);
    if (index === undefined) {
      return null;
    }
    return this.messageLog[index] ?? null;
  }

  /**
   * Update an existing log entry by ID.
   */
  private updateLogEntry(
    messageId: string,
    updates: Partial<Pick<MessageLogEntry, 'status' | 'batchId' | 'deliveredAt' | 'error'>>,
  ): void {
    const index = this.logIndex.get(messageId);
    if (index === undefined || !this.messageLog[index]) {
      logger.debug({ messageId }, 'Log entry not found for update');
      return;
    }

    const entry = this.messageLog[index];
    Object.assign(entry, updates);

    logger.debug({ messageId, updates }, 'Message log entry updated');
  }

  /**
   * Prune oldest non-queued entries if log exceeds memory limits.
   * Protects queued entries (not yet delivered) from being pruned.
   * @param incomingBytes - Size of incoming message text
   */
  private pruneLogIfNeeded(incomingBytes: number): void {
    // Check if we're approaching limits (warn at 80%)
    const bytesThreshold = MAX_LOG_BYTES * LOG_WARNING_THRESHOLD;
    const entriesThreshold = MAX_LOG_ENTRIES * LOG_WARNING_THRESHOLD;

    if (this.logBytes >= bytesThreshold || this.messageLog.length >= entriesThreshold) {
      logger.warn(
        {
          entryCount: this.messageLog.length,
          maxEntries: MAX_LOG_ENTRIES,
          bytesUsed: this.logBytes,
          maxBytes: MAX_LOG_BYTES,
        },
        'Message log approaching memory limits',
      );
    }

    let pruned = false;

    // Prune if adding incoming message would exceed limits
    // Recompute limits during each iteration to avoid over-pruning
    while (
      this.messageLog.length + 1 > MAX_LOG_ENTRIES ||
      this.logBytes + incomingBytes > MAX_LOG_BYTES
    ) {
      // Find oldest non-queued entry to remove (protect queued entries)
      const idx = this.messageLog.findIndex((e) => e.status !== 'queued');

      if (idx === -1) {
        // All entries are queued, can't prune without losing pending messages
        logger.warn(
          {
            entryCount: this.messageLog.length,
            queuedCount: this.messageLog.length,
            bytesUsed: this.logBytes,
            incomingBytes,
          },
          'Cannot prune message log: all entries are queued',
        );
        break;
      }

      const removed = this.messageLog.splice(idx, 1)[0];
      this.logBytes -= removed.text.length;
      this.logIndex.delete(removed.id);
      pruned = true;
    }

    // Rebuild index after pruning (indices shifted)
    if (pruned) {
      this.logIndex.clear();
      this.messageLog.forEach((entry, idx) => {
        this.logIndex.set(entry.id, idx);
      });
    }
  }

  /**
   * Resolve project info from options or storage.
   * Falls back to storage lookup if not provided in options.
   */
  private async resolveProjectInfo(
    agentId: string,
    options: EnqueueOptions,
  ): Promise<{ projectId: string; agentName: string }> {
    let projectId = options.projectId ?? 'unknown';
    let agentName = options.agentName ?? 'unknown';

    // If projectId or agentName not provided, try to resolve from storage
    if (!options.projectId || !options.agentName) {
      try {
        const agent = await this.storage.getAgent(agentId);
        if (!options.agentName) {
          agentName = agent.name;
        }
        if (!options.projectId && agent.projectId) {
          projectId = agent.projectId;
        }
      } catch (error) {
        logger.debug({ agentId, error }, 'Failed to resolve project info from storage');
      }
    }

    return { projectId, agentName };
  }
}
