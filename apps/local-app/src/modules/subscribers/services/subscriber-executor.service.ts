import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Subscriber, EventFilter, ActionInput } from '../../storage/models/domain.models';
import type { TerminalWatcherTriggeredEventPayload } from '../../events/catalog/terminal.watcher.triggered';
import { TmuxService } from '../../terminal/services/tmux.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { getAction } from '../actions/actions.registry';
import type { ActionContext, EventEnvelope } from '../actions/action.interface';
import { isSubscribableEvent, getSubscribableEvents } from '../events/event-fields-catalog';
import { EventLogService } from '../../events/services/event-log.service';
import { getEventMetadata } from '../../events/services/events.service';
import { AutomationSchedulerService, type ScheduledTask } from './automation-scheduler.service';

/**
 * Result of a single subscriber execution.
 */
export interface SubscriberExecutionResult {
  subscriberId: string;
  subscriberName: string;
  actionType: string;
  success: boolean;
  message?: string;
  error?: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?:
    | 'deleted'
    | 'disabled'
    | 'filter_not_matched'
    | 'cooldown'
    | 'action_not_found'
    | 'session_error';
}

/**
 * Summary result of scheduling subscribers for an event (not execution).
 */
export interface EventScheduleResult {
  eventName: string;
  subscribersMatched: number;
  subscribersScheduled: number;
  subscribersSkipped: number;
  scheduledTasks: Array<{
    subscriberId: string;
    subscriberName: string;
    runAtIso: string;
    delayMs: number;
    groupKey: string;
    priority: number;
    position: number;
  }>;
  skippedSubscribers: Array<{
    subscriberId: string;
    subscriberName: string;
    reason: string;
  }>;
}

/**
 * Generic event payload type for subscribable events.
 * Must have at least projectId for subscriber lookup.
 */
export interface SubscribableEventPayload {
  projectId: string;
  sessionId?: string;
  agentId?: string | null;
  [key: string]: unknown;
}

/**
 * SubscriberExecutorService
 * Handles event-driven execution of subscriber actions.
 *
 * Listens for all subscribable system events and:
 * 1. Finds subscribers matching the event name
 *    - For 'terminal.watcher.triggered': matches by customEventName (user-defined)
 *    - For other events: matches by actual event name
 * 2. Filters by event filter if present
 * 3. Checks cooldown (per subscriber + session or event)
 * 4. Executes subscriber actions with error isolation
 *
 * Supported events are defined in event-fields-catalog.ts
 */
@Injectable()
export class SubscriberExecutorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('SubscriberExecutorService');

  /** Cooldown tracking: key = `${subscriberId}:${sessionId}`, value = timestamp */
  private subscriberLastExec = new Map<string, number>();

  /** Event handler reference for cleanup */
  private eventHandler: ((eventName: string | string[], ...args: unknown[]) => void) | null = null;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly tmuxService: TmuxService,
    private readonly sessionsService: SessionsService,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly sendCoordinator: TerminalSendCoordinatorService,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService: SessionsMessagePoolService,
    private readonly eventLogService: EventLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly scheduler: AutomationSchedulerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Register onAny listener to capture all events with their names
    // This avoids the NestJS @OnEvent('**') wildcard issue where eventName is not passed
    this.eventHandler = (eventName: string | string[], ...args: unknown[]) => {
      // EventEmitter2 can pass string[] for wildcards, but we only care about single events
      const name = Array.isArray(eventName) ? eventName[0] : eventName;
      if (!name) {
        return;
      }

      // Only process subscribable events
      if (!isSubscribableEvent(name)) {
        return;
      }

      const payload = args[0] as SubscribableEventPayload | undefined;
      if (!payload || typeof payload !== 'object') {
        this.logger.warn({ eventName: name }, 'Event payload is not an object, skipping');
        return;
      }

      // Schedule event processing through the scheduler
      void this.scheduleEventProcessing(name, payload).catch((error) => {
        this.logger.error(
          { eventName: name, error: error instanceof Error ? error.message : String(error) },
          'Failed to schedule subscribers for event',
        );
      });
    };

    this.eventEmitter.onAny(this.eventHandler);
    this.logger.info('SubscriberExecutorService initialized with onAny listener');
  }

  onModuleDestroy(): void {
    // Clean up the onAny listener
    if (this.eventHandler) {
      this.eventEmitter.offAny(this.eventHandler);
      this.eventHandler = null;
    }
    this.logger.info('SubscriberExecutorService destroyed');
  }

  /**
   * Resolve projectId from payload or via session lookup.
   *
   * Resolution order:
   * 1. payload.projectId (direct from event)
   * 2. session lookup: sessionId -> session.agentId -> agent.projectId
   * 3. null if unresolved
   *
   * @param payload - The event payload
   * @returns The resolved projectId or null
   */
  private async resolveProjectId(payload: SubscribableEventPayload): Promise<string | null> {
    // 1. Direct from payload
    if (payload.projectId) {
      return payload.projectId;
    }

    // 2. Resolve via session -> agent -> project
    if (payload.sessionId) {
      try {
        const session = this.sessionsService.getSession(payload.sessionId);
        if (session?.agentId) {
          const agent = await this.storage.getAgent(session.agentId);
          if (agent?.projectId) {
            this.logger.debug(
              {
                sessionId: payload.sessionId,
                agentId: session.agentId,
                projectId: agent.projectId,
              },
              'Resolved projectId via session lookup',
            );
            return agent.projectId;
          }
        }
      } catch (error) {
        this.logger.warn(
          { sessionId: payload.sessionId, error: String(error) },
          'Failed to resolve projectId via session lookup',
        );
      }
    }

    // 3. Unresolved
    return null;
  }

  /**
   * Schedule event processing through the AutomationSchedulerService.
   * Creates scheduled tasks for each matching subscriber.
   * Records a 'schedule' handler entry for Events page visibility.
   */
  private async scheduleEventProcessing(
    eventName: string,
    payload: SubscribableEventPayload,
  ): Promise<EventScheduleResult | null> {
    const scheduleStartedAt = new Date().toISOString();
    const metadata = getEventMetadata(payload);

    // Only process subscribable events
    if (!isSubscribableEvent(eventName)) {
      return null;
    }

    // Resolve projectId (required for subscriber lookup)
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) {
      this.logger.warn({ eventName }, 'Could not resolve projectId for event, skipping');
      return null;
    }

    try {
      // Determine which event name to use for subscriber lookup
      const subscriberEventName =
        eventName === 'terminal.watcher.triggered' &&
        (payload as TerminalWatcherTriggeredEventPayload).customEventName
          ? (payload as TerminalWatcherTriggeredEventPayload).customEventName
          : eventName;

      // Find subscribers for this event (using resolved projectId)
      const subscribers = await this.storage.findSubscribersByEventName(
        projectId,
        subscriberEventName,
      );

      // Log deprecation warning for epic.assigned subscribers
      if (subscriberEventName === 'epic.assigned' && subscribers.length > 0) {
        this.logger.warn(
          {
            eventName: subscriberEventName,
            subscriberCount: subscribers.length,
            subscriberNames: subscribers.map((s) => s.name),
          },
          'DEPRECATED: Subscribers configured for epic.assigned. Migrate to epic.updated with changes.agentId. See docs/operations.md.',
        );
      }

      const eventId = metadata?.id ?? `evt-${Date.now()}`;
      const now = Date.now();
      const scheduledAt = new Date(now).toISOString();

      // Track scheduled tasks and skipped subscribers for visibility
      const scheduledTasks: EventScheduleResult['scheduledTasks'] = [];
      const skippedSubscribers: EventScheduleResult['skippedSubscribers'] = [];

      // Schedule each subscriber as a task
      for (const subscriber of subscribers) {
        // Skip disabled subscribers early
        if (!subscriber.enabled) {
          skippedSubscribers.push({
            subscriberId: subscriber.id,
            subscriberName: subscriber.name,
            reason: 'disabled',
          });
          continue;
        }

        // Check event filter if present
        if (subscriber.eventFilter && !this.matchesFilter(subscriber.eventFilter, payload)) {
          this.logger.debug(
            { subscriberId: subscriber.id, filter: subscriber.eventFilter },
            'Subscriber filtered out by event filter',
          );
          skippedSubscribers.push({
            subscriberId: subscriber.id,
            subscriberName: subscriber.name,
            reason: 'filter_not_matched',
          });
          continue;
        }

        const groupKey = subscriber.groupName ?? `event:${subscriberEventName}`;
        const delayMs = subscriber.delayMs ?? 0;
        const runAt = now + delayMs;
        const runAtIso = new Date(runAt).toISOString();
        const priority = subscriber.priority ?? 0;
        const position = subscriber.position ?? 0;

        // Store minimal info needed for result construction (in case subscriber is deleted)
        const subscriberId = subscriber.id;
        const subscriberName = subscriber.name;
        const actionType = subscriber.actionType;

        const task: ScheduledTask = {
          taskId: `${subscriberId}-${eventId}`,
          subscriberId,
          eventId,
          runAt,
          priority,
          position,
          createdAt: scheduledAt,
          agentId: payload.agentId ?? undefined,
          groupKey,
          execute: async () =>
            this.executeSubscriberForTask(
              subscriberId,
              subscriberName,
              actionType,
              eventName,
              payload,
              scheduledAt,
            ),
        };

        this.scheduler.schedule(task);

        // Track for visibility
        scheduledTasks.push({
          subscriberId,
          subscriberName,
          runAtIso,
          delayMs,
          groupKey,
          priority,
          position,
        });
      }

      // Record schedule handler entry for Events page visibility
      if (metadata?.id && (scheduledTasks.length > 0 || skippedSubscribers.length > 0)) {
        await this.eventLogService.recordHandledOk({
          eventId: metadata.id,
          handler: 'SubscriberExecutorService:schedule',
          detail: {
            matched: subscribers.length,
            scheduled: scheduledTasks.length,
            skipped: skippedSubscribers.length,
            tasks: scheduledTasks,
            skips: skippedSubscribers,
          },
          startedAt: scheduleStartedAt,
          endedAt: new Date().toISOString(),
        });
      }

      return {
        eventName,
        subscribersMatched: subscribers.length,
        subscribersScheduled: scheduledTasks.length,
        subscribersSkipped: skippedSubscribers.length,
        scheduledTasks,
        skippedSubscribers,
      };
    } catch (error) {
      if (metadata?.id) {
        await this.eventLogService.recordHandledFail({
          eventId: metadata.id,
          handler: 'SubscriberExecutorService:schedule',
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
          startedAt: scheduleStartedAt,
          endedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
  }

  /**
   * Execute a subscriber for a scheduled task.
   * This is the execute function passed to the scheduler.
   *
   * Implements freshness rules:
   * - Re-loads subscriber by ID at execution time
   * - Handles deleted subscribers (skipReason='deleted')
   * - Handles disabled subscribers (skipReason='disabled')
   * - Re-checks event filter at execution time
   * - Uses latest subscriber config for inputs, cooldown, retry
   *
   * Records an 'execute' handler entry for Events page visibility.
   */
  private async executeSubscriberForTask(
    subscriberId: string,
    subscriberNameAtSchedule: string,
    actionTypeAtSchedule: string,
    eventName: string,
    payload: SubscribableEventPayload,
    scheduledAt: string,
  ): Promise<SubscriberExecutionResult> {
    const startTime = Date.now();
    const executedAt = new Date(startTime).toISOString();
    const metadata = getEventMetadata(payload);

    // Helper to record execute handler entry
    const recordExecuteEntry = async (
      result: SubscriberExecutionResult,
      subscriberName: string,
      actionType: string,
    ) => {
      if (!metadata?.id) return;

      const detail = {
        subscriberId,
        subscriberName,
        actionType,
        success: result.success,
        message: result.message,
        error: result.error,
        skipped: result.skipped,
        skipReason: result.skipReason,
        scheduledAt,
        executedAt,
        durationMs: result.durationMs,
      };

      if (result.success) {
        await this.eventLogService.recordHandledOk({
          eventId: metadata.id,
          handler: 'SubscriberExecutorService:execute',
          detail,
          startedAt: executedAt,
          endedAt: new Date().toISOString(),
        });
      } else {
        await this.eventLogService.recordHandledFail({
          eventId: metadata.id,
          handler: 'SubscriberExecutorService:execute',
          detail,
          startedAt: executedAt,
          endedAt: new Date().toISOString(),
        });
      }
    };

    // 1. Re-load subscriber by ID at execution time (freshness rule)
    const subscriber = await this.storage.getSubscriber(subscriberId);

    // 2. Handle deleted subscriber
    if (!subscriber) {
      this.logger.debug({ subscriberId }, 'Subscriber was deleted, skipping execution');
      const result: SubscriberExecutionResult = {
        subscriberId,
        subscriberName: subscriberNameAtSchedule,
        actionType: actionTypeAtSchedule,
        success: false,
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'deleted',
      };
      await recordExecuteEntry(result, subscriberNameAtSchedule, actionTypeAtSchedule);
      return result;
    }

    // 3. Handle disabled subscriber
    if (!subscriber.enabled) {
      this.logger.debug({ subscriberId }, 'Subscriber is now disabled, skipping execution');
      const result: SubscriberExecutionResult = {
        subscriberId,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        success: false,
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'disabled',
      };
      await recordExecuteEntry(result, subscriber.name, subscriber.actionType);
      return result;
    }

    // 4. Re-check event filter at execution time (subscriber config may have changed)
    if (subscriber.eventFilter && !this.matchesFilter(subscriber.eventFilter, payload)) {
      this.logger.debug(
        { subscriberId, filter: subscriber.eventFilter },
        'Subscriber no longer matches event filter, skipping execution',
      );
      const result: SubscriberExecutionResult = {
        subscriberId,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        success: false,
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'filter_not_matched',
      };
      await recordExecuteEntry(result, subscriber.name, subscriber.actionType);
      return result;
    }

    // 5. Execute with latest subscriber config (cooldown, inputs, retry handled inside)
    const result = await this.executeSubscriber(subscriber, eventName, payload);

    // 6. Log to EventLogService with execute handler
    await recordExecuteEntry(result, subscriber.name, subscriber.actionType);

    return result;
  }

  /**
   * Public entry point for handling events that matches production semantics:
   * schedule subscriber tasks via the scheduler (no immediate execution).
   *
   * In production runtime, events are handled by the onAny listener registered in onModuleInit.
   *
   * @param eventName - The name of the event that was emitted
   * @param payload - The event payload
   * @returns Structured scheduling summary for matched subscribers
   */
  async handleEvent(
    eventName: string,
    payload: SubscribableEventPayload,
  ): Promise<EventScheduleResult | null> {
    return this.scheduleEventProcessing(eventName, payload);
  }

  /**
   * Get list of subscribable event names.
   * Useful for API endpoints and UI.
   */
  getSubscribableEventNames(): string[] {
    return getSubscribableEvents();
  }

  /**
   * Check if the event payload matches the subscriber's event filter.
   *
   * @param filter - The event filter to check
   * @param payload - The event payload to match against
   * @returns true if the payload matches the filter
   */
  matchesFilter(filter: EventFilter, payload: SubscribableEventPayload): boolean {
    // Get the field value from the payload
    const fieldValue = this.getPayloadField(payload, filter.field);

    if (fieldValue === undefined || fieldValue === null) {
      return false;
    }

    const stringValue = String(fieldValue);

    switch (filter.operator) {
      case 'equals':
        return stringValue === filter.value;

      case 'contains':
        return stringValue.includes(filter.value);

      case 'regex':
        try {
          const regex = new RegExp(filter.value);
          return regex.test(stringValue);
        } catch {
          this.logger.warn({ pattern: filter.value }, 'Invalid regex pattern in event filter');
          return false;
        }

      default:
        return false;
    }
  }

  /**
   * Get a field value from the event payload by field path.
   * Supports dot notation for nested field access (e.g., 'nested.field').
   *
   * @param payload - The event payload
   * @param field - The field path (supports dot notation)
   * @returns The field value or undefined
   */
  getPayloadField(payload: SubscribableEventPayload, field: string): unknown {
    return this.getNestedValue(payload, field);
  }

  /**
   * Get a nested value from an object using dot notation path.
   *
   * @param obj - The object to traverse
   * @param path - The dot-separated path (e.g., 'nested.field')
   * @returns The value at the path or undefined if not found
   */
  private getNestedValue(obj: unknown, path: string): unknown {
    if (obj === null || obj === undefined) {
      return undefined;
    }

    return path.split('.').reduce((current: unknown, key: string) => {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current !== 'object') {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, obj);
  }

  /**
   * Interpolate template variables in a string.
   * Replaces `{{field}}` patterns with values from the provided template context.
   *
   * Behavior:
   * - `{{field}}` is replaced with the string value of templateContext[field]
   * - Unknown fields (not in templateContext) are kept as-is: `{{unknownField}}` remains unchanged
   * - Non-string values are stringified (numbers, booleans, etc.)
   * - Null/undefined values are converted to empty string
   *
   * @param template - The template string containing `{{field}}` variables
   * @param templateContext - The context object to extract values from
   * @returns The interpolated string
   */
  interpolateTemplate(template: string, templateContext: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, field) => {
      const value = this.getNestedValue(templateContext, field);
      if (value === undefined) {
        // Keep unknown variables as-is
        return match;
      }
      if (value === null) {
        return '';
      }
      return String(value);
    });
  }

  /**
   * Resolve action inputs from subscriber input mappings.
   * Maps subscriber input configurations to actual values from the event payload.
   *
   * For `source='custom'` string values, template variables like `{{field}}`
   * are interpolated using values from the payload.
   *
   * @param inputMappings - The subscriber's action input mappings
   * @param payload - The event payload to extract values from
   * @param templateVars - Optional merged view for event_field + template interpolation
   * @returns Resolved input values ready for action execution
   */
  resolveInputs(
    inputMappings: Record<string, ActionInput>,
    payload: SubscribableEventPayload,
    templateVars?: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    const context = templateVars ?? (payload as Record<string, unknown>);

    for (const [inputName, mapping] of Object.entries(inputMappings)) {
      if (mapping.source === 'event_field') {
        // Get value from event payload using the eventField path
        resolved[inputName] = mapping.eventField
          ? this.getNestedValue(context, mapping.eventField)
          : undefined;
      } else {
        // Use custom value - interpolate template variables for strings
        const customValue = mapping.customValue;
        if (typeof customValue === 'string') {
          resolved[inputName] = this.interpolateTemplate(customValue, context);
        } else {
          resolved[inputName] = customValue;
        }
      }
    }

    return resolved;
  }

  /**
   * Execute a subscriber's action.
   * Handles the full execution lifecycle: cooldown, input resolution,
   * context building, action execution, and retry logic.
   *
   * @param subscriber - The subscriber to execute
   * @param eventName - The name of the event that triggered this execution
   * @param payload - The event payload
   * @returns Execution result with timing and status details
   */
  async executeSubscriber(
    subscriber: Subscriber,
    eventName: string,
    payload: SubscribableEventPayload,
  ): Promise<SubscriberExecutionResult> {
    const startTime = Date.now();
    const sessionId = payload.sessionId || '';

    // Resolve projectId for envelope and context
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) {
      this.logger.error(
        { subscriberId: subscriber.id, sessionId: sessionId || '(no session)' },
        'Could not resolve projectId for subscriber execution',
      );
      return {
        subscriberId: subscriber.id,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        success: false,
        error: 'Could not resolve projectId',
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'session_error',
      };
    }

    this.logger.debug(
      {
        subscriberId: subscriber.id,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        sessionId: sessionId || '(no session)',
      },
      'Executing subscriber',
    );

    // 1. Check cooldown per subscriber+session (or subscriber-only if no session)
    const cooldownKey = sessionId || 'no-session';
    if (this.isOnCooldown(subscriber.id, cooldownKey, subscriber.cooldownMs)) {
      this.logger.debug(
        {
          subscriberId: subscriber.id,
          sessionId: sessionId || '(no session)',
          cooldownMs: subscriber.cooldownMs,
        },
        'Subscriber is on cooldown, skipping execution',
      );
      return {
        subscriberId: subscriber.id,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        success: false,
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'cooldown',
      };
    }

    // 2. Get action definition from registry
    const action = getAction(subscriber.actionType);
    if (!action) {
      this.logger.error({ actionType: subscriber.actionType }, 'Unknown action type');
      return {
        subscriberId: subscriber.id,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        success: false,
        error: `Unknown action type: ${subscriber.actionType}`,
        durationMs: Date.now() - startTime,
        skipped: true,
        skipReason: 'action_not_found',
      };
    }

    // 3. Build event envelope + template variables (merged view: payload + common envelope fields)
    const metadata = getEventMetadata(payload);
    const occurredAt = new Date().toISOString();
    const event: EventEnvelope = {
      eventName,
      projectId,
      agentId: payload.agentId ?? null,
      sessionId: payload.sessionId,
      occurredAt,
      eventId: metadata?.id,
      payload: payload as Record<string, unknown>,
    };

    const templateVars: Record<string, unknown> = {
      ...(payload as Record<string, unknown>),
      eventName,
      projectId,
      agentId: payload.agentId ?? null,
      sessionId: payload.sessionId,
      sessionIdShort: payload.sessionId?.slice(0, 8) ?? '',
      occurredAt,
      eventId: metadata?.id,
    };

    // 4. Resolve action inputs from subscriber mappings (use merged templateVars)
    const resolvedInputs = this.resolveInputs(subscriber.actionInputs, payload, templateVars);
    if (subscriber.actionType === 'restart_agent' && 'agentId' in resolvedInputs) {
      delete resolvedInputs.agentId;
      this.logger.debug(
        { subscriberId: subscriber.id },
        'Ignoring legacy restart_agent input mapping: agentId',
      );
    }

    // 5. Get session for context if sessionId is present
    // Some events may not have session context (e.g., epic.assigned)
    let tmuxSessionName = '';
    if (sessionId) {
      const session = this.sessionsService.getSession(sessionId);
      if (!session) {
        this.logger.error({ sessionId }, 'Session not found');
        return {
          subscriberId: subscriber.id,
          subscriberName: subscriber.name,
          actionType: subscriber.actionType,
          success: false,
          error: `Session ${sessionId} not found`,
          durationMs: Date.now() - startTime,
          skipped: true,
          skipReason: 'session_error',
        };
      }
      if (!session.tmuxSessionId) {
        this.logger.error({ sessionId }, 'Session has no tmux session');
        return {
          subscriberId: subscriber.id,
          subscriberName: subscriber.name,
          actionType: subscriber.actionType,
          success: false,
          error: `Session ${sessionId} has no tmux session`,
          durationMs: Date.now() - startTime,
          skipped: true,
          skipReason: 'session_error',
        };
      }
      tmuxSessionName = session.tmuxSessionId;
    }

    // 6. Build action context with standardized event envelope
    // Note: For events without session context, tmuxSessionName will be empty
    // and actions requiring terminal access will fail gracefully
    // projectId is resolved earlier (may come from payload or via session lookup)
    const context: ActionContext = {
      tmuxService: this.tmuxService,
      sessionsService: this.sessionsService,
      sessionCoordinator: this.sessionCoordinator,
      sendCoordinator: this.sendCoordinator,
      messagePoolService: this.messagePoolService,
      storage: this.storage,
      sessionId,
      agentId: payload.agentId ?? null,
      projectId,
      tmuxSessionName,
      event,
      logger: this.logger,
    };

    // 7. Execute the action
    let actionResult;
    try {
      actionResult = await action.execute(context, resolvedInputs);
    } catch (error) {
      this.logger.error(
        { subscriberId: subscriber.id, error: String(error) },
        'Action execution threw an error',
      );
      // Update cooldown even on error to prevent spam
      this.setCooldown(subscriber.id, cooldownKey);
      return {
        subscriberId: subscriber.id,
        subscriberName: subscriber.name,
        actionType: subscriber.actionType,
        success: false,
        error: String(error),
        durationMs: Date.now() - startTime,
      };
    }

    // 8. Update cooldown AFTER execution (even on failure to prevent spam)
    this.setCooldown(subscriber.id, cooldownKey);

    // 9. Handle retry on failure if configured
    if (!actionResult.success && subscriber.retryOnError) {
      this.logger.debug(
        { subscriberId: subscriber.id, error: actionResult.error },
        'Action failed, retrying after 1s delay',
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const retryResult = await action.execute(context, resolvedInputs);

        if (!retryResult.success) {
          this.logger.warn(
            { subscriberId: subscriber.id, error: retryResult.error },
            'Retry also failed',
          );
        } else {
          this.logger.debug({ subscriberId: subscriber.id }, 'Retry succeeded');
          actionResult = retryResult; // Use retry result if successful
        }
      } catch (retryError) {
        this.logger.error(
          { subscriberId: subscriber.id, error: String(retryError) },
          'Retry threw an error',
        );
      }
    }

    this.logger.info(
      {
        subscriberId: subscriber.id,
        subscriberName: subscriber.name,
        success: actionResult.success,
      },
      'Subscriber execution completed',
    );

    return {
      subscriberId: subscriber.id,
      subscriberName: subscriber.name,
      actionType: subscriber.actionType,
      success: actionResult.success,
      message: actionResult.message,
      error: actionResult.error,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Check if a subscriber is on cooldown for a specific session.
   *
   * @param subscriberId - The subscriber ID
   * @param sessionId - The session ID
   * @param cooldownMs - The cooldown duration in ms
   * @returns true if the subscriber is on cooldown
   */
  isOnCooldown(subscriberId: string, sessionId: string, cooldownMs: number): boolean {
    if (cooldownMs <= 0) return false;

    const key = `${subscriberId}:${sessionId}`;
    const lastExec = this.subscriberLastExec.get(key);

    if (!lastExec) return false;

    return Date.now() - lastExec < cooldownMs;
  }

  /**
   * Set the cooldown timestamp for a subscriber + session.
   *
   * @param subscriberId - The subscriber ID
   * @param sessionId - The session ID
   */
  setCooldown(subscriberId: string, sessionId: string): void {
    const key = `${subscriberId}:${sessionId}`;
    this.subscriberLastExec.set(key, Date.now());
  }

  /**
   * Clear cooldown for a subscriber + session.
   *
   * @param subscriberId - The subscriber ID
   * @param sessionId - The session ID
   */
  clearCooldown(subscriberId: string, sessionId: string): void {
    const key = `${subscriberId}:${sessionId}`;
    this.subscriberLastExec.delete(key);
  }
}
