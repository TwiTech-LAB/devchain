#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Namespace } = require('socket.io');

const CONTROL_EVENT = 'memory-soak:stall-engine-transport';
const token = process.env.MEMORY_SOAK_TRANSPORT_STALL_TOKEN;
const stateFile = process.env.MEMORY_SOAK_TRANSPORT_STALL_STATE_FILE;

if (!token || !stateFile) {
  throw new Error('The transport-stall preload requires its fixture token and state file');
}

const emitReserved = Namespace.prototype.emitReserved;
Namespace.prototype.emitReserved = function patchedEmitReserved(event, ...args) {
  if (event === 'connection') {
    const socket = args[0];
    socket.on(CONTROL_EVENT, (payload) => {
      if (payload?.token !== token) return;
      const transport = socket.conn?.transport;
      if (!transport) return;

      Object.defineProperty(transport, 'writable', {
        configurable: true,
        enumerable: true,
        get: () => false,
        set: () => undefined,
      });
      fs.writeFileSync(
        stateFile,
        `${JSON.stringify({ socketId: socket.id, activatedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
    });
  }
  return emitReserved.call(this, event, ...args);
};

module.exports = { CONTROL_EVENT };
