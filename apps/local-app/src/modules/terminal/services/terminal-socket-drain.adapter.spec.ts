import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Socket } from 'socket.io';
import {
  PINNED_ENGINE_IO_VERSION,
  PINNED_SOCKET_IO_VERSION,
  TerminalSocketDrainAdapter,
} from './terminal-socket-drain.adapter';

function createSocket(writable: boolean): {
  socket: Socket;
  transport: EventEmitter & { writable: boolean };
  emit: jest.Mock;
  connection: {
    readyState: string;
    transport: EventEmitter & { writable: boolean };
    writeBuffer: unknown[];
  };
} {
  const transport = Object.assign(new EventEmitter(), { writable });
  const emit = jest.fn();
  const connection = { readyState: 'open', transport, writeBuffer: [] as unknown[] };
  const socket = { id: 'socket-a', connected: true, conn: connection, emit } as unknown as Socket;
  return { socket, transport, emit, connection };
}

describe('TerminalSocketDrainAdapter', () => {
  const adapter = new TerminalSocketDrainAdapter();

  it('never emits while the Engine.IO transport is unwritable', () => {
    const { socket, emit } = createSocket(false);

    expect(adapter.send(socket, { type: 'data' }, jest.fn())).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('completes a sent batch only on the transport drain signal', () => {
    const { socket, transport, emit } = createSocket(true);
    const complete = jest.fn();

    expect(adapter.send(socket, { type: 'data' }, complete)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();

    transport.emit('drain');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('observes the next writable edge without polling', () => {
    const { socket, transport } = createSocket(false);
    const ready = jest.fn();

    const cancel = adapter.onWritable(socket, ready);
    transport.writable = true;
    transport.emit('ready');

    expect(ready).toHaveBeenCalledTimes(1);
    cancel();
  });

  it('reports the private Engine.IO buffer only through the adapter', () => {
    const { socket, connection } = createSocket(false);
    connection.writeBuffer.push({}, {});
    expect(adapter.getBufferedPacketCount(socket)).toBe(2);
  });
});

describe('Socket.IO and Engine.IO pinned internals guard', () => {
  it('fails when versions or the writable/drain surface changes', () => {
    const socketIoRoot = join(dirname(require.resolve('socket.io')), '..');
    const engineIoRoot = join(dirname(require.resolve('engine.io')), '..');
    const socketIoPackagePath = join(socketIoRoot, 'package.json');
    const engineIoPackagePath = join(engineIoRoot, 'package.json');
    const socketIoPackage = JSON.parse(readFileSync(socketIoPackagePath, 'utf8')) as {
      version: string;
    };
    const engineIoPackage = JSON.parse(readFileSync(engineIoPackagePath, 'utf8')) as {
      version: string;
    };
    const socketIoClient = readFileSync(join(socketIoRoot, 'dist/client.js'), 'utf8');
    const engineIoSocket = readFileSync(join(engineIoRoot, 'build/socket.js'), 'utf8');
    const engineIoWebSocket = readFileSync(
      join(engineIoRoot, 'build/transports/websocket.js'),
      'utf8',
    );

    expect(socketIoPackage.version).toBe(PINNED_SOCKET_IO_VERSION);
    expect(engineIoPackage.version).toBe(PINNED_ENGINE_IO_VERSION);
    expect(socketIoClient).toContain('if (opts.volatile && !this.conn.transport.writable)');
    expect(socketIoClient).toContain('this.conn.write(encodedPacket, opts)');
    expect(engineIoSocket).toContain('this.writeBuffer.push(packet)');
    expect(engineIoSocket).toContain('this.transport.writable &&');
    expect(engineIoSocket).toContain('this.transport.on("drain", onDrain)');
    expect(engineIoWebSocket).toContain('this.writable = false');
    expect(engineIoWebSocket).toContain('this.emit("drain")');
    expect(engineIoWebSocket).toContain('this.emit("ready")');
  });
});
