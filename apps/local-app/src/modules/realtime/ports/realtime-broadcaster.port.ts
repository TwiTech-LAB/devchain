export const REALTIME_BROADCASTER = Symbol('RealtimeBroadcaster');

export interface RealtimeBroadcaster {
  broadcastEvent(topic: string, type: string, payload: unknown): void;
}
