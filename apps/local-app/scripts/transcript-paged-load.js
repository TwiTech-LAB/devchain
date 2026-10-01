#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { treeDigest } = require('./transcript-load');
const sha = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs(args) {
  const config = { fileMiB: 55, textKiB: 256, rounds: 3 };
  for (let i = 0; i < args.length; i += 2) {
    const key = {
      '--report': 'report',
      '--file-mib': 'fileMiB',
      '--text-kib': 'textKiB',
      '--rounds': 'rounds',
      '--baseline-ref': 'baselineRef',
    }[args[i]];
    assert(
      key && args[i + 1],
      'Expected --report, --file-mib, --text-kib, --rounds, or --baseline-ref',
    );
    config[key] = ['report', 'baselineRef'].includes(key) ? args[i + 1] : Number(args[i + 1]);
  }
  assert(config.report && !fs.existsSync(config.report), 'A new --report path is required');
  assert(Number.isInteger(config.fileMiB) && config.fileMiB >= 50 && config.fileMiB <= 100);
  assert(Number.isInteger(config.textKiB) && config.textKiB >= 1 && config.textKiB <= 1024);
  assert(Number.isInteger(config.rounds) && config.rounds >= 1 && config.rounds <= 10);
  return config;
}

function makeTurn(index, textKiB) {
  return (
    ['user', 'assistant']
      .map((role) =>
        JSON.stringify({
          type: role,
          uuid: `${role}-${index}`,
          parentUuid: role === 'assistant' ? `user-${index}` : null,
          timestamp: '2026-09-18T12:00:00.000Z',
          isSidechain: false,
          message: {
            role,
            model: 'claude-sonnet-4-6',
            content: [
              {
                type: 'text',
                text:
                  role === 'user'
                    ? `Question ${index}`
                    : `Answer ${index}: ` +
                      'synthetic text\n'.repeat(Math.ceil((textKiB * 1024) / 15)),
              },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 120, output_tokens: 60 },
          },
        }),
      )
      .join('\n') + '\n'
  );
}

// Load historical versions of changed files at their normal module paths. Dependencies still
// come from the same production build, avoiding a second server or changes to the shared checkout.
function installBaseline(ref) {
  if (!ref) return () => {};
  const Module = require('node:module');
  const ts = require(path.join(ROOT, 'node_modules/typescript'));
  const original = Module._extensions['.js'];
  const overrides = new Map();
  for (const relative of [
    'builders/chunk-builder',
    'builders/semantic-step-extractor',
    'builders/turn-builder',
    'services/session-reader.service',
    'services/transcript-serialization',
    'controllers/session-reader.controller',
  ]) {
    const sourcePath = `apps/local-app/src/modules/session-reader/${relative}.ts`;
    const source = execFileSync('git', ['show', `${ref}:${sourcePath}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    overrides.set(
      path.join(APP, `dist/modules/session-reader/${relative}.js`),
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2021,
          module: ts.ModuleKind.CommonJS,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      }).outputText,
    );
  }
  Module._extensions['.js'] = (module, filename) =>
    overrides.has(filename)
      ? module._compile(overrides.get(filename), filename)
      : original(module, filename);
  return () => {
    Module._extensions['.js'] = original;
  };
}

async function main(config) {
  process.env.NODE_ENV = 'test';
  process.env.TRANSCRIPT_CACHE_MAX_BYTES = String(64 * 1024 * 1024);
  const restoreLoader = installBaseline(config.baselineRef);
  const { Module, Logger } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { FastifyAdapter } = require('@nestjs/platform-fastify');
  Logger.overrideLogger(false);
  const req = (file) => require(path.join(APP, 'dist/modules/session-reader', file));
  const { SessionCacheService } = req('services/session-cache.service');
  const { SessionReaderService } = req('services/session-reader.service');
  const { SessionReaderController } = req('controllers/session-reader.controller');
  const { ClaudeSessionReaderAdapter } = req('adapters/claude-session-reader.adapter');
  const { SessionReaderAdapterFactory } = req('adapters/session-reader-adapter.factory');
  const { PricingService } = req('services/pricing.service');
  const { encodeCursor, decodeCursor } = req('services/transcript-cursor');
  const { MetricsService } = require(
    path.join(APP, 'dist/modules/metrics/services/metrics.service'),
  );
  restoreLoader();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-paged-load-'));
  const id = '00000000-0000-4000-8000-000000000001';
  const file = path.join(directory, `${id}.jsonl`);
  const fd = fs.openSync(file, 'wx');
  let bytes = 0,
    turns = 0;
  try {
    while (bytes < config.fileMiB * 1024 * 1024) {
      const turn = makeTurn(turns++, config.textKiB);
      fs.writeSync(fd, turn);
      bytes += Buffer.byteLength(turn);
    }
  } finally {
    fs.closeSync(fd);
  }
  const pricing = new PricingService();
  const adapter = new ClaudeSessionReaderAdapter(pricing);
  const factory = new SessionReaderAdapterFactory();
  factory.registerAdapter(adapter);
  const metrics = new MetricsService();
  const cache = new SessionCacheService(metrics);
  const reader = new SessionReaderService(
    factory,
    {
      validateForRead: async (p) => {
        assert.equal(p, file);
        return p;
      },
    },
    cache,
    {
      getSession: () => ({
        id,
        providerNameAtLaunch: 'claude',
        transcriptPath: file,
        status: 'running',
      }),
    },
    undefined,
    pricing,
  );
  const stages = [];
  function observe(target, name) {
    if (!target[name]) return;
    const original = target[name].bind(target);
    target[name] = function (...args) {
      const started = performance.now();
      const done = (value) => {
        stages.push({ name, durationMs: performance.now() - started });
        return value;
      };
      const result = original(...args);
      return result?.then ? result.then(done) : done(result);
    };
  }
  observe(adapter, 'parseFullSession');
  for (const name of ['projectIndexPages', 'projectChunkPage']) observe(reader, name);
  for (const name of ['buildChunks', 'buildChunksCooperatively'])
    observe(req('builders/chunk-builder'), name);
  observe(req('services/transcript-serialization'), 'serializeChunksCooperatively');
  if (!config.baselineRef) {
    const encoder = req('services/transcript-json-stream');
    const original = encoder.transcriptJsonStream;
    encoder.transcriptJsonStream = (body) => {
      const started = performance.now();
      const stream = original(body);
      stream.once('end', () =>
        stages.push({ name: 'encodeAndStreamResponse', durationMs: performance.now() - started }),
      );
      return stream;
    };
  }
  class ProbeModule {}
  Module({
    controllers: [SessionReaderController],
    providers: [
      { provide: SessionReaderService, useValue: reader },
      { provide: SessionCacheService, useValue: cache },
      { provide: MetricsService, useValue: metrics },
    ],
  })(ProbeModule);
  const app = await NestFactory.create(ProbeModule, new FastifyAdapter(), { logger: false });
  const report = {
    config,
    fixture: { bytes, turns, messages: turns * 2 },
    provenance: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      sourceDiffSha256: sha(
        execFileSync('git', ['diff', 'HEAD', '--', 'apps/local-app/src/modules/session-reader'], {
          cwd: ROOT,
        }),
      ),
      harnessSha256: sha(fs.readFileSync(__filename)),
      sourceSha256: treeDigest(path.join(APP, 'src/modules/session-reader')).sha256,
      productionDistSha256: treeDigest(path.join(APP, 'dist/modules/session-reader')).sha256,
      baselineRef: config.baselineRef ?? null,
    },
    operations: [],
  };
  try {
    const serializationStarts = new WeakMap();
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('preSerialization', (request, _reply, payload, done) => {
        serializationStarts.set(request, performance.now());
        done(null, payload);
      });
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onSend', (request, _reply, payload, done) => {
        const start = serializationStarts.get(request);
        if (start !== undefined)
          stages.push({ name: 'nativeJsonEncoding', durationMs: performance.now() - start });
        done(null, payload);
      });
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const controller = app.get(SessionReaderController);
    const index = await controller.getTranscriptIndex(id);
    assert.equal(index.totals.messageCount, turns * 2);
    const oldCursor = encodeCursor(decodeCursor(index.cursor).fileSize, 0, 0);
    const requests = [
      ['index', '?pageSize=40&firstVirtualIndex=0&lastVirtualIndex=39&live=true'],
      ['chunks', '?limit=100'],
      ['tail', `?since=${index.cursor}`],
      ['tail', `?since=${oldCursor}`],
    ];
    for (let round = 0; round < config.rounds; round++) {
      for (const [route, query] of requests) {
        global.gc?.();
        await sleep(20);
        stages.length = 0;
        const loop = monitorEventLoopDelay({ resolution: 1 });
        loop.enable();
        await sleep(10);
        loop.reset();
        const began = performance.now();
        const received = await new Promise((resolve, reject) => {
          http
            .get(
              { host: '127.0.0.1', port, path: `/api/sessions/${id}/transcript/${route}${query}` },
              (response) => {
                const digest = createHash('sha256');
                let bodyBytes = 0;
                response.on('data', (chunk) => {
                  digest.update(chunk);
                  bodyBytes += chunk.length;
                });
                response.on('error', reject);
                response.on('end', () =>
                  resolve({ status: response.statusCode, bodyBytes, sha256: digest.digest('hex') }),
                );
              },
            )
            .on('error', reject);
        });
        const durationMs = performance.now() - began;
        await sleep(5);
        const maxEventLoopDelayMs = loop.max / 1e6;
        loop.disable();
        assert.equal(received.status, 200);
        assert.equal(
          cache.getCacheStats().entries,
          0,
          'Over-budget parse must not remain resident',
        );
        const operation = {
          round,
          route,
          query,
          durationMs,
          maxEventLoopDelayMs,
          ...received,
          stages: [...stages],
          cache: cache.getCacheStats(),
          rssBytes: process.memoryUsage().rss,
        };
        // Outside the measured interval, assert exact wire parity with the controller DTO.
        const expected =
          route === 'index'
            ? await controller.getTranscriptIndex(id, '40', '0', '39', 'true')
            : route === 'chunks'
              ? await controller.getTranscriptChunks(id, undefined, '100')
              : await controller.getTranscriptTail(id, query.slice('?since='.length));
        operation.wireMatchesControllerJson = received.sha256 === sha(JSON.stringify(expected));
        assert(operation.wireMatchesControllerJson, 'Streamed body changed the JSON contract');
        report.operations.push(operation);
      }
    }
    report.passed = report.operations.every((operation) => operation.maxEventLoopDelayMs <= 100);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
    report.fixturesRemoved = !fs.existsSync(directory);
    fs.mkdirSync(path.dirname(path.resolve(config.report)), { recursive: true });
    fs.writeFileSync(config.report, JSON.stringify(report, null, 2), { flag: 'wx' });
  }
  console.log(
    JSON.stringify({
      report: config.report,
      passed: report.passed,
      maxEventLoopDelayMs: Math.max(...report.operations.map((x) => x.maxEventLoopDelayMs)),
    }),
  );
  if (!config.baselineRef && !report.passed) process.exitCode = 1;
}

if (require.main === module)
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { parseArgs, makeTurn };
