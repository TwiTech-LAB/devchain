import { TerminalFrameStream, type FrameEvent } from './terminal-frame-stream';
import { normalizeLineEndings } from '../../utils/normalize-line-endings';

export interface AuthorityResult {
  readonly granted: boolean;
  readonly previousHolder?: string;
}

export interface ResizeResult {
  readonly applied: boolean;
  readonly reason?: 'not_authority' | 'unchanged' | 'debounced';
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

    io.captureHistory({ name: tmuxSessionName }).then((result) => {
      if (!result.ok || this.disposed) return;

      const ansi = this.normalizeCapturedOutput(result.output);
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
            ...(i === totalChunks - 1 ? { hasHistory: true } : {}),
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

    if (this.dimensions.cols === dims.cols && this.dimensions.rows === dims.rows) {
      return { applied: false, reason: 'unchanged' };
    }

    this.pendingResize = { clientId, dims };

    if (this.resizeTimer) {
      return { applied: false, reason: 'debounced' };
    }

    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.pendingResize) {
        this.dimensions = this.pendingResize.dims;
        this.suppressActivityUntil = Date.now() + ACTIVITY_SUPPRESSION_MS;
        this.pendingResize = null;
      }
    }, RESIZE_DEBOUNCE_MS);

    return { applied: true };
  }

  bindIO(io: TerminalIORef): void {
    this.io = io;
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
    return this.normalizeCapturedLineEndings ? normalizeLineEndings(output) : output;
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
