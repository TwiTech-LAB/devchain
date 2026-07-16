import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

export const PINNED_SOCKET_IO_VERSION = '4.8.1';
export const PINNED_ENGINE_IO_VERSION = '6.6.4';

type DrainListener = () => void;

interface EngineTransportSurface {
  writable: boolean;
  once(event: 'drain' | 'ready', listener: DrainListener): unknown;
  removeListener(event: 'drain' | 'ready', listener: DrainListener): unknown;
}

interface EngineSocketSurface {
  readyState: string;
  transport: EngineTransportSurface;
  writeBuffer?: unknown[];
}

/**
 * The only module allowed to touch Engine.IO transport internals for terminal flow control.
 * Keep its pinned surface and guard spec aligned before upgrading Socket.IO or Engine.IO.
 */
@Injectable()
export class TerminalSocketDrainAdapter {
  isWritable(socket: Socket): boolean {
    const connection = this.getConnection(socket);
    return (
      socket.connected !== false &&
      connection?.readyState === 'open' &&
      connection.transport?.writable === true
    );
  }

  send(socket: Socket, envelope: unknown, onComplete: () => void): boolean {
    if (!this.isWritable(socket)) return false;

    const transport = this.getConnection(socket)!.transport;
    let complete = false;
    const handleDrain = () => {
      if (complete) return;
      complete = true;
      onComplete();
    };

    transport.once('drain', handleDrain);
    try {
      socket.emit('message', envelope);
      return true;
    } catch (error) {
      transport.removeListener('drain', handleDrain);
      throw error;
    }
  }

  onWritable(socket: Socket, listener: () => void): () => void {
    const connection = this.getConnection(socket);
    const transport = connection?.transport;
    if (!transport) return () => undefined;

    let active = true;
    const handleReady = () => {
      if (!active) return;
      active = false;
      transport.removeListener('ready', handleReady);
      listener();
    };

    transport.once('ready', handleReady);
    if (this.isWritable(socket)) queueMicrotask(handleReady);

    return () => {
      if (!active) return;
      active = false;
      transport.removeListener('ready', handleReady);
    };
  }

  getBufferedPacketCount(socket: Socket): number {
    return this.getConnection(socket)?.writeBuffer?.length ?? 0;
  }

  private getConnection(socket: Socket): EngineSocketSurface | undefined {
    return socket.conn as unknown as EngineSocketSurface | undefined;
  }
}
