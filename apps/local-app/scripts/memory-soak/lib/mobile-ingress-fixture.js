'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULT_TIMEOUT_MS = 10_000;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

class MobileIngressFixture {
  constructor({ sessionId, projectId }) {
    this.sessionId = sessionId;
    this.projectId = projectId;
    this.userId = crypto.randomUUID();
    this.instanceId = crypto.randomUUID();
    this.keyId = crypto.randomUUID();
    this.scope = sessionId
      ? `memory-soak:viewport:${sessionId}`
      : `memory-soak:viewport-project:${projectId}`;
    this.expiresAt = Math.floor(Date.now() / 1_000) + 5 * 60;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    this.privateKey = privateKey;
    this.publicJwk = {
      ...publicKey.export({ format: 'jwk' }),
      alg: 'RS256',
      kid: this.keyId,
      use: 'sig',
    };
    this.accessToken = this.createAccessToken();
    this.refreshToken = crypto.randomBytes(32).toString('base64url');
    this.server = null;
    this.webSocketServer = null;
    this.socket = null;
    this.baseUrl = null;
    this.challenge = null;
    this.readyCount = 0;
    this.viewportFrames = [];
    this.pendingRpc = new Map();
    this.rpcSequence = 0;
    this.waiters = new Set();
    this.evidence = {
      bearerAccepted: false,
      attestObserved: false,
      attestVerified: false,
      readyIssued: false,
      rpcRequests: 0,
      rpcResponses: 0,
    };
  }

  createAccessToken() {
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: this.keyId, typ: 'JWT' }));
    const payload = base64Url(
      JSON.stringify({
        sub: this.userId,
        exp: this.expiresAt,
        iat: Math.floor(Date.now() / 1_000),
        scope: this.scope,
        scratchSessionId: this.sessionId,
        scratchProjectId: this.projectId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  async start() {
    if (this.server) return this.baseUrl;
    this.server = http.createServer((request, response) => {
      if (request.url === '/.well-known/jwks.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ keys: [this.publicJwk] }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    this.webSocketServer = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (request, socket, head) => {
      const authorized =
        request.url === '/v1/tunnel' &&
        request.headers.authorization === `Bearer ${this.accessToken}`;
      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.evidence.bearerAccepted = true;
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit('connection', webSocket, request);
      });
    });
    this.webSocketServer.on('connection', (socket) => this.handleConnection(socket));
    this.server.listen(0, '127.0.0.1');
    await waitForListening(this.server);
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this.baseUrl;
  }

  handleConnection(socket) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close();
    this.socket = socket;
    this.challenge = {
      nonce: crypto.randomBytes(32).toString('hex'),
      ts: new Date().toISOString(),
    };
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    socket.send(JSON.stringify({ type: 'challenge', ...this.challenge }));
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.type === 'attest') {
      this.evidence.attestObserved = true;
      const signed = `${this.challenge.nonce}${message.instanceId ?? ''}${this.challenge.ts}`;
      try {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(message.publicKey, 'base64'),
          format: 'der',
          type: 'spki',
        });
        this.evidence.attestVerified = crypto.verify(
          null,
          Buffer.from(signed),
          publicKey,
          Buffer.from(message.signature, 'base64'),
        );
      } catch {
        this.evidence.attestVerified = false;
      }
      if (!this.evidence.attestVerified) {
        this.socket?.close(4001, 'invalid attestation');
        this.notifyWaiters();
        return;
      }
      this.readyCount += 1;
      this.evidence.readyIssued = true;
      this.socket?.send(JSON.stringify({ type: 'ready', instanceId: this.instanceId }));
      this.notifyWaiters();
      return;
    }
    if (message.type === 'viewport') {
      this.viewportFrames.push({ ...message, receivedAt: new Date().toISOString() });
      this.notifyWaiters();
      return;
    }
    if (message.jsonrpc === '2.0' && typeof message.id === 'string') {
      const pending = this.pendingRpc.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRpc.delete(message.id);
      this.evidence.rpcResponses += 1;
      pending.resolve(message);
      this.notifyWaiters();
    }
  }

  async waitForReady(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ready = await this.waitFor(
      () => this.evidence.attestVerified && this.readyCount > 0,
      timeoutMs,
    );
    if (!ready) throw new Error('Disposable mobile ingress did not complete tunnel authentication');
  }

  async sendRpc(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Disposable mobile ingress tunnel is not connected');
    }
    const id = `mobile-soak-${++this.rpcSequence}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Disposable mobile RPC timed out: ${method}`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve, reject, timer });
    });
    this.evidence.rpcRequests += 1;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return response;
  }

  waitFor(predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const waiter = () => {
        if (predicate()) {
          this.waiters.delete(waiter);
          resolve(true);
        } else if (Date.now() >= deadline) {
          this.waiters.delete(waiter);
          resolve(false);
        }
      };
      this.waiters.add(waiter);
      const timer = setInterval(() => {
        waiter();
        if (!this.waiters.has(waiter)) clearInterval(timer);
      }, 25);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  notifyWaiters() {
    for (const waiter of [...this.waiters]) waiter();
  }

  credentialEvidence() {
    return {
      transport: 'loopback-jwt-plus-ed25519-attestation',
      subject: this.userId,
      scope: this.scope,
      scratchSessionId: this.sessionId,
      scratchProjectId: this.projectId,
      keyId: this.keyId,
      expiresAt: new Date(this.expiresAt * 1_000).toISOString(),
      ...this.evidence,
    };
  }

  async stop() {
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disposable mobile ingress stopped'));
    }
    this.pendingRpc.clear();
    for (const client of this.webSocketServer?.clients ?? []) client.terminate();
    this.webSocketServer?.close();
    await closeServer(this.server);
    this.socket = null;
    this.server = null;
  }
}

module.exports = { MobileIngressFixture };
