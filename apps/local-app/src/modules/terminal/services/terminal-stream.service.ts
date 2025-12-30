import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { TerminalDataPayload, WsEnvelope, createEnvelope } from '../dtos/ws-envelope.dto';

const logger = createLogger('TerminalStreamService');

interface FrameBuffer {
  frames: WsEnvelope[];
  maxSize: number;
}

/**
 * Service for managing terminal frame buffering and replay
 */
@Injectable()
export class TerminalStreamService {
  private frameBuffers: Map<string, FrameBuffer> = new Map();
  private sequenceCounters: Map<string, number> = new Map();
  private readonly MAX_BUFFER_SIZE = 100;
  private readonly MAX_FRAME_SIZE = 64 * 1024; // 64KB per frame

  /**
   * Initialize frame buffer for session
   */
  initializeBuffer(sessionId: string): void {
    if (!this.frameBuffers.has(sessionId)) {
      this.frameBuffers.set(sessionId, {
        frames: [],
        maxSize: this.MAX_BUFFER_SIZE,
      });
      this.sequenceCounters.set(sessionId, 0);
      logger.info({ sessionId }, 'Initialized frame buffer');
    }
  }

  /**
   * Add frame to buffer with sequence number
   */
  addFrame(sessionId: string, data: string): WsEnvelope {
    this.initializeBuffer(sessionId);

    const sequence = this.getNextSequence(sessionId);
    const buffer = this.frameBuffers.get(sessionId)!;

    // Check if data exceeds max frame size, chunk if necessary
    if (data.length > this.MAX_FRAME_SIZE) {
      logger.warn(
        { sessionId, dataLength: data.length },
        'Data exceeds max frame size, chunking...',
      );
      // For now, we'll just log a warning. In production, implement chunking.
    }

    const payload: TerminalDataPayload = { data, sequence };
    const envelope = createEnvelope(`terminal/${sessionId}`, 'data', payload);

    // Add to buffer
    buffer.frames.push(envelope);

    // Trim buffer to max size (keep last N frames)
    if (buffer.frames.length > buffer.maxSize) {
      buffer.frames.shift();
    }

    return envelope;
  }

  /**
   * Get buffered frames since sequence number (for replay)
   */
  getFramesSince(sessionId: string, lastSequence?: number): WsEnvelope[] {
    const buffer = this.frameBuffers.get(sessionId);
    if (!buffer) {
      return [];
    }

    if (lastSequence === undefined) {
      // Return all buffered frames
      return [...buffer.frames];
    }

    // Return frames after lastSequence
    return buffer.frames.filter((frame) => {
      const payload = frame.payload as TerminalDataPayload;
      return payload.sequence !== undefined && payload.sequence > lastSequence;
    });
  }

  /**
   * Clear buffer for session
   */
  clearBuffer(sessionId: string): void {
    this.frameBuffers.delete(sessionId);
    this.sequenceCounters.delete(sessionId);
    logger.info({ sessionId }, 'Cleared frame buffer');
  }

  /**
   * Get current sequence number for session
   */
  getCurrentSequence(sessionId: string): number {
    return this.sequenceCounters.get(sessionId) || 0;
  }

  /**
   * Get next sequence number
   */
  private getNextSequence(sessionId: string): number {
    const current = this.sequenceCounters.get(sessionId) || 0;
    const next = current + 1;
    this.sequenceCounters.set(sessionId, next);
    return next;
  }

  /**
   * Get buffer stats for monitoring
   */
  getBufferStats(sessionId: string): { size: number; sequence: number } | null {
    const buffer = this.frameBuffers.get(sessionId);
    if (!buffer) {
      return null;
    }

    return {
      size: buffer.frames.length,
      sequence: this.getCurrentSequence(sessionId),
    };
  }
}
