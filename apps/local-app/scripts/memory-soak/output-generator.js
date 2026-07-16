#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed);
const foregroundRate = Number(args['foreground-rate']);
const backgroundRate = Number(args['background-rate']);
const chunkBytes = Number(args['chunk-bytes']);
const metricsPath = args.metrics;

if (![seed, foregroundRate, backgroundRate, chunkBytes].every(Number.isFinite) || !metricsPath) {
  throw new Error('seed, foreground-rate, background-rate, chunk-bytes, and metrics are required');
}

const random = createRandom(seed);
const glyphs = ['λ', '界', '🧠', 'é', 'Ж', 'Δ'];
let mode = 'foreground';
let outputBytes = 0;
let bursts = 0;
let chunks = 0;
let churnCycles = 0;
let forcedGcCount = 0;
let latencyMarkerCount = 0;
let lastLatencyMarkerAtMs = null;
let retained = [];
let stopped = false;
let outputPaused = false;
let pauseMarkerCount = 0;
let pauseMarkerFlushedCount = 0;
let lastPauseMarker = null;
let historyFillLineCount = 0;
let historyFillFlushedCount = 0;
let lastHistoryFillMarker = null;

function writeMetrics() {
  const metrics = {
    seed,
    pid: process.pid,
    mode,
    outputBytes,
    bursts,
    chunks,
    churnCycles,
    forcedGcCount,
    latencyMarkerCount,
    lastLatencyMarkerAtMs,
    outputPaused,
    pauseMarkerCount,
    pauseMarkerFlushedCount,
    lastPauseMarker,
    historyFillLineCount,
    historyFillFlushedCount,
    lastHistoryFillMarker,
    capturedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics)}\n`, 'utf8');
}

function churn() {
  mode = 'foreground';
  churnCycles += 1;
  retained = Array.from({ length: 8 }, (_, index) =>
    Buffer.alloc(1024 * 1024, (seed + index) & 0xff),
  );
  if (typeof global.gc === 'function') {
    global.gc();
    forcedGcCount += 1;
  }
  writeMetrics();
}

function makeChunk() {
  const color = 31 + (random() % 6);
  const glyph = glyphs[random() % glyphs.length];
  const prefix = `\u001b[${color}m${glyph}\u001b[0m seed=${seed} n=${chunks} `;
  const suffix = '\r\n';
  const fillLength = Math.max(
    0,
    chunkBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
  );
  return `${prefix}${'x'.repeat(fillLength)}${suffix}`;
}

function scheduleBurst() {
  if (stopped) return;
  if (outputPaused) {
    setTimeout(scheduleBurst, 10);
    return;
  }
  const rate = mode === 'background' ? backgroundRate : foregroundRate;
  const burstWidth = mode === 'background' ? 1 : 4;
  for (let index = 0; index < burstWidth; index += 1) {
    const chunk = makeChunk();
    process.stdout.write(chunk);
    outputBytes += Buffer.byteLength(chunk);
    chunks += 1;
  }
  bursts += 1;
  writeMetrics();
  setTimeout(scheduleBurst, Math.max(1, Math.round(1000 / rate)));
}

process.on('SIGUSR1', () => {
  mode = 'background';
  writeMetrics();
});
process.on('SIGUSR2', churn);
process.on('SIGTTIN', () => {
  outputPaused = true;
  pauseMarkerCount += 1;
  lastPauseMarker = `pause=${seed}-${pauseMarkerCount}`;
  const marker = `\r\n${lastPauseMarker}\r\n`;
  outputBytes += Buffer.byteLength(marker);
  process.stdout.write(marker, () => {
    pauseMarkerFlushedCount = pauseMarkerCount;
    writeMetrics();
  });
});
process.on('SIGTTOU', () => {
  outputPaused = false;
  writeMetrics();
});
process.on('SIGXFSZ', () => {
  historyFillLineCount += 1;
  lastHistoryFillMarker = `history-fill=${seed}-${historyFillLineCount}`;
  const marker = `${lastHistoryFillMarker}\r\n`;
  outputBytes += Buffer.byteLength(marker);
  process.stdout.write(marker, () => {
    historyFillFlushedCount = historyFillLineCount;
    writeMetrics();
  });
});
process.on('SIGURG', () => {
  lastLatencyMarkerAtMs = Date.now();
  const marker = `latency=${lastLatencyMarkerAtMs}\r\n`;
  process.stdout.write(marker);
  outputBytes += Buffer.byteLength(marker);
  chunks += 1;
  latencyMarkerCount += 1;
  writeMetrics();
});
process.on('SIGTERM', () => {
  stopped = true;
  writeMetrics();
  process.exit(0);
});

writeMetrics();
scheduleBurst();
setInterval(writeMetrics, 1_000);
