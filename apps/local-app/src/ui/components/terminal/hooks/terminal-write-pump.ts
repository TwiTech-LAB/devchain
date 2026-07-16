import type { Terminal } from '@xterm/xterm';

export const DEFAULT_TERMINAL_WRITE_QUEUE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TERMINAL_WRITE_BATCH_BYTES = 64 * 1024;

export type TerminalWriteKind = 'live' | 'seed' | 'history' | 'control';

export interface TerminalWriteOptions {
  kind?: TerminalWriteKind;
  beforeWrite?: () => void;
  onComplete?: () => void;
}

export interface TerminalWritePumpSnapshot {
  status: 'detached' | 'ready' | 'seeding' | 'desynchronized' | 'recovering';
  queuedBytes: number;
  inFlightBytes: number;
  queuedBatches: number;
  overflowCount: number;
}

export interface TerminalWritePumpApi {
  setTerminal: (terminal: Terminal | null) => void;
  write: (data: string, options?: TerminalWriteOptions) => boolean;
  flush: () => void;
  discardPending: () => void;
  beginSeed: () => void;
  beginRecovery: () => void;
  completeRecovery: () => void;
  isDesynchronized: () => boolean;
  getSnapshot: () => TerminalWritePumpSnapshot;
  dispose: () => void;
}

interface QueuedBatch {
  data: string;
  bytes: number;
  epoch: number;
  terminalGeneration: number;
  kind: TerminalWriteKind;
  beforeWrite?: () => void;
  onComplete?: () => void;
}

export interface TerminalWritePumpConfig {
  queueBytes?: number;
  batchBytes?: number;
  onOverflow: () => void;
}

function codePointBytes(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const codePoint of value) bytes += codePointBytes(codePoint);
  return bytes;
}

function chunkUtf8(value: string, maxBytes: number): Array<{ data: string; bytes: number }> {
  if (value.length === 0) return [{ data: '', bytes: 0 }];
  const chunks: Array<{ data: string; bytes: number }> = [];
  let chunk = '';
  let bytes = 0;

  for (const codePoint of value) {
    const nextBytes = codePointBytes(codePoint);
    if (bytes + nextBytes > maxBytes && chunk.length > 0) {
      chunks.push({ data: chunk, bytes });
      chunk = '';
      bytes = 0;
    }
    chunk += codePoint;
    bytes += nextBytes;
  }
  if (chunk.length > 0) chunks.push({ data: chunk, bytes });
  return chunks;
}

export class TerminalWritePump implements TerminalWritePumpApi {
  private readonly queueBytes: number;
  private readonly batchBytes: number;
  private readonly onOverflow: () => void;
  private terminal: Terminal | null = null;
  private terminalGeneration = 0;
  private epoch = 0;
  private queue: QueuedBatch[] = [];
  private queuedBytes = 0;
  private inFlight: QueuedBatch | null = null;
  private status: TerminalWritePumpSnapshot['status'] = 'detached';
  private overflowCount = 0;
  private overflowNotified = false;

  constructor(config: TerminalWritePumpConfig) {
    this.queueBytes = config.queueBytes ?? DEFAULT_TERMINAL_WRITE_QUEUE_BYTES;
    this.batchBytes = config.batchBytes ?? DEFAULT_TERMINAL_WRITE_BATCH_BYTES;
    this.onOverflow = config.onOverflow;
  }

  setTerminal(terminal: Terminal | null): void {
    if (this.terminal === terminal) return;
    this.terminalGeneration += 1;
    this.epoch += 1;
    this.terminal = terminal;
    this.queue = [];
    this.queuedBytes = 0;
    this.inFlight = null;
    this.status = terminal ? 'ready' : 'detached';
    this.overflowNotified = false;
  }

  write(data: string, options: TerminalWriteOptions = {}): boolean {
    const terminal = this.terminal;
    if (!terminal) return false;

    const kind = options.kind ?? 'live';
    if (this.status === 'desynchronized') return false;
    if (this.status === 'recovering' && kind !== 'seed') return false;

    const chunks = chunkUtf8(data, this.batchBytes);
    const bytes = chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    if (this.queuedBytes + bytes > this.queueBytes) {
      this.enterDesynchronized();
      return false;
    }

    const epoch = this.epoch;
    const terminalGeneration = this.terminalGeneration;
    const batches = chunks.map((chunk, index): QueuedBatch => {
      return {
        ...chunk,
        epoch,
        terminalGeneration,
        kind,
        ...(index === 0 && options.beforeWrite ? { beforeWrite: options.beforeWrite } : {}),
        ...(index === chunks.length - 1 && options.onComplete
          ? { onComplete: options.onComplete }
          : {}),
      };
    });
    this.queue =
      kind === 'seed' && this.status === 'seeding'
        ? [...batches, ...this.queue]
        : [...this.queue, ...batches];
    this.queuedBytes += bytes;
    this.pump();
    return true;
  }

  flush(): void {
    this.pump();
  }

  discardPending(): void {
    this.epoch += 1;
    this.queue = [];
    this.queuedBytes = 0;
  }

  beginSeed(): void {
    if (!this.terminal) return;
    this.discardPending();
    this.status = 'seeding';
  }

  beginRecovery(): void {
    if (!this.terminal) return;
    this.discardPending();
    this.status = 'recovering';
  }

  completeRecovery(): void {
    if (this.status !== 'recovering' && this.status !== 'seeding') return;
    this.status = 'ready';
    this.overflowNotified = false;
    this.pump();
  }

  isDesynchronized(): boolean {
    return this.status === 'desynchronized' || this.status === 'recovering';
  }

  getSnapshot(): TerminalWritePumpSnapshot {
    return {
      status: this.status,
      queuedBytes: this.queuedBytes,
      inFlightBytes: this.inFlight?.bytes ?? 0,
      queuedBatches: this.queue.length,
      overflowCount: this.overflowCount,
    };
  }

  dispose(): void {
    this.setTerminal(null);
  }

  private enterDesynchronized(): void {
    this.epoch += 1;
    this.queue = [];
    this.queuedBytes = 0;
    this.status = 'desynchronized';
    this.overflowCount += 1;
    if (this.overflowNotified) return;
    this.overflowNotified = true;
    this.onOverflow();
  }

  private pump(): void {
    if (!this.terminal || this.inFlight || this.queue.length === 0) return;
    if (this.status === 'desynchronized') return;
    if (
      (this.status === 'seeding' || this.status === 'recovering') &&
      this.queue[0]?.kind !== 'seed'
    ) {
      return;
    }

    const batch = this.queue.shift()!;
    this.queuedBytes -= batch.bytes;
    if (
      batch.epoch !== this.epoch ||
      batch.terminalGeneration !== this.terminalGeneration ||
      ((this.status === 'recovering' || this.status === 'seeding') && batch.kind !== 'seed')
    ) {
      this.pump();
      return;
    }

    const terminal = this.terminal;
    this.inFlight = batch;
    try {
      batch.beforeWrite?.();
      if (batch.data.length === 0) {
        this.finishBatch(batch, terminal);
        return;
      }
      terminal.write(batch.data, () => this.finishBatch(batch, terminal));
    } catch {
      this.inFlight = null;
      this.enterDesynchronized();
    }
  }

  private finishBatch(batch: QueuedBatch, terminal: Terminal): void {
    if (
      this.inFlight !== batch ||
      this.terminal !== terminal ||
      batch.terminalGeneration !== this.terminalGeneration
    ) {
      return;
    }

    this.inFlight = null;
    if (batch.epoch === this.epoch) batch.onComplete?.();
    this.pump();
  }
}
