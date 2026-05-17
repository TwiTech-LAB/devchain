import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { createLogger } from '../../../common/logging/logger';
import type { RealtimeBroadcaster } from '../ports/realtime-broadcaster.port';
import { createEnvelope } from '../dtos/ws-envelope.dto';

const logger = createLogger('RealtimeBroadcastService');

@Injectable()
export class RealtimeBroadcastService implements RealtimeBroadcaster {
  private server: Server | null = null;

  setServer(server: Server): void {
    this.server = server;
  }

  broadcastEvent(topic: string, type: string, payload: unknown): void {
    if (!this.server) {
      logger.warn({ topic, type }, 'broadcastEvent called before WebSocket server initialized');
      return;
    }
    this.server.emit('message', createEnvelope(topic, type, payload));
  }
}
