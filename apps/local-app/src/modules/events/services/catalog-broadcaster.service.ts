import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import { broadcastRegistry } from '../catalog/broadcast-registry';

const logger = createLogger('CatalogBroadcaster');

@Injectable()
export class CatalogBroadcasterService implements OnModuleInit {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    @Inject(REALTIME_BROADCASTER) private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  onModuleInit(): void {
    for (const [eventName, entries] of Object.entries(broadcastRegistry)) {
      this.eventEmitter.on(eventName, (payload: Record<string, unknown>) => {
        for (const entry of entries) {
          try {
            const topic = typeof entry.topic === 'function' ? entry.topic(payload) : entry.topic;
            const type = typeof entry.type === 'function' ? entry.type(payload) : entry.type;
            const projected = entry.payloadProjection ? entry.payloadProjection(payload) : payload;
            this.broadcaster.broadcastEvent(topic, type, projected);
          } catch (error) {
            logger.error(
              {
                error,
                eventName,
                topic: typeof entry.topic === 'string' ? entry.topic : '(dynamic)',
              },
              'CatalogBroadcaster failed to broadcast',
            );
          }
        }
      });
    }

    logger.info(
      { eventCount: Object.keys(broadcastRegistry).length },
      'CatalogBroadcaster registered broadcast handlers',
    );
  }
}
