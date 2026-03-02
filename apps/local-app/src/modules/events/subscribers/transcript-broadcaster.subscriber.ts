import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { SessionTranscriptDiscoveredEventPayload } from '../catalog/session.transcript.discovered';
import type { SessionTranscriptUpdatedEventPayload } from '../catalog/session.transcript.updated';
import type { SessionTranscriptEndedEventPayload } from '../catalog/session.transcript.ended';

/**
 * Subscriber that broadcasts transcript events via WebSocket.
 *
 * Listens to internal `session.transcript.*` events and re-broadcasts them
 * as WebSocket envelopes using the existing `{topic, type, payload, ts}` format.
 *
 * Topic: `session/{sessionId}/transcript`
 * Types: `discovered`, `updated`, `ended`
 */
@Injectable()
export class TranscriptBroadcasterSubscriber {
  private readonly logger = new Logger(TranscriptBroadcasterSubscriber.name);

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
  ) {}

  @OnEvent('session.transcript.discovered', { async: true })
  async handleTranscriptDiscovered(
    payload: SessionTranscriptDiscoveredEventPayload,
  ): Promise<void> {
    try {
      this.terminalGateway.broadcastEvent(`session/${payload.sessionId}/transcript`, 'discovered', {
        sessionId: payload.sessionId,
        providerName: payload.providerName,
      });
      this.logger.debug(
        { sessionId: payload.sessionId },
        'Broadcasted transcript discovered via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, sessionId: payload.sessionId },
        'Failed to broadcast transcript discovered',
      );
    }
  }

  @OnEvent('session.transcript.updated', { async: true })
  async handleTranscriptUpdated(payload: SessionTranscriptUpdatedEventPayload): Promise<void> {
    try {
      this.terminalGateway.broadcastEvent(`session/${payload.sessionId}/transcript`, 'updated', {
        sessionId: payload.sessionId,
        newMessageCount: payload.newMessageCount,
        metrics: payload.metrics,
      });
      this.logger.debug(
        { sessionId: payload.sessionId, newMessageCount: payload.newMessageCount },
        'Broadcasted transcript updated via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, sessionId: payload.sessionId },
        'Failed to broadcast transcript updated',
      );
    }
  }

  @OnEvent('session.transcript.ended', { async: true })
  async handleTranscriptEnded(payload: SessionTranscriptEndedEventPayload): Promise<void> {
    try {
      this.terminalGateway.broadcastEvent(`session/${payload.sessionId}/transcript`, 'ended', {
        sessionId: payload.sessionId,
        finalMetrics: payload.finalMetrics,
        endReason: payload.endReason,
      });
      this.logger.debug(
        { sessionId: payload.sessionId, endReason: payload.endReason },
        'Broadcasted transcript ended via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, sessionId: payload.sessionId },
        'Failed to broadcast transcript ended',
      );
    }
  }
}
