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
  type ForceDeferredResult,
  type DeliveryFailureCode,
  type FailureDisclosurePolicy,
  type MessageLogEntry,
  type PoolDetails,
} from './message-pool.types';
import type { SessionActivityChangedEventPayload } from '../../events/catalog/session.activity.changed';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';
import {
  sessionHumanPromptStateChangedEvent,
  type SessionHumanPromptStateChangedEventPayload,
} from '../../events/catalog/session.human-prompt-state-changed';
import {
  HumanPromptStateService,
  type HumanPromptQuietSnapshot,
  type ForcePromptSnapshot,
} from '../../terminal/services/human-prompt-state.service';
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
  type ForceDeferredResult,
  type DeliveryFailureCode,
  type FailureDisclosurePolicy,
  type MessageLogEntry,
  type PoolDetails,
  type DeferredHoldReason,
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

interface AgentDeferredLane {
  readonly sessionId: string;
  readonly tmuxSessionName: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly messages: PooledMessage[];
  separator: string;
  requiredGeneration: number | null;
  quietTimer: NodeJS.Timeout | null;
  quietBaseline: HumanPromptQuietSnapshot | null;
  activeClaim: DeferredLaneClaim | null;
}

interface ResolvedEnqueueInput {
  readonly agentId: string;
  readonly text: string;
  readonly source: string;
  readonly submitKeys: string[];
  readonly preKeys?: string[];
  readonly preDelayMs?: number;
  readonly senderAgentId?: string;
  readonly clientMessageId?: string;
  readonly failureDisclosure: FailureDisclosurePolicy;
  readonly projectId: string;
  readonly agentName: string;
  readonly logEntryId: string;
  readonly timestamp: number;
  readonly deliveryMode: MessageDeliveryMode;
  readonly deferWhileHumanTyping: boolean;
  readonly humanPromptSubmit: boolean;
}

type DeferredClaimOutcome = 'delivered' | 'unconfirmed' | 'deferred' | 'failed';

type DeferredClaimState =
  | { readonly phase: 'preparing'; readonly cancellationReason?: string }
  | { readonly phase: 'mutating' }
  | { readonly phase: 'complete'; readonly outcome: DeferredClaimOutcome };

interface DeferredLaneClaim {
  readonly agentId: string;
  readonly sessionId: string;
  readonly tmuxSessionName: string;
  readonly projectId: string;
  readonly messages: PooledMessage[];
  readonly separator: string;
  readonly quietSnapshot: HumanPromptQuietSnapshot | null;
  readonly forceSnapshot: ForcePromptSnapshot | null;
  state: DeferredClaimState;
  detachReason?: string;
  readonly completion: Promise<AgentDeferredLane | null>;
  readonly resolveCompletion: (failureLane: AgentDeferredLane | null) => void;
}

interface DeferredLaneDetachment {
  readonly reason: string;
  readonly failureLane: AgentDeferredLane | null;
  readonly claimCompletion: Promise<AgentDeferredLane | null> | null;
}

export type ManualHumanHoldReleaseResult =
  | { readonly status: 'released' }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_ready'; readonly eligibleAt: number | null };

export const HUMAN_DRAFT_IDLE_GRACE_MS = 2_000;
export const FORCE_ELIGIBLE_DELAY_MS = 30_000;

function canStartDeferredClaimMutation(claim: DeferredLaneClaim): boolean {
  return claim.state.phase === 'preparing' && !claim.state.cancellationReason;
}

function deferredClaimCancellationResult(
  claim: DeferredLaneClaim | undefined,
  discardedCount: number,
): FlushResult | null {
  const reason = claim?.state.phase === 'preparing' ? claim.state.cancellationReason : undefined;
  return reason ? { success: false, discardedCount, reason } : null;
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
  private deferredLanes = new Map<string, AgentDeferredLane>();
  private config: MessagePoolConfig;
  private closing = false;

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
    private readonly humanPromptState: HumanPromptStateService,
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

    if (options.deferWhileHumanTyping || options.humanPromptSubmit || deliveryMode === 'on_idle') {
      return this.enqueueSerialized({
        agentId,
        text,
        source,
        submitKeys,
        preKeys,
        preDelayMs,
        senderAgentId,
        clientMessageId,
        failureDisclosure,
        projectId,
        agentName,
        logEntryId,
        timestamp,
        deliveryMode,
        deferWhileHumanTyping: options.deferWhileHumanTyping === true,
        humanPromptSubmit: options.humanPromptSubmit === true,
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

  private async enqueueSerialized(input: ResolvedEnqueueInput): Promise<EnqueueResult> {
    while (true) {
      const step:
        | { result: EnqueueResult; claim: DeferredLaneClaim | null }
        | { detachment: DeferredLaneDetachment } = await this.coordinator.withAgentLock(
        input.agentId,
        async () => {
          const activeSession = this.sessions.getActiveSessionForAgent(input.agentId);
          const existingLane = this.deferredLanes.get(input.agentId);
          if (existingLane && existingLane.sessionId !== activeSession?.id) {
            return {
              detachment: this.detachDeferredLaneUnderAgentLock(
                existingLane,
                'Target session was replaced before deferred delivery',
              ),
            };
          }
          const result = await this.enqueueSerializedUnderAgentLock(input);
          const claim =
            result.status === 'queued' &&
            input.deliveryMode === 'on_idle' &&
            activeSession?.activityState === 'idle'
              ? this.claimDeferredLaneUnderAgentLock(input.agentId, activeSession.id, false)
              : null;
          return { result, claim };
        },
      );

      if ('result' in step) {
        if (!step.claim) return step.result;
        const flushResult = await this.deliverDeferredClaim(step.claim);
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
      await this.settleDeferredLaneDetachment(step.detachment);
    }
  }

  private async enqueueSerializedUnderAgentLock(
    input: ResolvedEnqueueInput,
  ): Promise<EnqueueResult> {
    const duplicate = this.findDuplicate(input);
    if (duplicate) return duplicate;

    const projectConfig = this.getConfigForProject(input.projectId, input.failureDisclosure);
    const activeSession = this.sessions.getActiveSessionForAgent(input.agentId);
    const promptState = activeSession?.tmuxSessionId
      ? this.humanPromptState.getState(activeSession.tmuxSessionId)
      : null;
    const heldGeneration =
      input.deferWhileHumanTyping && promptState && promptState.phase !== 'inactive'
        ? promptState.generation
        : undefined;

    if (heldGeneration !== undefined || input.deliveryMode === 'on_idle') {
      return this.enqueueDeferredUnderAgentLock(
        input,
        projectConfig,
        activeSession,
        heldGeneration,
      );
    }

    if (input.humanPromptSubmit || input.deliveryMode === 'immediate' || !projectConfig.enabled) {
      const logEntry = this.createLogEntry(input, true);
      this.messageLog.addEntry(logEntry);
      this.activityStream.broadcastEnqueued(logEntry);
      this.broadcastPoolsUpdate();
      return this.deliverImmediateUnderAgentLock(input, logEntry);
    }

    return this.enqueueProtectedPoolUnderAgentLock(input, projectConfig);
  }

  private findDuplicate(input: ResolvedEnqueueInput): EnqueueResult | null {
    if (!input.clientMessageId) return null;
    const existing = this.messageLog.findByClientMessageId(
      input.clientMessageId,
      input.agentId,
      input.source,
    );
    return existing ? { status: existing.status, logEntryId: existing.id } : null;
  }

  private createLogEntry(input: ResolvedEnqueueInput, immediate: boolean): MessageLogEntry {
    return {
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
      immediate,
    };
  }

  private createPooledMessage(
    input: ResolvedEnqueueInput,
    options?: { requiresProviderIdle?: boolean; heldGeneration?: number },
  ): PooledMessage {
    return {
      text: input.text,
      source: input.source,
      timestamp: input.timestamp,
      submitKeys: input.submitKeys,
      senderAgentId: input.senderAgentId,
      logEntryId: input.logEntryId,
      clientMessageId: input.clientMessageId,
      failureDisclosure: input.failureDisclosure,
      deferWhileHumanTyping: input.deferWhileHumanTyping,
      requiresProviderIdle: options?.requiresProviderIdle === true,
      heldGeneration: options?.heldGeneration,
    };
  }

  private async enqueueProtectedPoolUnderAgentLock(
    input: ResolvedEnqueueInput,
    projectConfig: MessagePoolConfig,
  ): Promise<EnqueueResult> {
    if (this.getSharedQueuedCount(input.agentId) >= projectConfig.maxMessages) {
      return this.capacityFailure(input.failureDisclosure);
    }

    let pool = this.pools.get(input.agentId);
    if (!pool) {
      pool = this.createAgentPool(input.agentId, input.projectId, projectConfig);
    } else if (!this.configsEqual(pool.config, projectConfig)) {
      pool.config = projectConfig;
      if (pool.messages.length > 0) this.resetPoolTimers(input.agentId, pool, projectConfig);
    }

    const logEntry = this.createLogEntry(input, false);
    this.messageLog.addEntry(logEntry);
    pool.messages.push(this.createPooledMessage(input));
    this.activityStream.broadcastEnqueued(logEntry);
    this.broadcastPoolsUpdate();

    if (pool.messages.length >= pool.config.maxMessages) {
      const result = await this.flushPoolUnderAgentLock(input.agentId);
      if (!result.success) return { status: 'failed', error: result.reason };
      if (result.outcome === 'deferred') {
        return {
          status: 'queued',
          poolSize: this.getSharedQueuedCount(input.agentId),
          logEntryId: input.logEntryId,
        };
      }
      return {
        status: result.outcome === 'unconfirmed' ? 'unconfirmed' : 'delivered',
        logEntryId: input.logEntryId,
      };
    }

    this.schedulePoolDebounce(input.agentId, pool);
    return {
      status: 'queued',
      poolSize: this.getSharedQueuedCount(input.agentId),
      logEntryId: input.logEntryId,
    };
  }

  private async enqueueDeferredUnderAgentLock(
    input: ResolvedEnqueueInput,
    projectConfig: MessagePoolConfig,
    activeSession: ReturnType<SessionsService['getActiveSessionForAgent']>,
    heldGeneration: number | undefined,
  ): Promise<EnqueueResult> {
    if (!activeSession?.tmuxSessionId) {
      const failure = classifyDeliveryFailure(
        input.failureDisclosure,
        'No active session',
        'no_active_session',
      );
      return { status: 'failed', error: failure.error };
    }

    if (this.getSharedQueuedCount(input.agentId) >= projectConfig.maxMessages) {
      return this.capacityFailure(input.failureDisclosure);
    }

    let lane = this.deferredLanes.get(input.agentId);
    if (!lane) {
      lane = {
        sessionId: activeSession.id,
        tmuxSessionName: activeSession.tmuxSessionId,
        agentId: input.agentId,
        projectId: input.projectId,
        messages: [],
        separator: projectConfig.separator,
        requiredGeneration: heldGeneration ?? null,
        quietTimer: null,
        quietBaseline: null,
        activeClaim: null,
      };
      this.deferredLanes.set(input.agentId, lane);
    }
    lane.separator = projectConfig.separator;

    const logEntry = this.createLogEntry(
      input,
      input.deliveryMode === 'immediate' || !projectConfig.enabled,
    );
    const message = this.createPooledMessage(input, {
      requiresProviderIdle: input.deliveryMode === 'on_idle',
      heldGeneration,
    });
    this.messageLog.addEntry(logEntry);
    lane.messages.push(message);
    if (heldGeneration !== undefined) this.rebindLaneGeneration(lane, heldGeneration);
    this.activityStream.broadcastEnqueued(logEntry);
    this.broadcastPoolsUpdate();

    if (lane.requiredGeneration !== null) {
      this.ensureHumanQuietTimerUnderAgentLock(lane);
    }

    return {
      status: 'queued',
      poolSize: this.getSharedQueuedCount(input.agentId),
      logEntryId: input.logEntryId,
    };
  }

  private capacityFailure(failureDisclosure: FailureDisclosurePolicy): EnqueueResult {
    const failure = classifyDeliveryFailure(
      failureDisclosure,
      'Message pool capacity reached',
      'pool_capacity_exceeded',
    );
    return { status: 'failed', error: failure.error };
  }

  private getSharedQueuedCount(agentId: string): number {
    return (
      (this.pools.get(agentId)?.messages.length ?? 0) +
      (this.deferredLanes.get(agentId)?.messages.length ?? 0)
    );
  }

  private createAgentPool(
    agentId: string,
    projectId: string,
    config: MessagePoolConfig,
  ): AgentPool {
    const pool: AgentPool = {
      messages: [],
      timer: null,
      maxWaitTimer: null,
      firstEnqueueTime: Date.now(),
      config,
      projectId,
    };
    this.pools.set(agentId, pool);
    pool.maxWaitTimer = setTimeout(() => {
      void this.flushNow(agentId);
    }, config.maxWaitMs);
    return pool;
  }

  private schedulePoolDebounce(agentId: string, pool: AgentPool): void {
    if (pool.timer) clearTimeout(pool.timer);
    pool.timer = setTimeout(() => {
      void this.flushNow(agentId);
    }, pool.config.delayMs);
  }

  async flushNow(agentId: string): Promise<FlushResult> {
    while (true) {
      const step: { result: FlushResult } | { detachment: DeferredLaneDetachment } =
        await this.coordinator.withAgentLock(agentId, async () => {
          const activeSession = this.sessions.getActiveSessionForAgent(agentId);
          const existingLane = this.deferredLanes.get(agentId);
          if (existingLane && existingLane.sessionId !== activeSession?.id) {
            return {
              detachment: this.detachDeferredLaneUnderAgentLock(
                existingLane,
                'Target session was replaced before deferred delivery',
              ),
            };
          }
          return { result: await this.flushPoolUnderAgentLock(agentId) };
        });

      if ('result' in step) return step.result;
      await this.settleDeferredLaneDetachment(step.detachment);
    }
  }

  private async flushPoolUnderAgentLock(agentId: string): Promise<FlushResult> {
    const pool = this.pools.get(agentId);
    if (!pool || pool.messages.length === 0) {
      return { success: true, deliveredCount: 0 };
    }

    this.clearPoolTimers(pool);
    this.pools.delete(agentId);
    const activeSession = this.sessions.getActiveSessionForAgent(agentId);
    const promptState = activeSession?.tmuxSessionId
      ? this.humanPromptState.getState(activeSession.tmuxSessionId)
      : null;
    const protectedMessages =
      promptState?.phase !== 'inactive'
        ? pool.messages.filter((message) => message.deferWhileHumanTyping)
        : [];
    const deliverableMessages =
      protectedMessages.length > 0
        ? pool.messages.filter((message) => !message.deferWhileHumanTyping)
        : [...pool.messages];

    if (
      protectedMessages.length > 0 &&
      activeSession?.tmuxSessionId &&
      promptState &&
      !this.closing
    ) {
      await this.moveMessagesToDeferredLaneUnderAgentLock(
        agentId,
        pool.projectId,
        pool.config.separator,
        activeSession,
        protectedMessages,
        promptState.generation,
      );
    } else if (protectedMessages.length > 0 && this.closing) {
      await this.failDeferredLane(
        {
          sessionId: activeSession?.id ?? 'shutdown',
          tmuxSessionName: activeSession?.tmuxSessionId ?? 'shutdown',
          agentId,
          projectId: pool.projectId,
          messages: protectedMessages,
          separator: pool.config.separator,
          requiredGeneration: promptState?.generation ?? null,
          quietTimer: null,
          quietBaseline: null,
          activeClaim: null,
        },
        'Service stopped before human-held delivery',
        false,
      );
    }

    if (deliverableMessages.length === 0) {
      this.broadcastPoolsUpdate();
      return this.closing
        ? {
            success: false,
            discardedCount: protectedMessages.length,
            reason: 'Service stopped before human-held delivery',
          }
        : { success: true, deliveredCount: 0, outcome: 'deferred' };
    }

    return this.deliverBatch(agentId, deliverableMessages, pool.config.separator);
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
    const agentIds = new Set([...this.pools.keys(), ...this.deferredLanes.keys()]);
    return Array.from(agentIds).map((agentId) => {
      const pool = this.pools.get(agentId);
      const deferredLane = this.deferredLanes.get(agentId);
      const oldestMessageTime = Math.min(
        pool?.messages[0]?.timestamp ?? Number.POSITIVE_INFINITY,
        deferredLane?.messages[0]?.timestamp ?? Number.POSITIVE_INFINITY,
      );
      return {
        agentId,
        messageCount: (pool?.messages.length ?? 0) + (deferredLane?.messages.length ?? 0),
        waitingMs: now - oldestMessageTime,
      };
    });
  }

  getPoolDetails(projectId?: string): PoolDetails[] {
    const now = Date.now();
    const PREVIEW_LENGTH = 100;
    const details: PoolDetails[] = [];

    const agentIds = new Set([...this.pools.keys(), ...this.deferredLanes.keys()]);
    for (const agentId of agentIds) {
      const pool = this.pools.get(agentId);
      const deferredLane = this.deferredLanes.get(agentId);
      const pooledMessages = [...(pool?.messages ?? []), ...(deferredLane?.messages ?? [])].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      if (pooledMessages.length === 0) continue;

      const firstMessage = pooledMessages[0];
      const logEntry = this.messageLog.getById(firstMessage.logEntryId);

      const poolProjectId =
        logEntry?.projectId ?? pool?.projectId ?? deferredLane?.projectId ?? 'unknown';
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
      const humanHeldMessageCount =
        deferredLane && deferredLane.requiredGeneration !== null ? deferredLane.messages.length : 0;
      const humanReleaseEligibleAt =
        humanHeldMessageCount > 0 && deferredLane
          ? this.humanPromptState.getManualReleaseEligibleAt(deferredLane.tmuxSessionName)
          : null;

      const detail: PoolDetails = {
        agentId,
        agentName,
        projectId: poolProjectId,
        messageCount: pooledMessages.length,
        humanHeldMessageCount,
        waitingMs: now - firstMessage.timestamp,
        messages,
      };
      if (humanReleaseEligibleAt !== null) {
        detail.humanReleaseEligibleAt = humanReleaseEligibleAt;
      }
      if (deferredLane && deferredLane.messages.length > 0) {
        const promptState = this.humanPromptState.getState(deferredLane.tmuxSessionName);
        detail.activeSessionId = deferredLane.sessionId;
        detail.deferredMessageIds = deferredLane.messages.map((m) => m.logEntryId);
        if (promptState.phase === 'draft_active') {
          detail.holdReason = 'human_draft';
        } else {
          detail.holdReason = deferredLane.messages.some((m) => m.requiresProviderIdle)
            ? 'awaiting_idle'
            : 'awaiting_quiet';
          // Force delivery is never offered over an active human draft.
          detail.forceEligibleAt = deferredLane.messages[0].timestamp + FORCE_ELIGIBLE_DELAY_MS;
        }
      }
      details.push(detail);
    }

    details.sort((a, b) => b.waitingMs - a.waitingMs);
    return details;
  }

  async releaseHumanHeldMessages(
    agentId: string,
    projectId: string,
  ): Promise<ManualHumanHoldReleaseResult> {
    return this.coordinator.withAgentLock(agentId, async () => {
      const lane = this.deferredLanes.get(agentId);
      const activeSession = this.sessions.getActiveSessionForAgent(agentId);
      if (
        !lane ||
        lane.projectId !== projectId ||
        !activeSession?.tmuxSessionId ||
        activeSession.id !== lane.sessionId ||
        activeSession.tmuxSessionId !== lane.tmuxSessionName ||
        lane.requiredGeneration === null
      ) {
        return { status: 'not_found' };
      }

      const eligibleAt = this.humanPromptState.getManualReleaseEligibleAt(lane.tmuxSessionName);
      if (eligibleAt === null || Date.now() < eligibleAt) {
        return { status: 'not_ready', eligibleAt };
      }

      const state = this.humanPromptState.getState(lane.tmuxSessionName);
      if (state.phase !== 'draft_active') {
        return { status: 'not_ready', eligibleAt: null };
      }
      const transition = this.humanPromptState.transitionToAwaiting(
        lane.tmuxSessionName,
        state.generation,
        true,
      );
      if (!transition.accepted) {
        return { status: 'not_ready', eligibleAt: null };
      }

      await this.handleHumanPromptStateChangedUnderAgentLock(agentId, {
        sessionId: lane.sessionId,
        tmuxSessionName: lane.tmuxSessionName,
        generation: transition.state.generation,
        phase: 'awaiting_stable_idle',
      });
      return { status: 'released' };
    });
  }

  async forceDeferredDelivery(
    agentId: string,
    projectId: string,
    sessionId: string,
    messageIds: string[],
  ): Promise<ForceDeferredResult> {
    let forceClaim: DeferredLaneClaim | null = null;
    const rejection = await this.coordinator.withAgentLock(
      agentId,
      async (): Promise<ForceDeferredResult | null> => {
        const lane = this.deferredLanes.get(agentId);
        const activeSession = this.sessions.getActiveSessionForAgent(agentId);
        const session = this.sessions.getSession(sessionId);
        if (
          !lane ||
          lane.projectId !== projectId ||
          lane.sessionId !== sessionId ||
          !session ||
          session.status !== 'running' ||
          session.tmuxSessionId !== lane.tmuxSessionName ||
          activeSession?.id !== sessionId
        ) {
          return { status: 'not_found' };
        }
        if (lane.activeClaim) {
          return { status: 'conflict', reason: 'Delivery already in progress' };
        }
        const laneIds = lane.messages.map((m) => m.logEntryId);
        if (
          messageIds.length !== laneIds.length ||
          !messageIds.every((id, i) => id === laneIds[i])
        ) {
          return { status: 'conflict', reason: 'Message batch has changed' };
        }
        const oldest = lane.messages[0];
        if (!oldest || Date.now() - oldest.timestamp < FORCE_ELIGIBLE_DELAY_MS) {
          return { status: 'conflict', reason: 'Messages not yet eligible for force send' };
        }
        const forceSnapshot = this.humanPromptState.getForceSnapshot(lane.tmuxSessionName);
        if (!forceSnapshot) {
          return { status: 'conflict', reason: 'Active human draft prevents force send' };
        }

        forceClaim = this.startDeferredClaimUnderAgentLock(agentId, lane, {
          quietSnapshot: null,
          forceSnapshot,
        });
        return null;
      },
    );
    if (rejection) return rejection;

    const result = await this.deliverDeferredClaim(forceClaim!);
    if (result.outcome === 'delivered') {
      return { status: 'delivered', deliveredCount: result.deliveredCount ?? 0 };
    }
    if (result.outcome === 'unconfirmed') {
      return { status: 'unconfirmed', deliveredCount: result.deliveredCount ?? 0 };
    }
    if (result.outcome === 'deferred') {
      return { status: 'deferred', reason: 'Input changed before paste' };
    }
    return { status: 'failed', reason: result.reason ?? 'Delivery failed' };
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    const poolStats = this.getPoolStats();
    const totalMessages = poolStats.reduce((sum, p) => sum + p.messageCount, 0);

    logger.info(
      { agentCount: poolStats.length, totalMessages },
      'Shutting down message pool, flushing default lanes and failing deferred lanes...',
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

    const deferredLanes = Array.from(this.deferredLanes.values());
    const deferredSettlements: Promise<void>[] = [];
    for (const lane of deferredLanes) {
      const detachment = await this.coordinator.withAgentLock(lane.agentId, async () => {
        const current = this.deferredLanes.get(lane.agentId);
        return current === lane
          ? this.detachDeferredLaneUnderAgentLock(lane, 'Service stopped before deferred delivery')
          : null;
      });
      if (lane.requiredGeneration !== null) {
        this.humanPromptState.clearSession(lane.tmuxSessionName);
      }
      if (detachment) {
        deferredSettlements.push(this.settleDeferredLaneDetachment(detachment, false));
      }
    }
    if (deferredLanes.length > 0) {
      logger.info(
        {
          agentCount: deferredLanes.length,
          totalMessages: deferredLanes.reduce((sum, lane) => sum + lane.messages.length, 0),
        },
        'Settling deferred delivery lanes before terminal shutdown',
      );
    }

    const SHUTDOWN_TIMEOUT_MS = 5000;
    const shutdownWork = Promise.all([...deferredSettlements, this.flushAll()]).then(
      () => undefined,
    );
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        const remainingPools = this.pools.size;
        const remainingMessages = this.getPoolStats().reduce(
          (sum, pool) => sum + pool.messageCount,
          0,
        );
        if (remainingMessages > 0) {
          logger.warn(
            { remainingPools, remainingMessages, timeoutMs: SHUTDOWN_TIMEOUT_MS },
            'Shutdown flush timeout reached, some messages may be lost',
          );
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });

    await Promise.race([shutdownWork, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    void shutdownWork.catch((error: unknown) =>
      logger.error({ error }, 'Message pool shutdown settlement failed'),
    );
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

  @OnEvent(sessionHumanPromptStateChangedEvent.name, { suppressErrors: false })
  async handleHumanPromptStateChanged(
    event: SessionHumanPromptStateChangedEventPayload,
  ): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId || session.tmuxSessionId !== event.tmuxSessionName) return;
    const agentId = session.agentId;

    while (true) {
      const step: { done: true } | { detachment: DeferredLaneDetachment } =
        await this.coordinator.withAgentLock(agentId, async () => {
          const activeSession = this.sessions.getActiveSessionForAgent(agentId);
          const existingLane = this.deferredLanes.get(agentId);
          if (
            activeSession?.id === event.sessionId &&
            existingLane &&
            existingLane.sessionId !== event.sessionId
          ) {
            return {
              detachment: this.detachDeferredLaneUnderAgentLock(
                existingLane,
                'Target session was replaced before deferred delivery',
              ),
            };
          }
          await this.handleHumanPromptStateChangedUnderAgentLock(agentId, event);
          return { done: true };
        });
      if ('done' in step) return;
      await this.settleDeferredLaneDetachment(step.detachment);
    }
  }

  private async handleHumanPromptStateChangedUnderAgentLock(
    agentId: string,
    event: SessionHumanPromptStateChangedEventPayload,
  ): Promise<void> {
    if (event.phase === 'draft_active') {
      await this.promoteProtectedPoolMessagesUnderAgentLock(agentId, event);
    }

    const lane = this.deferredLanes.get(agentId);
    if (
      !lane ||
      lane.sessionId !== event.sessionId ||
      lane.tmuxSessionName !== event.tmuxSessionName
    ) {
      return;
    }

    this.rebindLaneGeneration(lane, event.generation);
    if (event.phase === 'draft_active') {
      this.clearDeferredLaneTimer(lane);
    } else {
      this.ensureHumanQuietTimerUnderAgentLock(lane);
    }
    this.broadcastPoolsUpdate();
  }

  private async promoteProtectedPoolMessagesUnderAgentLock(
    agentId: string,
    event: SessionHumanPromptStateChangedEventPayload,
  ): Promise<void> {
    const pool = this.pools.get(agentId);
    if (!pool) return;
    const protectedMessages = pool.messages.filter((message) => message.deferWhileHumanTyping);
    if (protectedMessages.length === 0) return;

    const session = this.sessions.getSession(event.sessionId);
    const activeSession = this.sessions.getActiveSessionForAgent(agentId);
    if (
      !session?.tmuxSessionId ||
      session.tmuxSessionId !== event.tmuxSessionName ||
      activeSession?.id !== event.sessionId
    ) {
      return;
    }

    pool.messages = pool.messages.filter((message) => !message.deferWhileHumanTyping);
    if (pool.messages.length === 0) {
      this.clearPoolTimers(pool);
      this.pools.delete(agentId);
    }

    await this.moveMessagesToDeferredLaneUnderAgentLock(
      agentId,
      pool.projectId,
      pool.config.separator,
      activeSession,
      protectedMessages,
      event.generation,
    );
  }

  @OnEvent('session.activity.changed', { async: true })
  async handleSessionActivityChanged(event: SessionActivityChangedEventPayload): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId || event.state !== 'idle') return;

    await this.flushDeferredLane(session.agentId, event.sessionId);
  }

  @OnEvent('session.stopped', { async: true })
  async handleSessionStopped(event: SessionStoppedEventPayload): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId) return;
    const agentId = session.agentId;

    await this.failMatchingDeferredLane(
      agentId,
      event.sessionId,
      'Target session stopped before deferred delivery',
    );
  }

  @OnEvent('session.crashed', { async: true })
  async handleSessionCrashed(event: SessionCrashedEventPayload): Promise<void> {
    const session = this.sessions.getSession(event.sessionId);
    if (!session?.agentId) return;
    const agentId = session.agentId;

    await this.failMatchingDeferredLane(
      agentId,
      event.sessionId,
      'Target session crashed before deferred delivery',
    );
  }

  // ─── Private delivery methods ──────────────────────────────────────────

  private async flushDeferredLane(
    agentId: string,
    expectedSessionId: string,
    quietGraceElapsed = false,
  ): Promise<FlushResult> {
    const claim = await this.coordinator.withAgentLock(agentId, async () =>
      this.claimDeferredLaneUnderAgentLock(agentId, expectedSessionId, quietGraceElapsed),
    );
    if (!claim) return { success: true, deliveredCount: 0 };

    return this.deliverDeferredClaim(claim);
  }

  private async deliverDeferredClaim(claim: DeferredLaneClaim): Promise<FlushResult> {
    const result = await this.deliverBatchToTarget(
      claim.agentId,
      claim.messages,
      claim.separator,
      { sessionId: claim.sessionId, tmuxSessionName: claim.tmuxSessionName },
      claim.quietSnapshot ?? undefined,
      claim,
    );

    await this.coordinator.withAgentLock(claim.agentId, async () =>
      this.completeDeferredClaimUnderAgentLock(claim, result),
    );
    return result;
  }

  private claimDeferredLaneUnderAgentLock(
    agentId: string,
    expectedSessionId: string,
    quietGraceElapsed: boolean,
  ): DeferredLaneClaim | null {
    const lane = this.deferredLanes.get(agentId);
    const expectedSession = this.sessions.getSession(expectedSessionId);
    const activeSession = this.sessions.getActiveSessionForAgent(agentId);
    if (
      !lane ||
      lane.activeClaim ||
      lane.sessionId !== expectedSessionId ||
      expectedSession?.status !== 'running' ||
      expectedSession.tmuxSessionId !== lane.tmuxSessionName ||
      activeSession?.id !== expectedSessionId
    ) {
      return null;
    }

    let quietSnapshot: HumanPromptQuietSnapshot | null = null;
    if (lane.requiredGeneration !== null) {
      quietSnapshot = this.humanPromptState.getQuietSnapshot(lane.tmuxSessionName);
      if (
        !quietGraceElapsed ||
        !quietSnapshot ||
        quietSnapshot.expectedGeneration !== lane.requiredGeneration ||
        !lane.quietBaseline ||
        !this.quietSnapshotsEqual(lane.quietBaseline, quietSnapshot)
      ) {
        const current = this.humanPromptState.getState(lane.tmuxSessionName);
        if (current.phase === 'inactive') {
          lane.requiredGeneration = null;
          lane.quietBaseline = null;
        } else {
          this.rebindLaneGeneration(lane, current.generation);
          if (current.phase === 'awaiting_stable_idle') {
            this.ensureHumanQuietTimerUnderAgentLock(lane, true);
          }
          return null;
        }
      }
    }

    if (
      lane.messages.some((message) => message.requiresProviderIdle) &&
      expectedSession.activityState !== 'idle'
    ) {
      if (lane.requiredGeneration !== null) {
        this.ensureHumanQuietTimerUnderAgentLock(lane, true);
      }
      return null;
    }

    return this.startDeferredClaimUnderAgentLock(agentId, lane, {
      quietSnapshot: lane.requiredGeneration !== null ? quietSnapshot : null,
      forceSnapshot: null,
    });
  }

  private startDeferredClaimUnderAgentLock(
    agentId: string,
    lane: AgentDeferredLane,
    snapshots: Pick<DeferredLaneClaim, 'quietSnapshot' | 'forceSnapshot'>,
  ): DeferredLaneClaim {
    this.clearDeferredLaneTimer(lane);
    let resolveCompletion!: (failureLane: AgentDeferredLane | null) => void;
    const completion = new Promise<AgentDeferredLane | null>((resolve) => {
      resolveCompletion = resolve;
    });
    const claim: DeferredLaneClaim = {
      agentId,
      sessionId: lane.sessionId,
      tmuxSessionName: lane.tmuxSessionName,
      projectId: lane.projectId,
      messages: [...lane.messages],
      separator: lane.separator,
      ...snapshots,
      state: { phase: 'preparing' },
      completion,
      resolveCompletion,
    };
    lane.activeClaim = claim;
    return claim;
  }

  private completeDeferredClaimUnderAgentLock(claim: DeferredLaneClaim, result: FlushResult): void {
    if (claim.state.phase === 'complete') return;
    const cancellationReason =
      claim.state.phase === 'preparing' ? claim.state.cancellationReason : undefined;
    const lane = this.deferredLanes.get(claim.agentId);
    const ownsLane =
      lane?.sessionId === claim.sessionId && lane.activeClaim === claim ? lane : null;
    if (ownsLane) ownsLane.activeClaim = null;

    if (cancellationReason) {
      claim.state = { phase: 'complete', outcome: 'failed' };
      claim.resolveCompletion(null);
      return;
    }

    if (ownsLane && result.outcome !== 'deferred') {
      const claimedIds = new Set(claim.messages.map((message) => message.logEntryId));
      ownsLane.messages.splice(
        0,
        ownsLane.messages.length,
        ...ownsLane.messages.filter((message) => !claimedIds.has(message.logEntryId)),
      );
    }

    const outcome: DeferredClaimOutcome = result.success
      ? (result.outcome ?? 'delivered')
      : 'failed';
    claim.state = { phase: 'complete', outcome };

    if (!ownsLane) {
      const failureLane =
        claim.detachReason && result.outcome === 'deferred'
          ? this.copyDeferredLaneWithMessages(claim, claim.messages)
          : null;
      claim.resolveCompletion(failureLane);
      return;
    }

    if (ownsLane.messages.length === 0) {
      this.clearDeferredLaneTimer(ownsLane);
      this.deferredLanes.delete(claim.agentId);
      this.broadcastPoolsUpdate();
      claim.resolveCompletion(null);
      return;
    }

    const state = this.humanPromptState.getState(ownsLane.tmuxSessionName);
    if (state.phase === 'inactive') {
      ownsLane.requiredGeneration = null;
      ownsLane.quietBaseline = null;
      setTimeout(() => {
        void this.flushDeferredLane(claim.agentId, ownsLane.sessionId).catch((error) =>
          logger.error({ agentId: claim.agentId, error }, 'Deferred follow-up delivery failed'),
        );
      }, 0);
    } else {
      this.rebindLaneGeneration(ownsLane, state.generation);
      if (state.phase === 'awaiting_stable_idle') {
        this.ensureHumanQuietTimerUnderAgentLock(ownsLane, true);
      }
    }
    this.broadcastPoolsUpdate();
    claim.resolveCompletion(null);
  }

  private async failMatchingDeferredLane(
    agentId: string,
    sessionId: string,
    reason: string,
    notifySenders = true,
  ): Promise<void> {
    const detachment = await this.coordinator.withAgentLock(agentId, async () => {
      const lane = this.deferredLanes.get(agentId);
      return !lane || lane.sessionId !== sessionId
        ? null
        : this.detachDeferredLaneUnderAgentLock(lane, reason);
    });
    if (detachment) {
      await this.settleDeferredLaneDetachment(detachment, notifySenders);
    }
  }

  private detachDeferredLaneUnderAgentLock(
    lane: AgentDeferredLane,
    reason: string,
  ): DeferredLaneDetachment {
    if (this.deferredLanes.get(lane.agentId) === lane) {
      this.deferredLanes.delete(lane.agentId);
    }
    this.clearDeferredLaneTimer(lane);

    const claim = lane.activeClaim;
    lane.activeClaim = null;
    if (!claim || claim.state.phase === 'complete') {
      return {
        reason,
        failureLane: this.copyDeferredLaneWithMessages(lane, lane.messages),
        claimCompletion: null,
      };
    }

    claim.detachReason = reason;
    if (claim.state.phase === 'preparing') {
      claim.state = { phase: 'preparing', cancellationReason: reason };
      return {
        reason,
        failureLane: this.copyDeferredLaneWithMessages(lane, lane.messages),
        claimCompletion: null,
      };
    }

    const claimedIds = new Set(claim.messages.map((message) => message.logEntryId));
    const unclaimedMessages = lane.messages.filter(
      (message) => !claimedIds.has(message.logEntryId),
    );
    return {
      reason,
      failureLane:
        unclaimedMessages.length > 0
          ? this.copyDeferredLaneWithMessages(lane, unclaimedMessages)
          : null,
      claimCompletion: claim.completion,
    };
  }

  private async settleDeferredLaneDetachment(
    detachment: DeferredLaneDetachment,
    notifySenders = true,
  ): Promise<void> {
    if (detachment.failureLane) {
      await this.failDeferredLane(detachment.failureLane, detachment.reason, notifySenders);
    }
    if (!detachment.claimCompletion) return;

    const lateFailureLane = await detachment.claimCompletion;
    if (lateFailureLane) {
      await this.failDeferredLane(lateFailureLane, detachment.reason, notifySenders);
    }
  }

  private copyDeferredLaneWithMessages(
    lane: Pick<
      AgentDeferredLane,
      'sessionId' | 'tmuxSessionName' | 'agentId' | 'projectId' | 'separator'
    >,
    messages: PooledMessage[],
  ): AgentDeferredLane {
    return {
      sessionId: lane.sessionId,
      tmuxSessionName: lane.tmuxSessionName,
      agentId: lane.agentId,
      projectId: lane.projectId,
      messages: [...messages],
      separator: lane.separator,
      requiredGeneration: null,
      quietTimer: null,
      quietBaseline: null,
      activeClaim: null,
    };
  }

  private async failDeferredLane(
    lane: AgentDeferredLane,
    reason: string,
    notifySenders = true,
  ): Promise<void> {
    this.clearDeferredLaneTimer(lane);
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
      'Deferred delivery lane discarded',
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

  private clearPoolTimers(pool: AgentPool): void {
    if (pool.timer) clearTimeout(pool.timer);
    if (pool.maxWaitTimer) clearTimeout(pool.maxWaitTimer);
    pool.timer = null;
    pool.maxWaitTimer = null;
  }

  private clearDeferredLaneTimer(lane: AgentDeferredLane): void {
    if (lane.quietTimer) clearTimeout(lane.quietTimer);
    lane.quietTimer = null;
    lane.quietBaseline = null;
  }

  private rebindLaneGeneration(lane: AgentDeferredLane, generation: number): void {
    if (lane.requiredGeneration !== generation) this.clearDeferredLaneTimer(lane);
    lane.requiredGeneration = generation;
    for (const message of lane.messages) message.heldGeneration = generation;
  }

  private ensureHumanQuietTimerUnderAgentLock(lane: AgentDeferredLane, restart = false): void {
    if (lane.activeClaim) return;
    if (restart) this.clearDeferredLaneTimer(lane);
    if (lane.quietTimer) return;

    const snapshot = this.humanPromptState.getQuietSnapshot(lane.tmuxSessionName);
    if (!snapshot || snapshot.expectedGeneration !== lane.requiredGeneration) return;
    lane.quietBaseline = snapshot;
    lane.quietTimer = setTimeout(() => {
      lane.quietTimer = null;
      void this.flushDeferredLane(lane.agentId, lane.sessionId, true).catch((error) =>
        logger.error({ agentId: lane.agentId, error }, 'Human-quiet delivery failed'),
      );
    }, HUMAN_DRAFT_IDLE_GRACE_MS);
  }

  private quietSnapshotsEqual(
    left: HumanPromptQuietSnapshot,
    right: HumanPromptQuietSnapshot,
  ): boolean {
    return (
      left.expectedGeneration === right.expectedGeneration &&
      left.executedInputEpoch === right.executedInputEpoch &&
      left.meaningfulOutputEpoch === right.meaningfulOutputEpoch
    );
  }

  private async moveMessagesToDeferredLaneUnderAgentLock(
    agentId: string,
    projectId: string,
    separator: string,
    activeSession: NonNullable<ReturnType<SessionsService['getActiveSessionForAgent']>>,
    messages: PooledMessage[],
    generation: number,
  ): Promise<void> {
    if (!activeSession.tmuxSessionId) return;

    let lane = this.deferredLanes.get(agentId);
    if (!lane) {
      lane = {
        sessionId: activeSession.id,
        tmuxSessionName: activeSession.tmuxSessionId,
        agentId,
        projectId,
        messages: [],
        separator,
        requiredGeneration: generation,
        quietTimer: null,
        quietBaseline: null,
        activeClaim: null,
      };
      this.deferredLanes.set(agentId, lane);
    }
    lane.separator = separator;
    lane.messages.push(...messages);
    this.rebindLaneGeneration(lane, generation);

    const state = this.humanPromptState.getState(lane.tmuxSessionName);
    if (state.phase === 'awaiting_stable_idle') this.ensureHumanQuietTimerUnderAgentLock(lane);
    this.broadcastPoolsUpdate();
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

    return this.deliverBatchToTarget(agentId, messages, separator, {
      sessionId: session.id,
      tmuxSessionName: session.tmuxSessionId,
    });
  }

  private async deliverBatchToTarget(
    agentId: string,
    messages: PooledMessage[],
    separator: string,
    target: { sessionId: string; tmuxSessionName: string },
    quietSnapshot?: HumanPromptQuietSnapshot,
    claim?: DeferredLaneClaim,
  ): Promise<FlushResult> {
    const batchId = randomUUID();
    const failureDisclosure = getStrictestFailureDisclosure(messages);
    const baseText = messages.map((message) => message.text).join(separator);
    const submitKeys = messages[messages.length - 1]?.submitKeys ?? ['Enter'];

    try {
      const postPasteDelayMs =
        await this.providerAdapterFactory.getPostPasteDelayMsForAgent(agentId);
      const result = claim
        ? await this.terminalIO.deliverGuarded(
            { name: target.tmuxSessionName },
            baseText,
            { agentId, submitKeys, postPasteDelayMs },
            claim.forceSnapshot ? undefined : quietSnapshot,
            {
              canStartMutation: () => {
                if (!canStartDeferredClaimMutation(claim)) return false;
                if (!claim.forceSnapshot) return true;
                return this.humanPromptState.applyForceDelivery(
                  target.tmuxSessionName,
                  claim.forceSnapshot,
                );
              },
              markMutationStarted: () => {
                if (canStartDeferredClaimMutation(claim)) {
                  claim.state = { phase: 'mutating' };
                }
              },
            },
          )
        : await this.terminalIO.deliver({ name: target.tmuxSessionName }, baseText, {
            agentId,
            submitKeys,
            postPasteDelayMs,
          });
      const cancellation = deferredClaimCancellationResult(claim, messages.length);
      if (cancellation) return cancellation;
      if ('deferred' in result) {
        return { success: true, deliveredCount: 0, outcome: 'deferred' };
      }

      const deliveredAt = Date.now();
      const status = result.confirmed ? 'delivered' : 'unconfirmed';
      const entries: MessageLogEntry[] = [];
      for (const message of messages) {
        this.messageLog.update(message.logEntryId, {
          status,
          batchId,
          deliveredAt,
          nonce: result.nonce,
          confirmedAt: result.confirmed ? deliveredAt : undefined,
          retryCount: result.retryCount,
          failureCode: result.confirmed ? undefined : 'paste_not_confirmed',
        });
        const entry = this.messageLog.getById(message.logEntryId);
        if (entry) entries.push(entry);
      }

      if (result.confirmed) {
        this.activityStream.broadcastDelivered(batchId, entries);
      } else {
        this.activityStream.broadcastUnconfirmed(batchId, entries);
      }
      this.broadcastPoolsUpdate();
      return {
        success: true,
        deliveredCount: messages.length,
        outcome: result.confirmed ? 'delivered' : 'unconfirmed',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const cancellation = deferredClaimCancellationResult(claim, messages.length);
      if (cancellation) return cancellation;
      const failureCode: DeliveryFailureCode = errorMsg.includes('send keys')
        ? 'send_keys_failed'
        : 'tmux_error';
      const batchFailure = classifyDeliveryFailure(failureDisclosure, errorMsg, failureCode);
      logger.error(
        { agentId, sessionId: target.sessionId, error: batchFailure.error },
        'Failed to deliver batch to exact agent session',
      );
      for (const message of messages) {
        const failure = classifyDeliveryFailure(message.failureDisclosure, errorMsg, failureCode);
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
      await this.failureNotifier
        .notifySendersOfFailure(messages, agentId, batchFailure.error)
        .catch((notifyError: unknown) =>
          logger.warn(
            {
              agentId,
              error:
                failureDisclosure === 'project-safe' ? PROJECT_SAFE_DELIVERY_ERROR : notifyError,
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
    return this.coordinator.withAgentLock(agentId, () =>
      this.deliverMessageUnderAgentLock(agentId, text, submitKeys, opts),
    );
  }

  private async deliverMessageUnderAgentLock(
    agentId: string,
    text: string,
    submitKeys: string[],
    opts?: { skipConfirmation?: boolean; preKeys?: string[]; preDelayMs?: number },
  ): Promise<{
    nonce: string;
    unconfirmed?: boolean;
    skipped?: boolean;
    retryCount: number;
    sessionId: string;
    tmuxSessionName: string;
  }> {
    const activeSessions = await this.sessions.listActiveSessions();
    const session = activeSessions.find((candidate) => candidate.agentId === agentId);
    if (!session?.tmuxSessionId) throw new Error(`No active session for agent ${agentId}`);

    const postPasteDelayMs = await this.providerAdapterFactory.getPostPasteDelayMsForAgent(agentId);
    if (opts?.skipConfirmation) {
      const delivery = await this.terminalIO.deliverImmediate(
        { name: session.tmuxSessionId },
        text,
        {
          submitKeys,
          postPasteDelayMs,
          confirm: false,
          preKeys: opts.preKeys,
          preDelayMs: opts.preDelayMs,
        },
      );
      return {
        nonce: delivery.nonce,
        skipped: true,
        retryCount: 0,
        sessionId: session.id,
        tmuxSessionName: session.tmuxSessionId,
      };
    }

    const delivery = await this.terminalIO.deliver({ name: session.tmuxSessionId }, text, {
      agentId,
      submitKeys,
      postPasteDelayMs,
      preKeys: opts?.preKeys,
      preDelayMs: opts?.preDelayMs,
    });
    return {
      nonce: delivery.nonce,
      unconfirmed: !delivery.confirmed,
      retryCount: delivery.retryCount,
      sessionId: session.id,
      tmuxSessionName: session.tmuxSessionId,
    };
  }

  private async deliverImmediateUnderAgentLock(
    input: ResolvedEnqueueInput,
    logEntry: MessageLogEntry,
  ): Promise<EnqueueResult> {
    try {
      const activeSession = this.sessions.getActiveSessionForAgent(input.agentId);
      const expectedSubmit =
        input.humanPromptSubmit && activeSession?.tmuxSessionId
          ? {
              sessionId: activeSession.id,
              tmuxSessionName: activeSession.tmuxSessionId,
              generation: this.humanPromptState.getState(activeSession.tmuxSessionId).generation,
            }
          : null;
      const delivery = await this.deliverMessageUnderAgentLock(
        input.agentId,
        input.text,
        input.submitKeys,
        {
          skipConfirmation: input.deliveryMode === 'immediate',
          preKeys: input.preKeys,
          preDelayMs: input.preDelayMs,
        },
      );
      const status = delivery.unconfirmed ? 'unconfirmed' : 'delivered';
      const deliveredAt = Date.now();
      this.messageLog.update(logEntry.id, {
        status,
        deliveredAt,
        nonce: delivery.skipped ? undefined : delivery.nonce,
        confirmedAt: delivery.skipped || delivery.unconfirmed ? undefined : deliveredAt,
        retryCount: delivery.retryCount,
        failureCode: delivery.unconfirmed ? 'paste_not_confirmed' : undefined,
      });
      const updated = this.messageLog.getById(logEntry.id);
      if (updated) {
        if (delivery.unconfirmed) this.activityStream.broadcastUnconfirmed(logEntry.id, [updated]);
        else this.activityStream.broadcastDelivered(logEntry.id, [updated]);
      }

      if (
        expectedSubmit &&
        expectedSubmit.sessionId === delivery.sessionId &&
        expectedSubmit.tmuxSessionName === delivery.tmuxSessionName
      ) {
        await this.completeHumanSubmitUnderAgentLock(
          input.agentId,
          delivery.sessionId,
          delivery.tmuxSessionName,
          expectedSubmit.generation,
        );
      }
      return { status, logEntryId: logEntry.id };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const failure = classifyDeliveryFailure(input.failureDisclosure, errorMsg, 'tmux_error');
      logger.error(
        { agentId: input.agentId, source: input.source, error: failure.error },
        'Immediate delivery failed',
      );
      this.messageLog.update(logEntry.id, {
        status: 'failed',
        error: failure.error,
        failureCode: failure.failureCode,
      });
      const failed = this.messageLog.getById(logEntry.id);
      if (failed) this.activityStream.broadcastFailed(failed);
      return { status: 'failed', error: failure.error, logEntryId: logEntry.id };
    }
  }

  private async completeHumanSubmitUnderAgentLock(
    agentId: string,
    sessionId: string,
    tmuxSessionName: string,
    expectedGeneration: number,
  ): Promise<void> {
    const transition = this.humanPromptState.transitionToAwaiting(
      tmuxSessionName,
      expectedGeneration,
    );
    if (!transition.accepted) return;
    await this.handleHumanPromptStateChangedUnderAgentLock(agentId, {
      sessionId,
      tmuxSessionName,
      generation: transition.state.generation,
      phase: 'awaiting_stable_idle',
    });
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
