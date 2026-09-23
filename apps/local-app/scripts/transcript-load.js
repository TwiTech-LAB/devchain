#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { fork, execFileSync } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
    : null;
};

function parseArgs(args) {
  const config = {
    fileMiB: 65,
    sessions: 1,
    baselineSec: 15,
    appendSec: 30,
    recoverySec: 20,
    appendIntervalMs: 150,
    summaryIntervalMs: 5000,
    indexIntervalMs: 5000,
    pageSize: 10,
    sampleIntervalMs: 500,
    drainMs: 5000,
    wallClockSec: 120,
    budgetBytes: 64 * 1024 * 1024,
  };
  const explicit = new Set();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--help') return { help: true };
    const name = {
      '--file-mib': 'fileMiB',
      '--sessions': 'sessions',
      '--report': 'report',
      '--baseline-sec': 'baselineSec',
      '--append-sec': 'appendSec',
      '--recovery-sec': 'recoverySec',
      '--profile': 'profile',
    }[args[i]];
    if (!name || args[i + 1] === undefined)
      throw new Error(`Unknown or incomplete option: ${args[i]}`);
    explicit.add(name);
    config[name] =
      name === 'report'
        ? path.resolve(args[++i])
        : name === 'profile'
          ? args[++i]
          : Number(args[++i]);
  }
  // Profiles preset a scenario; explicit flags still override their defaults.
  if (config.profile !== undefined) {
    assert(config.profile === 'many-unviewed', `Unknown profile: ${config.profile}`);
    // Many appending Claude+Codex sessions, exactly ONE viewed by the canonical client and the
    // rest served by the metrics-only lane. This is the case the lane targets: the lane keeps
    // unviewed watchers at zero cache entries and O(new-bytes) parse work.
    if (!explicit.has('sessions')) config.sessions = 20;
    if (!explicit.has('fileMiB')) config.fileMiB = 5;
    config.formats = ['codex', 'claude'];
    config.viewedOnly = true;
  } else {
    config.formats = ['codex'];
    config.viewedOnly = false;
  }
  for (const key of ['fileMiB', 'sessions', 'baselineSec', 'appendSec', 'recoverySec']) {
    assert(
      Number.isSafeInteger(config[key]) && config[key] > 0,
      `${key} must be a positive integer`,
    );
  }
  if (config.profile === 'many-unviewed') {
    assert(config.sessions <= 40, 'many-unviewed: at most 40 isolated sessions');
    assert(config.fileMiB <= 50, 'many-unviewed: at most 50 MiB per fixture');
    // The whole point of the lane is bounded memory, but the single viewed session still parses
    // and the BEFORE run retains bodies for every appending watcher, so keep generous headroom.
    config.childHeapMiB = 2048;
    config.rssCutoffMiB = 3072;
    config.wallClockSec = 240;
  } else {
    assert(config.sessions <= 4, 'At most four isolated sessions');
    assert(config.fileMiB <= 200, 'At most 200 MiB per fixture');
    config.childHeapMiB = config.sessions > 1 ? 1536 : 768;
    config.rssCutoffMiB = config.sessions > 1 ? 2048 : 1100;
  }
  assert(config.report, '--report is required');
  config.acceptanceProfile =
    config.profile === undefined &&
    [65, 200].includes(config.fileMiB) &&
    (config.sessions === 1 || (config.sessions === 4 && config.fileMiB === 65)) &&
    config.baselineSec >= 15 &&
    config.appendSec === 30 &&
    config.recoverySec === 20;
  return config;
}

function treeDigest(directory) {
  const entries = [];
  function visit(dir) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else entries.push([path.relative(directory, full), hash(fs.readFileSync(full))]);
    }
  }
  visit(directory);
  return { files: entries.length, sha256: hash(JSON.stringify(entries)) };
}

function provenance() {
  const git = (...args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return {
    gitHead: git('rev-parse', 'HEAD').trim(),
    gitStatus: git('status', '--short').trim().split('\n').filter(Boolean),
    trackedDiffSha256: hash(git('diff', 'HEAD', '--', 'apps/local-app/src')),
    source: treeDigest(path.join(APP, 'src/modules/session-reader')),
    productionDist: treeDigest(path.join(APP, 'dist')),
    harnessSha256: hash(fs.readFileSync(__filename)),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    host: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryMiB: os.totalmem() / 1024 / 1024,
      availableMemory: fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:.*$/m)?.[0],
    },
  };
}

const line = (type, payload) =>
  JSON.stringify({ timestamp: '2026-09-18T12:00:00.000Z', type, payload }) + '\n';
function makeTurn(i) {
  return [
    line('event_msg', { type: 'task_started', turn_id: `turn_${i}` }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `Inspect synthetic module ${i}` }],
    }),
    line('response_item', {
      type: 'function_call',
      call_id: `call_${i}`,
      name: 'read_file',
      arguments: JSON.stringify({ path: `synthetic/module-${i}.ts` }),
    }),
    line('response_item', {
      type: 'function_call_output',
      call_id: `call_${i}`,
      output: 'const syntheticValue = 123; // example source data\n'.repeat(320),
    }),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: `Inspected synthetic module ${i}` }],
    }),
    line('event_msg', { type: 'task_complete', turn_id: `turn_${i}` }),
  ].join('');
}

// A Claude turn: one user message + one assistant message (end_turn), so message accounting is
// turns*2, identical to a Codex turn. The large assistant text keeps per-turn bytes comparable.
const CLAUDE_TS = '2026-09-18T12:00:00.000Z';
function makeClaudeTurn(i) {
  const user = `u_${i}`;
  const assistant = `a_${i}`;
  return (
    [
      JSON.stringify({
        type: 'user',
        uuid: user,
        parentUuid: i === 0 ? null : `a_${i - 1}`,
        isSidechain: false,
        timestamp: CLAUDE_TS,
        message: { role: 'user', content: `Inspect synthetic module ${i}` },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: assistant,
        parentUuid: user,
        isSidechain: false,
        timestamp: CLAUDE_TS,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            {
              type: 'text',
              text:
                `Inspected synthetic module ${i}\n` +
                'const syntheticValue = 123; // example source data\n'.repeat(300),
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 120,
            output_tokens: 60,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    ].join('\n') + '\n'
  );
}

// fixtures[0] is the single VIEWED session; the canonical client is proven against Codex, so keep
// it Codex. Remaining sessions alternate formats so both Claude and Codex run in the lane unviewed.
function providerForIndex(config, index) {
  return config.formats[index % config.formats.length];
}

function createFixtures(directory, config) {
  return Array.from({ length: config.sessions }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const provider = providerForIndex(config, index);
    const makeTurnFor = provider === 'claude' ? makeClaudeTurn : makeTurn;
    const file = path.join(directory, `${id}.jsonl`);
    const fd = fs.openSync(file, 'wx');
    let bytes = 0;
    let turns = 0;
    try {
      if (provider === 'codex') {
        bytes = fs.writeSync(
          fd,
          line('session_meta', { id }) +
            line('turn_context', { model: 'o3', context_window: 200000 }),
        );
      }
      while (bytes < config.fileMiB * 1024 * 1024) bytes += fs.writeSync(fd, makeTurnFor(turns++));
    } finally {
      fs.closeSync(fd);
    }
    return { id, provider, file, initialBytes: bytes, initialTurns: turns, turns, appends: 0 };
  });
}

function transcriptReaders(pid, files) {
  let count = 0;
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      if (files.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) count += 1;
    } catch {
      /* Descriptor closed between reads. */
    }
  }
  return count;
}

function validateCanonical(index, pageSize = 10) {
  assert(
    index && Array.isArray(index.chunkIds) && Array.isArray(index.pages),
    'Missing combined index/pages',
  );
  const cursor = Buffer.from(index.cursor, 'base64url').toString().split(':').map(Number);
  assert.equal(cursor.length, 3);
  assert(cursor.every(Number.isSafeInteger));
  assert.equal(cursor[1], index.totals.messageCount);
  assert.equal(cursor[2], index.chunkIds.length);
  assert.equal(index.totals.chunkCount, index.chunkIds.length);
  const covered = new Set();
  let bodies = 0;
  for (const page of index.pages) {
    const start = index.chunkIds.indexOf(page.cursor);
    assert(start >= 0 && start % pageSize === 0, 'Unaligned or unknown page cursor');
    assert.equal(page.response.totalCount, index.chunkIds.length);
    assert.equal(page.response.chunks.length, page.size);
    assert.deepEqual(
      page.response.chunks.map((chunk) => chunk.id),
      index.chunkIds.slice(start, start + page.size),
    );
    assert.equal(page.response.nextCursor, index.chunkIds[start + page.size] ?? null);
    assert.equal(page.response.prevCursor, start ? index.chunkIds[start - 1] : null);
    for (const chunk of page.response.chunks) {
      assert(!covered.has(chunk.id), 'Duplicate chunk body');
      covered.add(chunk.id);
    }
    bodies += page.size;
  }
  assert(bodies <= 200, 'Unbounded combined response');
  const required = [...index.chunkIds.slice(0, pageSize * 3), ...index.chunkIds.slice(-pageSize)];
  assert(
    required.every((id) => covered.has(id)),
    'Missing initial window padding or live tail',
  );
  return {
    messageCount: index.totals.messageCount,
    chunks: index.chunkIds.length,
    bodies,
    cursor: index.cursor,
  };
}

async function worker({ config, fixtures }) {
  require(path.join(APP, 'node_modules/@nestjs/common')).Logger.overrideLogger(false);
  // Count every byte the process runs through SHA-256, before requiring the services that hash.
  // The append proof is what changed between BEFORE (whole-file digests) and AFTER (bounded
  // head/tail anchors), so this is the direct cross-version measure of "bytes hashed per append".
  const crypto = require('node:crypto');
  let hashedBytes = 0;
  const realCreateHash = crypto.createHash;
  crypto.createHash = (...createArgs) => {
    const digest = realCreateHash(...createArgs);
    const realUpdate = digest.update.bind(digest);
    digest.update = (data, ...rest) => {
      hashedBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      return realUpdate(data, ...rest);
    };
    return digest;
  };
  const req = (file) => require(path.join(APP, 'dist/modules/session-reader', file));
  const { SessionCacheService } = req('services/session-cache.service');
  const { TranscriptWatcherService } = req('services/transcript-watcher.service');
  const { SessionReaderService } = req('services/session-reader.service');
  const { SessionReaderController } = req('controllers/session-reader.controller');
  const { CodexSessionReaderAdapter } = req('adapters/codex-session-reader.adapter');
  const { ClaudeSessionReaderAdapter } = req('adapters/claude-session-reader.adapter');
  const { SessionReaderAdapterFactory } = req('adapters/session-reader-adapter.factory');
  const { PricingService } = req('services/pricing.service');
  const { MetricsService } = require(
    path.join(APP, 'dist/modules/metrics/services/metrics.service'),
  );
  const pricing = new PricingService();
  const adaptersByProvider = {
    codex: new CodexSessionReaderAdapter(pricing),
    claude: new ClaudeSessionReaderAdapter(pricing),
  };
  const factory = new SessionReaderAdapterFactory();
  for (const adapter of Object.values(adaptersByProvider)) factory.registerAdapter(adapter);
  const metrics = new MetricsService();
  const cache = new SessionCacheService(metrics);
  cache.onModuleInit();
  const byFile = new Map(fixtures.map((fixture) => [fixture.file, fixture.id]));
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const counters = Object.fromEntries(
    fixtures.map(({ id }) => [
      id,
      {
        full: 0,
        incremental: 0,
        activeParses: 0,
        peakParses: 0,
        activeHandlers: 0,
        peakHandlers: 0,
        completedHandlers: 0,
        updates: 0,
      },
    ]),
  );
  const operations = [];
  const errors = [];
  const accountingFailures = [];
  let httpActive = 0;
  const startedAt = performance.now();
  const send = (value) => process.send(value);
  function accounting() {
    const retained = [...cache.cache.values()].reduce(
      (sum, entry) => sum + entry.weights.parsed + entry.weights.chunks + entry.weights.dto,
      0,
    );
    const budget = cache.getCacheStats();
    if (retained !== budget.budgetUsedBytes || retained < 0 || retained > config.budgetBytes) {
      accountingFailures.push({ retained, reported: budget.budgetUsedBytes });
    }
    return { ...budget, retainedWeightSum: retained };
  }
  // Observers only: invoke each real method once with its original arguments/result.
  function observe(target, method, identify, kind) {
    const original = target[method].bind(target);
    target[method] = async (...args) => {
      const id = identify(args);
      const count = counters[id];
      const active = kind === 'parse' ? 'activeParses' : 'activeHandlers';
      const peak = kind === 'parse' ? 'peakParses' : 'peakHandlers';
      count[active] += 1;
      count[peak] = Math.max(count[peak], count[active]);
      if (kind === 'parse') count[method === 'parseFullSession' ? 'full' : 'incremental'] += 1;
      const began = performance.now();
      try {
        return await original(...args);
      } catch (error) {
        errors.push({ method, id, error: error.message });
        throw error;
      } finally {
        count[active] -= 1;
        if (kind === 'handler') count.completedHandlers += 1;
        operations.push({
          id,
          method,
          atMs: began - startedAt,
          durationMs: performance.now() - began,
        });
        accounting();
      }
    };
  }
  for (const adapter of Object.values(adaptersByProvider))
    for (const method of ['parseFullSession', 'parseIncremental'])
      observe(adapter, method, (args) => byFile.get(args[0]), 'parse');
  const events = {
    publish: async (name, payload) => {
      if (name === 'session.transcript.updated') {
        counters[payload.sessionId].updates += 1;
        send({ type: 'update', sessionId: payload.sessionId, kind: payload.kind });
      }
      return 'synthetic-event';
    },
  };
  const watcher = new TranscriptWatcherService(cache, factory, events);
  observe(watcher, 'runRefresh', (args) => args[0].sessionId, 'handler');
  const sessions = {
    getSession: (id) => {
      const fixture = byId.get(id);
      assert(fixture, 'Unknown synthetic session');
      return {
        id,
        providerNameAtLaunch: fixture.provider,
        transcriptPath: fixture.file,
        status: 'running',
      };
    },
  };
  const validator = {
    validateForRead: async (file) => {
      assert(byFile.has(file), 'Unexpected fixture path');
      await fs.promises.stat(file);
      return file;
    },
  };
  const reader = new SessionReaderService(factory, validator, cache, sessions, watcher, pricing);
  const controller = new SessionReaderController(reader, metrics, cache);
  controller.onModuleInit();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const server = http.createServer(async (request, response) => {
    httpActive += 1;
    try {
      const [, route, id] = request.url.split('/');
      assert(byId.has(id), 'Unknown session');
      let value;
      if (route === 'summary') value = await reader.getTranscriptSummary(id);
      else if (route === 'index') value = await controller.getTranscriptIndex(id);
      else if (route === 'canonical')
        value = await controller.getTranscriptIndex(
          id,
          String(config.pageSize),
          undefined,
          undefined,
          'true',
        );
      else throw new Error('Unknown route');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(value));
    } catch (error) {
      errors.push({ method: request.url, error: error.message });
      response.writeHead(500).end(JSON.stringify({ error: error.message }));
    } finally {
      httpActive -= 1;
      accounting();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const snapshot = () => ({
    counters,
    cache: accounting(),
    cacheEntries: cache.cache.size,
    hashedBytes,
    memory: process.memoryUsage(),
    httpActive,
    cacheFlights: cache.parseFlights.size,
    readerFlights: reader.parsedSessionFlights.size,
    queuedRefreshes: [...watcher.watchers.values()].filter(
      (state) => state.pending || state.debounceTimer,
    ).length,
    lastWatcherCounts: Object.fromEntries(
      fixtures.map(({ id }) => [id, watcher.getLastKnownMessageCount(id)]),
    ),
    loopMaxMs: loop.max / 1e6,
    loopP99Ms: loop.percentile(99) / 1e6,
  });
  const telemetry = setInterval(() => {
    send({ type: 'sample', ...snapshot() });
    loop.reset();
  }, config.sampleIntervalMs);
  for (const fixture of fixtures)
    await watcher.startWatching(fixture.id, fixture.file, fixture.provider);
  send({ type: 'ready', port: server.address().port, ...snapshot() });
  let lastWatcherCounts;
  process.on('message', async (message) => {
    try {
      if (message === 'drain') {
        while (
          httpActive ||
          [...watcher.watchers.values()].some(
            (state) => state.active || state.pending || state.debounceTimer,
          )
        )
          await sleep(10);
        lastWatcherCounts = snapshot().lastWatcherCounts;
        watcher.onModuleDestroy();
        send({ type: 'drained', lastWatcherCounts });
      } else if (message === 'finish') {
        clearInterval(telemetry);
        await reader.onModuleDestroy();
        cache.onModuleDestroy();
        await new Promise((resolve) => server.close(resolve));
        const final = snapshot();
        final.lastWatcherCounts = lastWatcherCounts;
        final.transcriptReaders = transcriptReaders(process.pid, new Set(byFile.keys()));
        final.watchers = watcher.activeWatcherCount;
        loop.disable();
        // Wait for the final IPC message to flush before disconnecting: with many sessions the
        // operations payload is large enough that an immediate disconnect drops it, leaving the
        // parent with no `final` (and a spuriously incomplete report).
        await new Promise((resolve) =>
          process.send({ type: 'final', ...final, operations, errors, accountingFailures }, resolve),
        );
        process.disconnect();
      }
    } catch (error) {
      send({ type: 'fatal', error: error.stack });
      process.exitCode = 1;
    }
  });
}

function summarize(report) {
  const phaseStats = (samples) => {
    const measured = samples.filter(
      (sample) => Number.isFinite(sample.cpuSeconds) && sample.elapsedSeconds > 0,
    );
    return {
      samples: samples.length,
      cpuMean: measured.length
        ? (100 * measured.reduce((sum, sample) => sum + sample.cpuSeconds, 0)) /
          measured.reduce((sum, sample) => sum + sample.elapsedSeconds, 0)
        : null,
      rssPeakMiB: Math.max(0, ...samples.map((sample) => sample.rssMiB)),
      rssMedianMiB: percentile(
        samples.map((sample) => sample.rssMiB),
        0.5,
      ),
      readersPeak: Math.max(0, ...samples.map((sample) => sample.transcriptReaders)),
    };
  };
  const summary = {};
  for (const phase of ['baseline', 'append', 'recovery'])
    summary[phase] = phaseStats(report.samples.filter((sample) => sample.phase === phase));
  summary.baselineTail = phaseStats(
    report.samples.filter(
      (sample) => sample.phase === 'baseline' && sample.atSec >= report.config.baselineSec - 10,
    ),
  );
  summary.recoveryTail = phaseStats(
    report.samples.filter(
      (sample) =>
        sample.phase === 'recovery' &&
        sample.atSec >= report.recoveryStartedAtSec + report.config.recoverySec - 10,
    ),
  );
  summary.recoveryCpuDelta =
    summary.recoveryTail.cpuMean === null || summary.baselineTail.cpuMean === null
      ? null
      : summary.recoveryTail.cpuMean - summary.baselineTail.cpuMean;
  summary.rssReclaimedFromAppendPeakMiB =
    summary.append.rssPeakMiB - (summary.recoveryTail.rssMedianMiB ?? summary.append.rssPeakMiB);
  summary.requests = Object.fromEntries(
    ['summary', 'index', 'canonical'].map((kind) => {
      const items = report.requests.filter((request) => request.kind === kind);
      return [
        kind,
        {
          completed: items.length,
          errors: items.filter((request) => request.error).length,
          p95Ms: percentile(
            items.map((request) => request.ms),
            0.95,
          ),
          maxMs: Math.max(0, ...items.map((request) => request.ms)),
          appendP95Ms: percentile(
            items.filter((request) => request.phase === 'append').map((request) => request.ms),
            0.95,
          ),
        },
      ];
    }),
  );
  summary.canonicalCommitsDuringAppends = report.requests.filter(
    (request) =>
      request.kind === 'canonical' && request.completedPhase === 'append' && !request.error,
  ).length;
  summary.canonicalEventToCommitP95Ms = percentile(
    report.requests
      .filter((request) => request.kind === 'canonical')
      .map((request) => request.eventToCommitMs),
    0.95,
  );
  summary.parseP95Ms = percentile(
    (report.final?.operations ?? [])
      .filter((op) => op.method.startsWith('parse'))
      .map((op) => op.durationMs),
    0.95,
  );
  // Lane-relevant totals (safe for every profile): cache entries and byte budget held, total bytes
  // hashed, and parse counts. These are the BEFORE/AFTER contrast numbers.
  const telemetry = report.telemetry ?? [];
  const appendTelemetry = telemetry.filter((sample) => sample.phase === 'append');
  const lastTelemetry = telemetry[telemetry.length - 1];
  const counters = report.final ? Object.values(report.final.counters) : [];
  summary.cacheEntriesPeak = Math.max(0, ...telemetry.map((sample) => sample.cacheEntries ?? 0));
  summary.cacheEntriesPeakAppend = Math.max(
    0,
    ...appendTelemetry.map((sample) => sample.cacheEntries ?? 0),
  );
  summary.budgetUsedPeakMiB =
    Math.max(0, ...telemetry.map((sample) => sample.cache?.budgetUsedBytes ?? 0)) / 1024 / 1024;
  summary.hashedBytesTotalMiB = (lastTelemetry?.hashedBytes ?? 0) / 1024 / 1024;
  summary.fullParses = counters.length ? counters.reduce((sum, key) => sum + key.full, 0) : null;
  summary.incrementalParses = counters.length
    ? counters.reduce((sum, key) => sum + key.incremental, 0)
    : null;
  return summary;
}

function evaluate(report) {
  const final = report.final;
  const summary = report.summary;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const perKey = final ? Object.values(final.counters) : [];
  let cpuTargetPercent = null;
  if (report.config.sessions === 1) {
    cpuTargetPercent = report.config.fileMiB === 65 ? 50 : 80;
  }
  const checks = {
    // A measurement profile is not a CPU-acceptance scenario, so the question is N/A (null), not a
    // failure; its own direction gates below decide the pass. Non-profile runs keep the strict flag,
    // so a shortened acceptance smoke still reports acceptanceProfile:false and cannot pass.
    acceptanceProfile:
      report.config.profile === 'many-unviewed' ? null : report.config.acceptanceProfile,
    completed: !report.safetyAbort && report.exit?.code === 0 && !!final,
    concurrency:
      perKey.length === report.config.sessions &&
      perKey.every((key) => key.peakParses === 1 && key.peakHandlers === 1),
    independentProgress:
      perKey.length === report.config.sessions &&
      perKey.every((key) => key.updates > 0 && key.completedHandlers > 0),
    exactMessages:
      !!final &&
      report.fixtures.every(
        (fixture) =>
          fixture.appends > 0 &&
          final.lastWatcherCounts?.[fixture.id] === fixture.expectedFinalMessages &&
          report.lastSummaryCounts[fixture.id] === fixture.expectedFinalMessages,
      ) &&
      report.lastCanonicalCount === report.fixtures[0].expectedFinalMessages,
    coherentLiveClient:
      summary.canonicalCommitsDuringAppends > 1 && summary.requests.canonical.errors === 0,
    errors:
      !!final && final.errors.length === 0 && report.requests.every((request) => !request.error),
    accounting:
      !!final && final.accountingFailures.length === 0 && final.cache.budgetUsedBytes === 0,
    cpuTarget:
      cpuTargetPercent === null
        ? null
        : finite(summary.append.cpuMean) && summary.append.cpuMean < cpuTargetPercent,
    recoveryCpu:
      finite(summary.recoveryCpuDelta) &&
      summary.recoveryCpuDelta <= 10 &&
      summary.baselineTail.samples >= 10 &&
      summary.recoveryTail.samples >= 10,
    teardown:
      !!final &&
      finite(report.drainMs) &&
      report.drainMs <= report.config.drainMs &&
      report.pendingRequestsAtExit === 0 &&
      perKey.every((key) => key.activeParses === 0 && key.activeHandlers === 0) &&
      final.transcriptReaders === 0 &&
      final.watchers === 0 &&
      final.queuedRefreshes === 0 &&
      final.httpActive === 0 &&
      final.cacheFlights === 0 &&
      final.readerFlights === 0,
    fixturesRemoved: report.fixturesRemoved === true,
    sourceUnchanged: report.sourceUnchanged === true,
  };
  // The metrics-only lane's target direction: with many appending sessions and exactly one viewed,
  // no more than the viewed session ever holds a cache entry and only it does full parses. A
  // BEFORE run (no lane) fails these — every appending watcher retains bodies and reparses on
  // eviction — which is the contrast the profile exists to measure.
  if (report.config.profile === 'many-unviewed') {
    const viewedId = report.fixtures?.[0]?.id;
    const appendTelemetry = (report.telemetry ?? []).filter((sample) => sample.phase === 'append');
    const peakEntriesDuringAppend = Math.max(
      0,
      ...appendTelemetry.map((sample) => sample.cacheEntries ?? 0),
    );
    checks.unviewedHoldNoEntries = appendTelemetry.length > 0 && peakEntriesDuringAppend <= 1;
    checks.viewedIsBodyPath = !!final && (final.counters[viewedId]?.full ?? 0) >= 1;
    checks.fullParsesOnlyViewed =
      !!final &&
      Object.entries(final.counters).every(([id, key]) => id === viewedId || key.full === 0);
  }
  return checks;
}

async function parent(config) {
  assert(process.platform === 'linux', 'This opt-in harness requires Linux /proc sampling');
  assert(
    !fs.existsSync(config.report),
    'Use a new report path; existing evidence is not overwritten',
  );
  fs.mkdirSync(path.dirname(config.report), { recursive: true });
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    config,
    provenance: provenance(),
    fixtures: [],
    samples: [],
    telemetry: [],
    requests: [],
    updates: [],
    lastSummaryCounts: {},
    safetyAbort: null,
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-transcript-load-'));
  let child;
  let logFd;
  const timers = new Set();
  const requests = new Set();
  let phase = 'startup';
  let readyAt;
  let port;
  let exited = false;
  let writer;
  let polls;
  let clientTimer;
  let clientRunning = false;
  let clientDirty = false;
  let clientStopped = false;
  let dirtySince;
  let retryMs = 1000;
  let resolveReady;
  let resolveExited;
  let resolveDrained;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const exit = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const drained = new Promise((resolve) => {
    resolveDrained = resolve;
  });
  const atSec = () => (readyAt === undefined ? null : (performance.now() - readyAt) / 1000);
  const abort = (reason) => {
    report.safetyAbort ??= reason;
    clearInterval(writer);
    clearInterval(polls);
    clearTimeout(clientTimer);
    clientStopped = true;
    if (child && !exited) child.kill('SIGKILL');
  };
  const onSignal = () => abort('Interrupted');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  function request(kind, id, eventAt) {
    const began = performance.now();
    const item = { kind, id, atSec: atSec(), phase };
    const promise = new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: `/${kind}/${id}`, agent: false },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('error', (error) => finish(error));
          res.on('end', () => {
            try {
              assert.equal(res.statusCode, 200, data.slice(0, 200));
              const result = JSON.parse(data);
              if (kind === 'canonical') {
                Object.assign(item, validateCanonical(result, config.pageSize));
                report.lastCanonicalCount = item.messageCount;
                if (eventAt !== undefined) item.eventToCommitMs = performance.now() - eventAt;
              } else if (kind === 'summary') {
                item.messageCount = result.messageCount;
                report.lastSummaryCounts[id] = result.messageCount;
              } else item.messageCount = result.totals.messageCount;
              item.responseBytes = Buffer.byteLength(data);
              finish();
            } catch (error) {
              finish(error);
            }
          });
        },
      );
      let finished = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        item.ms = performance.now() - began;
        item.completedPhase = phase;
        if (error) item.error = error.message;
        report.requests.push(item);
        resolve(item);
      }
      req.setTimeout(10000, () => req.destroy(new Error('10s request timeout')));
      req.on('error', finish);
    });
    requests.add(promise);
    promise.finally(() => requests.delete(promise));
    return promise;
  }
  function canonical(eventAt = performance.now()) {
    if (clientStopped) return;
    if (clientRunning) {
      clientDirty = true;
      dirtySince ??= eventAt;
      return;
    }
    clearTimeout(clientTimer);
    clientTimer = undefined;
    clientRunning = true;
    clientDirty = false;
    const since = dirtySince ?? eventAt;
    dirtySince = undefined;
    request('canonical', report.fixtures[0].id, since).then((item) => {
      clientRunning = false;
      if (clientStopped) return;
      if (!item.error) retryMs = 1000;
      if (item.error || clientDirty) {
        clientTimer = setTimeout(() => {
          clientTimer = undefined;
          canonical();
        }, retryMs);
        retryMs = Math.min(5000, retryMs * 2);
      }
    });
  }
  try {
    report.fixtures = createFixtures(directory, config);
    const files = new Set(report.fixtures.map((fixture) => fixture.file));
    logFd = fs.openSync(`${config.report}.child.log`, 'wx');
    child = fork(__filename, ['--worker', JSON.stringify({ config, fixtures: report.fixtures })], {
      cwd: APP,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TRANSCRIPT_CACHE_MAX_BYTES: String(config.budgetBytes),
        TRANSCRIPT_CACHE_IDLE_TTL_MS: '600000',
        TRANSCRIPT_CACHE_SWEEP_INTERVAL_MS: '60000',
      },
      execArgv: [`--max-old-space-size=${config.childHeapMiB}`],
      stdio: ['ignore', logFd, logFd, 'ipc'],
    });
    report.pid = child.pid;
    try {
      os.setPriority(child.pid, 10);
    } catch {
      /* Nice is optional; limits are enforced externally. */
    }
    child.on('exit', (code, signal) => {
      exited = true;
      report.exit = { code, signal };
      resolveExited();
    });
    child.on('error', (error) => {
      report.safetyAbort = error.message;
      resolveReady();
    });
    child.on('message', (message) => {
      if (message.type === 'ready') {
        report.ready = message;
        port = message.port;
        resolveReady();
      } else if (message.type === 'update') {
        report.updates.push({ ...message, atSec: atSec(), phase });
        if (message.sessionId === report.fixtures[0].id) canonical();
      } else if (message.type === 'sample')
        report.telemetry.push({ ...message, atSec: atSec(), phase });
      else if (message.type === 'drained') {
        report.drained = message;
        resolveDrained();
      } else if (message.type === 'final') report.final = message;
      else if (message.type === 'fatal') abort(message.error);
    });
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    let previous;
    const sample = () => {
      if (exited) return;
      try {
        const now = performance.now();
        const raw = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
        const fields = raw
          .slice(raw.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/);
        const cpu = (Number(fields[11]) + Number(fields[12])) / ticks;
        const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const rssMiB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) / 1024;
        const item = {
          atSec: atSec(),
          phase,
          rssMiB,
          transcriptReaders: transcriptReaders(child.pid, files),
          cpuSeconds: previous ? cpu - previous.cpu : null,
          elapsedSeconds: previous ? (now - previous.now) / 1000 : null,
        };
        item.cpuPercent =
          item.cpuSeconds === null ? null : (100 * item.cpuSeconds) / item.elapsedSeconds;
        report.samples.push(item);
        previous = { cpu, now };
        if (rssMiB > config.rssCutoffMiB) abort(`RSS exceeded ${config.rssCutoffMiB} MiB`);
      } catch (error) {
        if (!exited && error.code !== 'ENOENT') abort(error.message);
      }
    };
    const monitor = setInterval(sample, config.sampleIntervalMs);
    timers.add(monitor);
    const deadline = setTimeout(
      () => abort(`${config.wallClockSec}s wall-clock limit`),
      config.wallClockSec * 1000,
    );
    timers.add(deadline);
    await Promise.race([ready, exit]);
    if (exited || !port) throw new Error('Worker failed before readiness');
    readyAt = performance.now();
    phase = 'baseline';
    previous = undefined;
    // Summary polling on every session (an O(1) lane read for the unviewed ones). The index route
    // parses and creates a cache entry, so with viewedOnly it runs only for the single viewed
    // session — the canonical client already covers it and the unviewed ones must stay in the lane.
    const poll = () => {
      for (const { id } of report.fixtures) {
        void request('summary', id);
        if (!config.viewedOnly || id === report.fixtures[0].id) void request('index', id);
      }
    };
    poll();
    polls = setInterval(poll, config.summaryIntervalMs);
    timers.add(polls);
    canonical();
    console.log(
      JSON.stringify({
        event: 'ready',
        fileMiB: config.fileMiB,
        sessions: config.sessions,
        pid: child.pid,
      }),
    );
    await Promise.race([sleep(config.baselineSec * 1000), exit]);
    if (exited) throw new Error('Worker exited during baseline');
    phase = 'append';
    report.appendStartedAtSec = atSec();
    writer = setInterval(() => {
      try {
        for (const fixture of report.fixtures) {
          const makeTurnFor = fixture.provider === 'claude' ? makeClaudeTurn : makeTurn;
          fs.appendFileSync(fixture.file, makeTurnFor(fixture.turns++));
          fixture.appends += 1;
        }
      } catch (error) {
        abort(error.message);
      }
    }, config.appendIntervalMs);
    timers.add(writer);
    console.log(JSON.stringify({ event: 'append-start' }));
    await Promise.race([sleep(config.appendSec * 1000), exit]);
    clearInterval(writer);
    if (exited) throw new Error('Worker exited during appends');
    phase = 'recovery';
    report.recoveryStartedAtSec = atSec();
    console.log(
      JSON.stringify({
        event: 'recovery-start',
        appends: report.fixtures.map((fixture) => fixture.appends),
      }),
    );
    await Promise.race([sleep(config.recoverySec * 1000), exit]);
    if (exited) throw new Error('Worker exited during recovery');
    phase = 'drain';
    const drainStarted = performance.now();
    clearInterval(polls);
    const drainDeadline = setTimeout(() => abort('Teardown exceeded five seconds'), config.drainMs);
    timers.add(drainDeadline);
    child.send('drain');
    await Promise.race([drained, exit]);
    while (!exited && (requests.size || clientRunning || clientTimer)) await sleep(10);
    clientStopped = true;
    clearTimeout(clientTimer);
    if (!exited) child.send('finish');
    await exit;
    report.drainMs = performance.now() - drainStarted;
    clearTimeout(drainDeadline);
  } catch (error) {
    abort(error.message);
    if (child && !exited) await exit;
  } finally {
    clientStopped = true;
    clearTimeout(clientTimer);
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    if (logFd !== undefined) fs.closeSync(logFd);
    for (const fixture of report.fixtures) {
      fixture.finalBytes = fs.statSync(fixture.file).size;
      fixture.expectedFinalMessages = fixture.turns * 2;
    }
    fs.rmSync(directory, { recursive: true, force: true });
    report.fixturesRemoved = !fs.existsSync(directory);
    report.sourceUnchanged =
      report.provenance.source.sha256 ===
        treeDigest(path.join(APP, 'src/modules/session-reader')).sha256 &&
      report.provenance.productionDist.sha256 === treeDigest(path.join(APP, 'dist')).sha256;
    report.pendingRequestsAtExit = requests.size;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    report.summary = summarize(report);
    report.checks = evaluate(report);
    report.pass = Object.values(report.checks).every((value) => value === true || value === null);
    fs.writeFileSync(config.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(
    JSON.stringify(
      {
        event: 'complete',
        report: config.report,
        pass: report.pass,
        checks: report.checks,
        summary: report.summary,
      },
      null,
      2,
    ),
  );
  if (!report.pass) process.exitCode = 1;
}

if (require.main === module) {
  const run =
    process.argv[2] === '--worker'
      ? worker(JSON.parse(process.argv[3]))
      : (async () => {
          const config = parseArgs(process.argv.slice(2));
          if (config.help) {
            console.log(
              'node apps/local-app/scripts/transcript-load.js --file-mib 65 --sessions 1 --report /tmp/transcript-65.json\nBuild local-app first. Acceptance: 65/200 MiB single-session or four 65 MiB sessions.\n--profile many-unviewed: ~20 Claude+Codex sessions (~5 MiB), one viewed, the rest in the metrics-only lane.\nOptional --baseline-sec/--append-sec/--recovery-sec shorten smoke runs (not acceptance evidence).',
            );
            return;
          }
          await parent(config);
        })();
  run.catch((error) => {
    console.error(error);
    process.exitCode = 1;
    if (process.send) process.exit(1);
  });
}

module.exports = { parseArgs, validateCanonical, summarize, evaluate };
