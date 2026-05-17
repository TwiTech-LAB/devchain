import { EventEmitter } from 'events';

export interface FrameEvent {
  readonly type:
    | 'data'
    | 'seed_ansi'
    | 'full_history'
    | 'subscribed'
    | 'focus_changed'
    | 'resize_jiggle';
  readonly sessionId: string;
  readonly payload: unknown;
}

export class TerminalFrameStream extends EventEmitter {
  emit(event: 'frame', frame: FrameEvent): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: 'frame', listener: (frame: FrameEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: 'frame', listener: (frame: FrameEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}
