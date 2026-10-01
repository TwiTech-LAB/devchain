#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { Transform } from 'node:stream';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const [mode, arg, image, expectedArg, calibrationPath] = process.argv.slice(2);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === 'serve') {
  // Bind only to loopback; use an SSH tunnel for the remote proof.
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !['/images/load', '/probe'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/probe') {
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
      });
      req.on('end', () => res.end(JSON.stringify({ bytes })));
      return;
    }
    const upstream = request(
      {
        socketPath: '/var/run/docker.sock',
        path: '/images/load?quiet=1',
        method: 'POST',
        headers: { 'content-type': 'application/x-tar' },
      },
      (reply) => {
        res.writeHead(reply.statusCode, { 'content-type': 'application/json' });
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.listen(Number(arg ?? 0), '127.0.0.1', () => out({ port: server.address().port }));
} else if (mode === 'copy') {
  if (!arg || !image || !Number.isFinite(Number(expectedArg)))
    throw new Error('copy URL IMAGE EXPECTED_BYTES');
  const expected = Number(expectedArg);
  const calibration = calibrationPath
    ? readFileSync(calibrationPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((row) => row.case === 'stream-result')
    : null;
  const started = performance.now();
  const probe = await fetch(`${arg}/probe`, {
    method: 'POST',
    body: Buffer.alloc(16 * 1024 * 1024),
    duplex: 'half',
  });
  if (!probe.ok) throw new Error('probe failed');
  const measured = await probe.json();
  const probeMs = performance.now() - started;
  out({ case: '16MiB-probe', bytes: measured.bytes, ms: probeMs });
  const exportStart = performance.now();
  const baseline = spawn('sudo', ['-n', 'docker', 'save', image], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let exportBytes = 0;
  baseline.stdout.on('data', (chunk) => {
    exportBytes += chunk.length;
  });
  const exportCode = await new Promise((resolve) => baseline.on('exit', resolve));
  if (exportCode !== 0) throw new Error('baseline export failed');
  const exportMs = performance.now() - exportStart;
  const initialTransferMs = (exportBytes / measured.bytes) * probeMs;
  const pipelineEstimate = calibration
    ? Math.max(exportMs, calibration.exportAndTransferMs * 0.8 + initialTransferMs * 0.2)
    : Math.max(exportMs, initialTransferMs);
  const loadTail = calibration?.loadResponseTailMs ?? 0;
  out({
    case: 'export-baseline',
    bytes: exportBytes,
    ms: exportMs,
    initialRangeSeconds: [
      calibration ? (pipelineEstimate * 0.75 + loadTail * 0.75) / 1000 : pipelineEstimate / 1000,
      calibration
        ? (pipelineEstimate * 1.5 + loadTail * 1.5) / 1000
        : ((exportMs + initialTransferMs) * 3) / 1000,
    ],
    loadEstimateKnown: Boolean(calibration),
  });
  const copyStart = performance.now();
  const child = spawn('sudo', ['-n', 'docker', 'save', image], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let bytes = 0;
  let producerEnd = null;
  let lastReport = copyStart;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      const now = performance.now();
      if (now - lastReport > 5000) {
        const elapsed = now - copyStart;
        const remaining = Math.max(0, exportBytes - bytes) / (bytes / elapsed);
        out({
          case: 'live-correction',
          bytes,
          elapsedSeconds: elapsed / 1000,
          remainingTransferRangeSeconds: [remaining / 1000, (remaining * 2) / 1000],
          remainingTotalRangeSeconds: calibration
            ? [
                (remaining * 0.75 + loadTail * 0.75) / 1000,
                (remaining * 1.5 + loadTail * 1.5) / 1000,
              ]
            : null,
          loadTailKnown: Boolean(calibration),
        });
        lastReport = now;
      }
      callback(null, chunk);
    },
  });
  counter.on('end', () => {
    producerEnd = performance.now();
  });
  child.stdout.pipe(counter);
  try {
    const response = await fetch(`${arg}/images/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-tar' },
      body: counter,
      duplex: 'half',
    });
    const text = await response.text();
    if (
      !response.ok ||
      text
        .split('\n')
        .filter(Boolean)
        .some((line) => JSON.parse(line).error)
    )
      throw new Error('image load failed');
    if ((await exited) !== 0) throw new Error('export failed');
    if (bytes !== exportBytes || bytes < expected)
      throw new Error('stream did not meet required byte count');
    const end = performance.now();
    out({
      case: 'stream-result',
      bytes,
      greaterThan4GiB: bytes > 4 * 1024 ** 3,
      exportBaselineMs: exportMs,
      exportAndTransferMs: producerEnd - copyStart,
      loadResponseTailMs: end - producerEnd,
      totalMs: end - copyStart,
      temporaryArchiveFiles: 0,
    });
  } finally {
    child.kill();
    counter.destroy();
  }
} else {
  throw new Error('Use serve [PORT] or copy URL IMAGE EXPECTED_BYTES');
}
