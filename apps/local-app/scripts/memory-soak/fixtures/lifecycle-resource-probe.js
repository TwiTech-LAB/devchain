#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const Module = require('node:module');

const stateFile = process.env.MEMORY_SOAK_LIFECYCLE_STATE_FILE;
if (!stateFile) throw new Error('The lifecycle resource probe requires a state file');

const patched = Symbol('memory-soak-lifecycle-probe');
const references = {
  gateway: null,
  pty: null,
  registry: null,
  stream: null,
};
const events = [];

function mapSize(owner, field) {
  const value = owner?.[field];
  return value instanceof Map || value instanceof Set ? value.size : 0;
}

function has(owner, field, sessionId) {
  const value = owner?.[field];
  return Boolean(
    sessionId && (value instanceof Map || value instanceof Set) && value.has(sessionId),
  );
}

function persist(method, sessionId) {
  events.push({ method, sessionId: sessionId ?? null, at: new Date().toISOString() });
  if (events.length > 256) events.splice(0, events.length - 256);
  const snapshot = {
    capturedAt: new Date().toISOString(),
    counts: {
      registryEntries: mapSize(references.registry, 'sessions'),
      frameListeners: mapSize(references.gateway, 'frameListeners'),
      ptySessions: mapSize(references.pty, 'activeSessions'),
      frameBuffers: mapSize(references.stream, 'frameBuffers'),
    },
    session: sessionId
      ? {
          sessionId,
          registryEntry: has(references.registry, 'sessions', sessionId),
          frameListener: has(references.gateway, 'frameListeners', sessionId),
          ptySession: has(references.pty, 'activeSessions', sessionId),
          frameBuffer: has(references.stream, 'frameBuffers', sessionId),
        }
      : null,
    events,
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function patchMethod(prototype, method, referenceName, sessionIdAt = 0) {
  const original = prototype?.[method];
  if (typeof original !== 'function' || original[patched]) return;
  function instrumented(...args) {
    references[referenceName] = this;
    const sessionId = typeof args[sessionIdAt] === 'string' ? args[sessionIdAt] : null;
    const result = original.apply(this, args);
    if (result && typeof result.then === 'function') {
      return result.finally(() => persist(`${referenceName}.${method}`, sessionId));
    }
    persist(`${referenceName}.${method}`, sessionId);
    return result;
  }
  Object.defineProperty(instrumented, patched, { value: true });
  prototype[method] = instrumented;
}

function patchExports(exports) {
  if (exports?.TerminalSessionRegistry) {
    patchMethod(exports.TerminalSessionRegistry.prototype, 'create', 'registry');
    patchMethod(exports.TerminalSessionRegistry.prototype, 'dispose', 'registry');
  }
  if (exports?.TerminalGateway) {
    patchMethod(exports.TerminalGateway.prototype, 'wireFrameListener', 'gateway');
    patchMethod(exports.TerminalGateway.prototype, 'unwireFrameListener', 'gateway');
    patchMethod(exports.TerminalGateway.prototype, 'cleanupSessionLifecycle', 'gateway');
  }
  if (exports?.PtyService) {
    patchMethod(exports.PtyService.prototype, 'startStreaming', 'pty');
    patchMethod(exports.PtyService.prototype, 'stopStreaming', 'pty');
  }
  if (exports?.TerminalStreamService) {
    patchMethod(exports.TerminalStreamService.prototype, 'initializeBuffer', 'stream');
    patchMethod(exports.TerminalStreamService.prototype, 'addFrame', 'stream');
    patchMethod(exports.TerminalStreamService.prototype, 'clearBuffer', 'stream');
  }
}

const load = Module._load;
Module._load = function instrumentedLoad(request, parent, isMain) {
  const exports = load.call(this, request, parent, isMain);
  patchExports(exports);
  return exports;
};

module.exports = {};
