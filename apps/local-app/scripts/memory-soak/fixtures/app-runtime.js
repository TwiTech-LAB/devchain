#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const runtimeToken = process.env.RUNTIME_TOKEN;
const portFile = process.env.RUNTIME_PORT_FILE;
const dbPath = path.join(process.env.DB_PATH, process.env.DB_FILENAME || 'devchain.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const database = new Database(dbPath);
database.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    tmux_session_id TEXT,
    status TEXT NOT NULL,
    provider_name_at_launch TEXT,
    started_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
database.close();

const server = http.createServer((request, response) => {
  if (request.url === '/api/runtime') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ runtimeToken }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: 'ok' }));
});
const io = new Server(server, { transports: ['websocket'] });

io.use((socket, next) => {
  if (socket.handshake.auth.runtimeToken === runtimeToken) next();
  else next(new Error('invalid runtime token'));
});
io.on('connection', (socket) => {
  socket.on('terminal:subscribe', ({ sessionId }) => {
    const seed = sessionId.split('-').at(-1);
    socket.emit('message', {
      topic: `terminal/${sessionId}`,
      type: 'subscribed',
      payload: { sessionId },
      ts: new Date().toISOString(),
    });
    socket.emit('message', {
      topic: `terminal/${sessionId}`,
      type: 'seed_ansi',
      payload: { data: `seed=${seed}`, chunk: 0, totalChunks: 1 },
      ts: new Date().toISOString(),
    });
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(portFile, JSON.stringify({ port: address.port, runtimeToken }));
});

function shutdown() {
  io.close(() => server.close(() => process.exit(0)));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
