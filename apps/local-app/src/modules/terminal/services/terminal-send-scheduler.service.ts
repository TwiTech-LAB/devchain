import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { WsEnvelope } from '../dtos/ws-envelope.dto';
import { TerminalSocketDrainAdapter } from './terminal-socket-drain.adapter';

export const TERMINAL_SEND_SCHEDULER_OPTIONS = Symbol('TERMINAL_SEND_SCHEDULER_OPTIONS');

export const DEFAULT_TERMINAL_SOCKET_QUEUE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TERMINAL_SOCKET_BATCH_BYTES = 128 * 1024;

export interface TerminalSendSchedulerOptions {
  queueBytes?: number;
  batchBytes?: number;
}

/** A lane emits NewlyDesynchronized only for the admission that fails it; later frames reject. */
export const TerminalSendAdmission = {
  Accepted: 'accepted',
  NewlyDesynchronized: 'newlyDesynchronized',
  Rejected: 'rejected',
} as const;

export type TerminalSendAdmissionResult =
  (typeof TerminalSendAdmission)[keyof typeof TerminalSendAdmission];

export interface TerminalSessionLaneSnapshot {
  queuedBytes: number;
  desynchronized: boolean;
  recoveryActive: boolean;
  recoveryEpoch?: number;
  droppedFrames: number;
  droppedBytes: number;
}

export interface TerminalSocketQueueSnapshot {
  queuedBytes: number;
  inFlightBytes: number;
  desynchronized: boolean;
  droppedFrames: number;
  droppedBytes: number;
  engineBufferedPackets: number;
  lanes: Record<string, TerminalSessionLaneSnapshot>;
}

export interface TerminalSendSchedulerSnapshot {
  terminalQueuedBytes: number;
  terminalInFlightBytes: number;
  terminalDesynchronizedClients: number;
  terminalDesynchronizedLanes: number;
  terminalDroppedFrames: number;
  terminalDroppedBytes: number;
  terminalQueues: Record<string, TerminalSocketQueueSnapshot>;
}

interface QueueItem {
  envelope: WsEnvelope;
  bytes: number;
  frames: number;
  recovery: boolean;
  laneVersion: number;
  onComplete?: () => void;
}

interface SessionLaneState {
  sessionId: string;
  queue: QueueItem[];
  queuedBytes: number;
  desynchronized: boolean;
  recoveryActive: boolean;
  recoveryEpoch?: number;
  version: number;
  droppedFrames: number;
  droppedBytes: number;
}

interface SocketState {
  socket: Socket;
  lanes: Map<string, SessionLaneState>;
  laneOrder: string[];
  nextLaneIndex: number;
  queuedBytes: number;
  inFlightBytes: number;
  inFlight: boolean;
  waitingForWritable?: () => void;
}

/**
 * Session lanes isolate ordering and recovery state. Their queued bytes, writable-edge listener,
 * and callback-gated in-flight batch remain aggregate socket-owned limits.
 */
@Injectable()
export class TerminalSendSchedulerService {
  private readonly states = new Map<string, SocketState>();
  private readonly queueBytes: number;
  private readonly batchBytes: number;

  constructor(
    private readonly drainAdapter: TerminalSocketDrainAdapter,
    @Optional()
    @Inject(TERMINAL_SEND_SCHEDULER_OPTIONS)
    options: TerminalSendSchedulerOptions = {},
  ) {
    this.queueBytes = options.queueBytes ?? DEFAULT_TERMINAL_SOCKET_QUEUE_BYTES;
    this.batchBytes = options.batchBytes ?? DEFAULT_TERMINAL_SOCKET_BATCH_BYTES;
  }

  registerSocket(socket: Socket): void {
    const existing = this.states.get(socket.id);
    if (existing) {
      existing.socket = socket;
      return;
    }
    this.states.set(socket.id, {
      socket,
      lanes: new Map(),
      laneOrder: [],
      nextLaneIndex: 0,
      queuedBytes: 0,
      inFlightBytes: 0,
      inFlight: false,
    });
  }

  removeSocket(socketId: string): void {
    const state = this.states.get(socketId);
    state?.waitingForWritable?.();
    this.states.delete(socketId);
  }

  removeLane(socketId: string, sessionId: string): void {
    const state = this.states.get(socketId);
    if (!state) return;
    const lane = state.lanes.get(sessionId);
    if (!lane) return;
    state.queuedBytes -= lane.queuedBytes;
    state.lanes.delete(sessionId);
    const laneIndex = state.laneOrder.indexOf(sessionId);
    if (laneIndex >= 0) {
      state.laneOrder.splice(laneIndex, 1);
      if (laneIndex < state.nextLaneIndex) state.nextLaneIndex -= 1;
      if (state.nextLaneIndex >= state.laneOrder.length) state.nextLaneIndex = 0;
    }
    this.reconcileWritableWait(state);
    this.pump(state);
  }

  removeSession(sessionId: string): void {
    for (const socketId of this.states.keys()) this.removeLane(socketId, sessionId);
  }

  enqueueLive(socket: Socket, envelope: WsEnvelope): TerminalSendAdmissionResult {
    return this.enqueue(socket, envelope, false);
  }

  enqueueRecovery(
    socket: Socket,
    envelope: WsEnvelope,
    onComplete?: () => void,
  ): TerminalSendAdmissionResult {
    return this.enqueue(socket, envelope, true, onComplete);
  }

  beginRecovery(socket: Socket, sessionId: string, recoveryEpoch: number): boolean {
    const state = this.getOrCreateState(socket);
    const lane = this.getOrCreateLane(state, sessionId);
    if (lane.recoveryEpoch !== undefined && recoveryEpoch <= lane.recoveryEpoch) return false;
    this.clearLaneQueue(state, lane);
    lane.version += 1;
    lane.desynchronized = true;
    lane.recoveryActive = true;
    lane.recoveryEpoch = recoveryEpoch;
    this.reconcileWritableWait(state);
    this.pump(state);
    return true;
  }

  markSynchronized(socketId: string, sessionId: string, recoveryEpoch: number): boolean {
    const state = this.states.get(socketId);
    const lane = state?.lanes.get(sessionId);
    if (!lane || !lane.recoveryActive || lane.recoveryEpoch !== recoveryEpoch) return false;
    lane.desynchronized = false;
    lane.recoveryActive = false;
    if (state) this.pump(state);
    return true;
  }

  isDesynchronized(socketId: string, sessionId: string): boolean {
    return this.states.get(socketId)?.lanes.get(sessionId)?.desynchronized ?? false;
  }

  getStats(): TerminalSendSchedulerSnapshot {
    const snapshot: TerminalSendSchedulerSnapshot = {
      terminalQueuedBytes: 0,
      terminalInFlightBytes: 0,
      terminalDesynchronizedClients: 0,
      terminalDesynchronizedLanes: 0,
      terminalDroppedFrames: 0,
      terminalDroppedBytes: 0,
      terminalQueues: {},
    };

    for (const [socketId, state] of this.states) {
      const lanes: Record<string, TerminalSessionLaneSnapshot> = {};
      let desynchronized = false;
      let droppedFrames = 0;
      let droppedBytes = 0;
      for (const [sessionId, lane] of state.lanes) {
        desynchronized ||= lane.desynchronized;
        droppedFrames += lane.droppedFrames;
        droppedBytes += lane.droppedBytes;
        snapshot.terminalDesynchronizedLanes += Number(lane.desynchronized);
        lanes[sessionId] = {
          queuedBytes: lane.queuedBytes,
          desynchronized: lane.desynchronized,
          recoveryActive: lane.recoveryActive,
          ...(lane.recoveryEpoch !== undefined && { recoveryEpoch: lane.recoveryEpoch }),
          droppedFrames: lane.droppedFrames,
          droppedBytes: lane.droppedBytes,
        };
      }
      snapshot.terminalQueuedBytes += state.queuedBytes;
      snapshot.terminalInFlightBytes += state.inFlightBytes;
      snapshot.terminalDesynchronizedClients += Number(desynchronized);
      snapshot.terminalDroppedFrames += droppedFrames;
      snapshot.terminalDroppedBytes += droppedBytes;
      snapshot.terminalQueues[socketId] = {
        queuedBytes: state.queuedBytes,
        inFlightBytes: state.inFlightBytes,
        desynchronized,
        droppedFrames,
        droppedBytes,
        engineBufferedPackets: this.drainAdapter.getBufferedPacketCount(state.socket),
        lanes,
      };
    }
    return snapshot;
  }

  dispose(): void {
    for (const state of this.states.values()) state.waitingForWritable?.();
    this.states.clear();
  }

  private enqueue(
    socket: Socket,
    envelope: WsEnvelope,
    recovery: boolean,
    onComplete?: () => void,
  ): TerminalSendAdmissionResult {
    const state = this.getOrCreateState(socket);
    const sessionId = this.sessionIdForEnvelope(envelope);
    if (!sessionId) return TerminalSendAdmission.Rejected;
    const lane = this.getOrCreateLane(state, sessionId);
    if (lane.desynchronized && (!recovery || !lane.recoveryActive)) {
      return TerminalSendAdmission.Rejected;
    }
    const laneVersion = lane.version;
    const wasDesynchronized = lane.desynchronized;

    const item: QueueItem = {
      envelope,
      bytes: this.measureEnvelope(envelope),
      frames: 1,
      recovery,
      laneVersion: lane.version,
      onComplete,
    };

    if (this.tryCoalesce(state, lane, item)) {
      this.pump(state);
      return this.admissionAfterPump(lane, laneVersion, wasDesynchronized);
    }

    if (item.bytes > this.batchBytes || state.queuedBytes + item.bytes > this.queueBytes) {
      this.dropAndDesynchronize(state, lane, item);
      this.pump(state);
      return wasDesynchronized
        ? TerminalSendAdmission.Rejected
        : TerminalSendAdmission.NewlyDesynchronized;
    }

    lane.queue.push(item);
    lane.queuedBytes += item.bytes;
    state.queuedBytes += item.bytes;
    this.pump(state);
    return this.admissionAfterPump(lane, laneVersion, wasDesynchronized);
  }

  private admissionAfterPump(
    lane: SessionLaneState,
    priorVersion: number,
    wasDesynchronized: boolean,
  ): TerminalSendAdmissionResult {
    if (lane.version === priorVersion) return TerminalSendAdmission.Accepted;
    return wasDesynchronized
      ? TerminalSendAdmission.Rejected
      : TerminalSendAdmission.NewlyDesynchronized;
  }

  private getOrCreateState(socket: Socket): SocketState {
    this.registerSocket(socket);
    return this.states.get(socket.id)!;
  }

  private getOrCreateLane(state: SocketState, sessionId: string): SessionLaneState {
    const existing = state.lanes.get(sessionId);
    if (existing) return existing;
    const lane: SessionLaneState = {
      sessionId,
      queue: [],
      queuedBytes: 0,
      desynchronized: false,
      recoveryActive: false,
      version: 0,
      droppedFrames: 0,
      droppedBytes: 0,
    };
    state.lanes.set(sessionId, lane);
    state.laneOrder.push(sessionId);
    return lane;
  }

  private tryCoalesce(state: SocketState, lane: SessionLaneState, incoming: QueueItem): boolean {
    const previous = lane.queue.at(-1);
    if (
      !previous ||
      previous.recovery ||
      incoming.recovery ||
      previous.envelope.type !== 'data' ||
      incoming.envelope.type !== 'data' ||
      previous.envelope.topic !== incoming.envelope.topic
    ) {
      return false;
    }

    const previousPayload = previous.envelope.payload as { data?: unknown; sequence?: number };
    const incomingPayload = incoming.envelope.payload as { data?: unknown; sequence?: number };
    if (typeof previousPayload.data !== 'string' || typeof incomingPayload.data !== 'string') {
      return false;
    }

    const mergedEnvelope: WsEnvelope = {
      ...incoming.envelope,
      payload: {
        ...previousPayload,
        ...incomingPayload,
        data: previousPayload.data + incomingPayload.data,
      },
    };
    const mergedBytes = this.measureEnvelope(mergedEnvelope);
    if (
      mergedBytes > this.batchBytes ||
      state.queuedBytes - previous.bytes + mergedBytes > this.queueBytes
    ) {
      return false;
    }

    const addedBytes = mergedBytes - previous.bytes;
    state.queuedBytes += addedBytes;
    lane.queuedBytes += addedBytes;
    previous.envelope = mergedEnvelope;
    previous.bytes = mergedBytes;
    previous.frames += incoming.frames;
    return true;
  }

  private dropAndDesynchronize(
    state: SocketState,
    lane: SessionLaneState,
    incoming: QueueItem,
  ): void {
    lane.droppedFrames +=
      lane.queue.reduce((total, item) => total + item.frames, 0) + incoming.frames;
    lane.droppedBytes += lane.queuedBytes + incoming.bytes;
    this.clearLaneQueue(state, lane);
    lane.version += 1;
    lane.desynchronized = true;
    lane.recoveryActive = false;
    this.reconcileWritableWait(state);
  }

  private pump(state: SocketState): void {
    if (state.inFlight) return;
    const selected = this.selectNextLane(state);
    if (!selected) return;
    if (!this.drainAdapter.isWritable(state.socket)) {
      this.armWritableEdge(state);
      return;
    }

    const { lane, index } = selected;
    const item = lane.queue.shift()!;
    lane.queuedBytes -= item.bytes;
    state.queuedBytes -= item.bytes;
    state.nextLaneIndex = state.laneOrder.length > 0 ? (index + 1) % state.laneOrder.length : 0;
    state.inFlight = true;
    state.inFlightBytes = item.bytes;

    let sent = false;
    try {
      sent = this.drainAdapter.send(state.socket, item.envelope, () => {
        if (this.states.get(state.socket.id) !== state) return;
        state.inFlight = false;
        state.inFlightBytes = 0;
        if (state.lanes.get(lane.sessionId) === lane && lane.version === item.laneVersion) {
          item.onComplete?.();
        }
        this.pump(state);
      });
    } catch {
      state.inFlight = false;
      state.inFlightBytes = 0;
      this.dropAndDesynchronize(state, lane, item);
      this.pump(state);
      return;
    }

    if (!sent) {
      state.inFlight = false;
      state.inFlightBytes = 0;
      lane.queue.unshift(item);
      lane.queuedBytes += item.bytes;
      state.queuedBytes += item.bytes;
      this.armWritableEdge(state);
    }
  }

  private selectNextLane(
    state: SocketState,
  ): { lane: SessionLaneState; index: number } | undefined {
    for (let offset = 0; offset < state.laneOrder.length; offset += 1) {
      const index = (state.nextLaneIndex + offset) % state.laneOrder.length;
      const lane = state.lanes.get(state.laneOrder[index]);
      if (lane && lane.queue.length > 0 && (!lane.desynchronized || lane.recoveryActive)) {
        return { lane, index };
      }
    }
    return undefined;
  }

  private clearLaneQueue(state: SocketState, lane: SessionLaneState): void {
    state.queuedBytes -= lane.queuedBytes;
    lane.queue = [];
    lane.queuedBytes = 0;
  }

  private reconcileWritableWait(state: SocketState): void {
    if (state.waitingForWritable && !this.selectNextLane(state)) {
      state.waitingForWritable();
      state.waitingForWritable = undefined;
    }
  }

  private armWritableEdge(state: SocketState): void {
    if (state.waitingForWritable) return;
    state.waitingForWritable = this.drainAdapter.onWritable(state.socket, () => {
      state.waitingForWritable = undefined;
      if (this.states.get(state.socket.id) === state) this.pump(state);
    });
  }

  private sessionIdForEnvelope(envelope: WsEnvelope): string | undefined {
    const prefix = 'terminal/';
    if (!envelope.topic.startsWith(prefix)) return undefined;
    const sessionId = envelope.topic.slice(prefix.length);
    return sessionId.length > 0 ? sessionId : undefined;
  }

  private measureEnvelope(envelope: WsEnvelope): number {
    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object') {
      return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    }

    const record = payload as Record<string, unknown>;
    const terminalContent =
      typeof record.data === 'string'
        ? record.data
        : typeof record.history === 'string'
          ? record.history
          : undefined;
    if (terminalContent === undefined) {
      return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    }

    const metadata = { ...record };
    if (typeof metadata.data === 'string') metadata.data = '';
    if (typeof metadata.history === 'string') metadata.history = '';
    return (
      Buffer.byteLength(terminalContent, 'utf8') +
      Buffer.byteLength(JSON.stringify({ ...envelope, payload: metadata }), 'utf8')
    );
  }
}
