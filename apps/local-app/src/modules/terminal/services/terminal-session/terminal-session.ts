import { TerminalFrameStream, type FrameEvent } from './terminal-frame-stream';
import { normalizeLineEndings, stripFinalLineEnding } from '../../utils/normalize-line-endings';

export interface AuthorityResult {
  readonly granted: boolean;
  readonly previousHolder?: string;
}

export interface ResizeResult {
  readonly applied: boolean;
  readonly reason?: 'not_authority' | 'unchanged' | 'debounced';
  readonly ptyDimensions?: Dimensions;
}

export interface Dimensions {
  readonly cols: number;
  readonly rows: number;
}

export interface ActivityState {
  readonly lastDataAt: number | null;
  readonly lastInputAt: number | null;
  readonly busySince: number | null;
  readonly idleSince: number | null;
  readonly subscriberCount: number;
  readonly hasAuthority: boolean;
}

export interface TerminalIORef {
  captureHistory(
    target: { name: string },
    lines?: number,
    includeEscapes?: boolean,
  ): Promise<{ ok: boolean; output: string }>;
  getCursorPosition?(target: { name: string }): Promise<{ x: number; y: number } | null>;
}

export interface TerminalSessionOptions {
  readonly sessionId: string;
  readonly tmuxSessionName: string;
  readonly idleAfterMs?: number;
  readonly normalizeCapturedLineEndings?: boolean;
}

const ACTIVITY_SUPPRESSION_MS = 750;
const RESIZE_DEBOUNCE_MS = 100;
const DEFAULT_IDLE_AFTER_MS = 30_000;

export class TerminalSession {
  readonly sessionId: string;
  readonly tmuxSessionName: string;
  readonly stream: TerminalFrameStream;

  private readonly subscribers = new Set<string>();
  private authority: string | null = null;
  private dimensions: Dimensions = { cols: 80, rows: 24 };
  private lastDataAt: number | null = null;
  private lastInputAt: number | null = null;
  private busySince: number | null = null;
  private idleSince: number | null = null;
  private suppressActivityUntil = 0;
  private historyInFlight = false;
  private bufferedFrames: string[] = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResize: { clientId: string; dims: Dimensions } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly idleAfterMs: number;
  private readonly normalizeCapturedLineEndings: boolean;
  private io?: TerminalIORef;
  /**
   * Whether this session's provider runs as a full-screen TUI on the alternate
   * screen. Set by the gateway (which can resolve it) before each subscribe.
   * Alt-screen seeds advertise NO history affordance — `capture-pane` only holds
   * the single visible screen, so there is no primary-buffer scrollback to load.
   */
  private usesAlternateScreen = false;

  constructor(options: TerminalSessionOptions) {
    this.sessionId = options.sessionId;
    this.tmuxSessionName = options.tmuxSessionName;
    this.idleAfterMs =
      options.idleAfterMs && options.idleAfterMs > 0 ? options.idleAfterMs : DEFAULT_IDLE_AFTER_MS;
    this.normalizeCapturedLineEndings = options.normalizeCapturedLineEndings === true;
    this.stream = new TerminalFrameStream();
  }

  subscribe(clientId: string): void {
    if (this.disposed) return;

    this.subscribers.add(clientId);

    if (this.subscribers.size === 1 && !this.authority) {
      this.authority = clientId;
      this.stream.emit('frame', {
        type: 'focus_changed',
        sessionId: this.sessionId,
        payload: { clientId, granted: true },
      });
    }

    this.stream.emit('frame', {
      type: 'subscribed',
      sessionId: this.sessionId,
      payload: { clientId },
    });

    this.initiateSeedAsync();
  }

  private static readonly SEED_CHUNK_SIZE = 64 * 1024;

  private initiateSeedAsync(): void {
    if (!this.io) return;

    const io = this.io;
    const sessionId = this.sessionId;
    const tmuxSessionName = this.tmuxSessionName;

    io.captureHistory({ name: tmuxSessionName }).then(async (result) => {
      if (!result.ok || this.disposed) return;

      const ansi = this.normalizeCapturedOutput(result.output);
      const cursorPos = await io.getCursorPosition?.({ name: tmuxSessionName }).catch(() => null);
      if (this.disposed) return;

      const chunkSize = TerminalSession.SEED_CHUNK_SIZE;
      const chunks: string[] = [];
      for (let i = 0; i < ansi.length; i += chunkSize) {
        chunks.push(ansi.slice(i, i + chunkSize));
      }
      if (chunks.length === 0) chunks.push('');

      const totalChunks = chunks.length;
      for (let i = 0; i < totalChunks; i++) {
        this.stream.emit('frame', {
          type: 'seed_ansi' as FrameEvent['type'],
          sessionId,
          payload: {
            data: chunks[i],
            chunk: i,
            totalChunks,
            ...(i === totalChunks - 1
              ? {
                  // Alt-screen TUIs have no loadable primary-buffer scrollback, so
                  // advertise no-history; line-streaming providers keep the affordance.
                  hasHistory: !this.usesAlternateScreen,
                  cursorX: cursorPos?.x,
                  cursorY: cursorPos?.y,
                }
              : {}),
          },
        });
      }
    });
  }

  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId);

    if (this.authority === clientId) {
      this.authority = null;
      const next = this.subscribers.values().next().value;
      if (next) {
        this.authority = next;
        this.stream.emit('frame', {
          type: 'focus_changed',
          sessionId: this.sessionId,
          payload: { clientId: next, granted: true },
        });
      }
    }
  }

  /**
   * Latch initial geometry authority to the imminent subscriber. Grants iff authority is
   * currently unheld; there is deliberately NO await between the check and the write, so
   * concurrent handleSubscribe invocations resolve to exactly one winner (single-threaded
   * atomicity is the whole point — it collapses reconnect/mount bursts to one geometry apply).
   *
   * Unlike {@link claimAuthority} this does NOT require subscriber membership — it grants to a
   * client that is about to subscribe. Safe because {@link unsubscribe} releases authority keyed
   * on `authority === clientId` with no membership requirement, so a client that latches then
   * dies before subscribing still has its authority swept on disconnect.
   *
   * Emits NO focus_changed: at the gateway call site the frame listener isn't wired and the
   * socket hasn't joined the room, so the frame would be lost. The gateway forwards the grant
   * via {@link notifyInitialAuthority} after wiring + room join.
   */
  claimInitialAuthority(clientId: string): boolean {
    if (this.authority !== null) return false;
    this.authority = clientId;
    return true;
  }

  /**
   * Forward a previously-latched initial-authority grant as a focus_changed frame. The gateway
   * calls this AFTER wiring the frame listener and joining the room ({@link claimInitialAuthority}
   * granted silently because the frame would otherwise be lost pre-wiring). No-ops unless
   * `clientId` still holds authority — a mid-subscribe steal or disconnect voids the grant.
   */
  notifyInitialAuthority(clientId: string): void {
    if (this.authority !== clientId) return;
    this.stream.emit('frame', {
      type: 'focus_changed',
      sessionId: this.sessionId,
      payload: { clientId, granted: true },
    });
  }

  claimAuthority(clientId: string): AuthorityResult {
    if (!this.subscribers.has(clientId)) {
      return { granted: false };
    }

    const previous = this.authority;
    this.authority = clientId;

    if (previous !== clientId) {
      this.stream.emit('frame', {
        type: 'focus_changed',
        sessionId: this.sessionId,
        payload: { clientId, granted: true, previousHolder: previous },
      });
    }

    return { granted: true, previousHolder: previous ?? undefined };
  }

  resize(clientId: string, dims: Dimensions): ResizeResult {
    if (this.authority !== clientId) {
      return { applied: false, reason: 'not_authority' };
    }

    if (this.resizeTimer) {
      this.pendingResize = { clientId, dims };
      return { applied: false, reason: 'debounced', ptyDimensions: dims };
    }

    if (this.dimensions.cols === dims.cols && this.dimensions.rows === dims.rows) {
      return { applied: false, reason: 'unchanged' };
    }

    this.pendingResize = { clientId, dims };

    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.pendingResize) {
        this.dimensions = this.pendingResize.dims;
        this.suppressActivityUntil = Date.now() + ACTIVITY_SUPPRESSION_MS;
        this.pendingResize = null;
      }
    }, RESIZE_DEBOUNCE_MS);

    return { applied: true, ptyDimensions: dims };
  }

  bindIO(io: TerminalIORef): void {
    this.io = io;
  }

  /** Set whether this session's provider uses the alternate screen (drives seed hasHistory). */
  setUsesAlternateScreen(value: boolean): void {
    this.usesAlternateScreen = value;
  }

  async requestFullHistory(): Promise<void> {
    this.historyInFlight = true;

    if (this.io) {
      const result = await this.io.captureHistory({ name: this.tmuxSessionName });
      if (result.ok) {
        this.deliverFullHistory(this.normalizeCapturedOutput(result.output));
      } else {
        this.historyInFlight = false;
      }
    }
  }

  private normalizeCapturedOutput(output: string): string {
    const withoutTrailingLineEnding = stripFinalLineEnding(output);
    return this.normalizeCapturedLineEndings
      ? normalizeLineEndings(withoutTrailingLineEnding)
      : withoutTrailingLineEnding;
  }

  deliverFullHistory(ansi: string): void {
    this.stream.emit('frame', {
      type: 'full_history',
      sessionId: this.sessionId,
      payload: { ansi },
    });

    for (const frame of this.bufferedFrames) {
      this.stream.emit('frame', {
        type: 'data',
        sessionId: this.sessionId,
        payload: { data: frame },
      });
    }
    this.bufferedFrames = [];
    this.historyInFlight = false;
  }

  signalInput(): void {
    if (this.disposed) return;
    this.lastInputAt = Date.now();
    this.markBusy();
  }

  pushFrame(data: string): void {
    if (this.disposed) return;

    if (Date.now() >= this.suppressActivityUntil) {
      this.lastDataAt = Date.now();
      this.markBusy();
    }

    if (this.historyInFlight) {
      this.bufferedFrames.push(data);
      return;
    }

    this.stream.emit('frame', {
      type: 'data',
      sessionId: this.sessionId,
      payload: { data },
    });
  }

  markIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.busySince !== null) {
      this.busySince = null;
      this.idleSince = Date.now();
    }
  }

  private markBusy(): void {
    if (this.busySince === null) {
      this.busySince = Date.now();
      this.idleSince = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.disposed) this.markIdle();
    }, this.idleAfterMs);
  }

  getActivityState(): ActivityState {
    return {
      lastDataAt: this.lastDataAt,
      lastInputAt: this.lastInputAt,
      busySince: this.busySince,
      idleSince: this.idleSince,
      subscriberCount: this.subscribers.size,
      hasAuthority: this.authority !== null,
    };
  }

  getDimensions(): Dimensions {
    return { ...this.dimensions };
  }

  getAuthority(): string | null {
    return this.authority;
  }

  hasSubscriber(clientId: string): boolean {
    return this.subscribers.has(clientId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.subscribers.clear();
    this.authority = null;
    this.bufferedFrames = [];
    this.stream.removeAllListeners();
  }
}
