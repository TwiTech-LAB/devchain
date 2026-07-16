#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('memory-soak-provider 1.0.0\n');
  process.exit(0);
}
if (args[0] === 'mcp') {
  if (args[1] === 'list') {
    process.stdout.write('devchain: http://127.0.0.1:0/mcp (HTTP) - ✓ Connected\n');
  }
  process.exit(0);
}

const child = spawn(
  process.execPath,
  [
    '--expose-gc',
    path.join(__dirname, '..', 'output-generator.js'),
    '--seed',
    process.env.MEMORY_SOAK_SEED,
    '--foreground-rate',
    process.env.MEMORY_SOAK_FOREGROUND_RATE,
    '--background-rate',
    process.env.MEMORY_SOAK_BACKGROUND_RATE,
    '--chunk-bytes',
    process.env.MEMORY_SOAK_CHUNK_BYTES,
    '--metrics',
    process.env.MEMORY_SOAK_METRICS_FILE,
  ],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
