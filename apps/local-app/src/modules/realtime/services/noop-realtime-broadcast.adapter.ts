import { Injectable } from '@nestjs/common';
import type { RealtimeBroadcaster } from '../ports/realtime-broadcaster.port';

/** Standalone-MCP adapter for REALTIME_BROADCASTER. Wired in full-app by RealtimeBroadcastModule. */
@Injectable()
export class NoopRealtimeBroadcastAdapter implements RealtimeBroadcaster {
  broadcastEvent(_topic: string, _type: string, _payload: unknown): void {
    // No-op: standalone-MCP mode has no WebSocket clients
  }
}
