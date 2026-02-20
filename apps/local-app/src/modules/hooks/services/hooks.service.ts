import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
import type { HookEventData, HookEventResponse } from '../dtos/hook-event.dto';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('HooksService');

/** Max length for string fields before truncation warning. */
const FIELD_WARN_LENGTH = 2000;

@Injectable()
export class HooksService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly events: EventsService,
  ) {}

  /**
   * Process an incoming hook event from the relay script.
   * Transforms the payload, resolves context, publishes an internal event,
   * and returns an extensible response.
   *
   * Errors during event publishing are logged but do NOT fail the response
   * — the relay script must always get a response to avoid blocking Claude.
   */
  async handleHookEvent(data: HookEventData): Promise<HookEventResponse> {
    const { hookEventName } = data;
    logger.info(
      { hookEventName, projectId: data.projectId, tmuxSessionName: data.tmuxSessionName },
      'Processing hook event',
    );

    this.warnOversizedFields(data);

    switch (hookEventName) {
      case 'SessionStart':
        return this.handleSessionStart(data);
      default:
        logger.info({ hookEventName }, 'Unhandled hook event type — returning ok');
        return { ok: true, handled: false, data: {} };
    }
  }

  private async handleSessionStart(data: HookEventData): Promise<HookEventResponse> {
    // Resolve agentName from agentId if available
    let agentName: string | null = null;
    if (data.agentId) {
      try {
        const agent = await this.storage.getAgent(data.agentId);
        agentName = agent.name;
      } catch (error) {
        logger.warn(
          { agentId: data.agentId, error },
          'Failed to resolve agent name — continuing without it',
        );
      }
    }

    // Publish the internal event — errors must not fail the response
    try {
      await this.events.publish('claude.hooks.session.started', {
        claudeSessionId: data.claudeSessionId,
        source: data.source,
        model: data.model,
        permissionMode: data.permissionMode,
        transcriptPath: data.transcriptPath,
        tmuxSessionName: data.tmuxSessionName,
        projectId: data.projectId,
        agentId: data.agentId,
        agentName,
        sessionId: data.sessionId,
      });
    } catch (error) {
      logger.error(
        { error, hookEventName: 'SessionStart' },
        'Failed to publish hook event — responding ok anyway',
      );
    }

    return { ok: true, handled: true, data: {} };
  }

  /**
   * Log warnings for unexpectedly large field values.
   * Does not truncate — just alerts for monitoring.
   */
  private warnOversizedFields(data: HookEventData): void {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.length > FIELD_WARN_LENGTH) {
        logger.warn(
          { field: key, length: value.length },
          'Hook event field exceeds size threshold',
        );
      }
    }
  }
}
