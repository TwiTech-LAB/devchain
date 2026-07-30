import { Injectable } from '@nestjs/common';
import { ProcessExecutor } from '../process-executor/process-executor.port';
import { TerminalSessionRegistry } from '../terminal-session/terminal-session-registry';
import type { FrameEvent } from '../terminal-session/terminal-frame-stream';
import { captureViewport, type ViewportCapture } from '../terminal-io/viewport-capture';

export type { ViewportCapture } from '../terminal-io/viewport-capture';

/**
 * NARROW read-only facade over the live terminal-session machinery, exposing ONLY what
 * the cloud-tunnel viewport streamer needs: tmux-session resolution, a colored visible
 * capture, and an output-gated "new bytes arrived" subscription.
 *
 * It is exported by {@link TerminalViewportModule} so `CloudTunnelModule` can consume the
 * viewport surface WITHOUT importing `TerminalModule` wholesale — keeping CloudTunnel a
 * leaf/transitive consumer of the Sessions↔Terminal SCC (see
 * apps/local-app/scripts/cycle-allowlist.json).
 *
 * Read-only by construction: it never creates/disposes a session and never tears down the
 * PTY — it only reads the registry and attaches/detaches a `data`-frame listener.
 */
@Injectable()
export class TerminalViewportFacade {
  constructor(
    private readonly registry: TerminalSessionRegistry,
    private readonly executor: ProcessExecutor,
  ) {}

  /** True when a live terminal session (and thus tmux pane) exists for this id. */
  hasSession(sessionId: string): boolean {
    return this.registry.get(sessionId) !== undefined;
  }

  /**
   * Capture the colored VISIBLE screen + cursor + pane dims for a session. Returns `null`
   * when no live session exists or the tmux capture fails — never throws.
   */
  async capture(sessionId: string): Promise<ViewportCapture | null> {
    const session = this.registry.get(sessionId);
    if (!session) return null;
    return captureViewport(this.executor, { name: session.tmuxSessionName });
  }

  /**
   * Subscribe to "new PTY bytes arrived" for a session — the output-gated trigger for a
   * re-capture. The listener fires on `data` frames only (the same frames `pushFrame`
   * emits at the PTY source; `wireFrameListener` deliberately omits these for socket.io).
   *
   * Returns an idempotent unsubscribe fn. Attaching/detaching the listener does NOT affect
   * the PTY lifecycle — this is a pure read-only consumer. No-op (returns a no-op
   * unsubscribe) when the session does not exist.
   */
  onData(sessionId: string, listener: () => void): () => void {
    const session = this.registry.get(sessionId);
    if (!session) return () => {};

    const handler = (frame: FrameEvent): void => {
      if (frame.type === 'data') listener();
    };
    session.stream.on('frame', handler);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      session.stream.off('frame', handler);
    };
  }
}
