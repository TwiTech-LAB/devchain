import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IncrementalResult,
  ParseOptions,
  SessionReaderAdapter,
} from '../adapters/session-reader-adapter.interface';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import type { UnifiedMessage, UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import { SessionCacheService } from './session-cache.service';

const SESSION_ID = 'replacement-session';

const metricsService = {
  registerCacheStatsProvider: jest.fn(),
  registerStatsProvider: jest.fn(),
} as never;

interface TranscriptRow {
  id: string;
  marker: string;
  timestamp: number;
}

function makeMetrics(messages: UnifiedMessage[]): UnifiedMetrics {
  return {
    inputTokens: messages.length,
    outputTokens: messages.length,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: messages.length * 2,
    totalContextConsumption: messages.length * 2,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: messages.length,
    totalContextTokens: messages.length * 2,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: 'replacement-fixture',
    durationMs: Math.max(0, messages.length - 1),
    messageCount: messages.length,
    isOngoing: false,
  };
}

function rowsToMessages(rows: TranscriptRow[]): UnifiedMessage[] {
  return rows.map((row) => ({
    id: row.id,
    parentId: null,
    role: 'user',
    timestamp: new Date(row.timestamp),
    content: [{ type: 'text', text: row.marker }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
  }));
}

function parseRows(content: string): TranscriptRow[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptRow);
}

function transcript(generation: number, count: number, start = 0): string {
  return (
    Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      const marker = `GEN:1337:0:${generation}`;
      return JSON.stringify({
        id: `${marker}:${index.toString().padStart(3, '0')}`,
        marker,
        timestamp: 1_706_000_000_000 + index,
      } satisfies TranscriptRow);
    }).join('\n') + '\n'
  );
}

function makeAdapter(filePath: string): SessionReaderAdapter {
  const parseFullSession = jest.fn(async (): Promise<UnifiedSession> => {
    const messages = rowsToMessages(parseRows(await readFile(filePath, 'utf8')));
    return {
      id: SESSION_ID,
      providerName: 'fixture',
      filePath,
      messages,
      metrics: makeMetrics(messages),
      isOngoing: false,
    };
  });
  const parseIncremental = jest.fn(
    async (_path: string, options: ParseOptions): Promise<IncrementalResult> => {
      const bytes = await readFile(filePath);
      const messages = rowsToMessages(
        parseRows(bytes.subarray(options.byteOffset ?? 0).toString('utf8')),
      );
      return {
        hasMore: false,
        nextByteOffset: bytes.byteLength,
        messageCount: messages.length,
        entries: messages,
        metrics: makeMetrics(messages),
      };
    },
  );

  return {
    providerName: 'fixture',
    sourceKind: 'file',
    incrementalMode: 'delta',
    allowedRoots: [],
    discoverSessionFile: jest.fn(),
    parseSessionFile: jest.fn(),
    parseIncremental,
    getWatchPaths: jest.fn(),
    calculateCost: jest.fn(),
    parseFullSession,
  };
}

function observedMarkers(session: UnifiedSession): string[] {
  return Array.from(
    new Set(
      session.messages.map((message) => {
        const part = message.content[0];
        return part?.type === 'text' ? part.text : '';
      }),
    ),
  );
}

describe('SessionCacheService file replacement classification', () => {
  let directory: string;
  let filePath: string;
  let service: SessionCacheService;
  let adapter: SessionReaderAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'devchain-reader-replacement-'));
    filePath = join(directory, 'session.jsonl');
    service = new SessionCacheService(metricsService);
    adapter = makeAdapter(filePath);
  });

  afterEach(async () => {
    service.clear();
    await rm(directory, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  async function atomicReplace(content: string): Promise<void> {
    const replacementPath = join(directory, `replacement-${Date.now()}.jsonl`);
    await writeFile(replacementPath, content);
    await rename(replacementPath, filePath);
  }

  it('fully replaces a cached 70-message generation when an atomic rewrite grows to 76', async () => {
    await writeFile(filePath, transcript(1, 70));
    const oldStat = await stat(filePath);
    const oldResult = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);
    expect(oldResult.session.metrics.messageCount).toBe(70);
    expect(oldResult).toMatchObject({ sourceChangeKind: 'unknown-full-parse' });
    const oldSourceVersion = service.getEntry(SESSION_ID)!.sourceVersion;

    const oldChunks: UnifiedChunk[] = [];
    service.setChunks(SESSION_ID, oldSourceVersion, oldChunks);
    expect(service.getChunks(SESSION_ID, oldSourceVersion)).toBe(oldChunks);

    await atomicReplace(transcript(4, 76));
    const newStat = await stat(filePath);
    expect(newStat.ino).not.toBe(oldStat.ino);

    const currentResult = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);
    const current = currentResult.session;

    expect(currentResult).toMatchObject({ sourceChangeKind: 'file-replacement' });
    expect(current.metrics.messageCount).toBe(76);
    expect(current.messages).toHaveLength(76);
    expect(observedMarkers(current)).toEqual(['GEN:1337:0:4']);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
    const newSourceVersion = service.getEntry(SESSION_ID)!.sourceVersion;
    expect(newSourceVersion).not.toBe(oldSourceVersion);
    expect(service.getChunks(SESSION_ID, newSourceVersion)).toBeUndefined();
    expect(service.getChunks(SESSION_ID, oldSourceVersion)).toBeUndefined();
  });

  it.each([
    { label: 'equal-size', initialCount: 70, replacementCount: 70 },
    { label: 'shrinking', initialCount: 76, replacementCount: 70 },
  ])('fully reparses an atomic $label replacement', async ({ initialCount, replacementCount }) => {
    await writeFile(filePath, transcript(1, initialCount));
    const oldStat = await stat(filePath);
    await service.getOrParse(SESSION_ID, filePath, adapter);

    await atomicReplace(transcript(2, replacementCount));
    const newStat = await stat(filePath);
    expect(newStat.ino).not.toBe(oldStat.ino);

    const currentResult = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);
    const current = currentResult.session;

    expect(currentResult).toMatchObject({ sourceChangeKind: 'file-replacement' });
    expect(current.messages).toHaveLength(replacementCount);
    expect(observedMarkers(current)).toEqual(['GEN:1337:0:2']);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  it('keeps incremental parsing for a true same-file append', async () => {
    await writeFile(filePath, transcript(1, 70));
    const oldStat = await stat(filePath);
    await service.getOrParse(SESSION_ID, filePath, adapter);

    await appendFile(filePath, transcript(1, 6, 70));
    const newStat = await stat(filePath);
    expect(newStat.ino).toBe(oldStat.ino);

    const currentResult = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);
    const current = currentResult.session;

    expect(currentResult).toMatchObject({ sourceChangeKind: 'same-file-append' });
    expect(current.messages).toHaveLength(76);
    expect(observedMarkers(current)).toEqual(['GEN:1337:0:1']);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(1);
    expect(adapter.parseIncremental).toHaveBeenCalledTimes(1);
  });

  it('fully reparses a growing same-inode rewrite whose prior byte prefix changed', async () => {
    await writeFile(filePath, transcript(1, 70));
    const oldStat = await stat(filePath);
    await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    await writeFile(filePath, transcript(2, 76));
    const newStat = await stat(filePath);
    expect(newStat.ino).toBe(oldStat.ino);
    expect(newStat.size).toBeGreaterThan(oldStat.size);

    const current = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    expect(current).toMatchObject({ sourceChangeKind: 'same-file-rewrite' });
    expect(current.session.messages).toHaveLength(76);
    expect(observedMarkers(current.session)).toEqual(['GEN:1337:0:2']);
    expect(adapter.parseFullSession).toHaveBeenCalledTimes(2);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  it('classifies an unchanged cache hit separately from its cold full parse', async () => {
    await writeFile(filePath, transcript(1, 70));

    const cold = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);
    const unchanged = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    expect(cold).toMatchObject({ cacheHit: false, sourceChangeKind: 'unknown-full-parse' });
    expect(unchanged).toMatchObject({ cacheHit: true, sourceChangeKind: 'cache-hit' });
  });

  it('classifies a same-inode equal-size rewrite as unsafe', async () => {
    const original = transcript(1, 70);
    const rewritten = transcript(2, 70);
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
    await writeFile(filePath, original);
    const oldStat = await stat(filePath);
    await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    await writeFile(filePath, rewritten);
    await utimes(filePath, new Date(), new Date(Date.now() + 2_000));
    const newStat = await stat(filePath);
    expect(newStat.ino).toBe(oldStat.ino);
    expect(newStat.size).toBe(oldStat.size);

    const current = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    expect(current).toMatchObject({ sourceChangeKind: 'same-file-rewrite' });
    expect(observedMarkers(current.session)).toEqual(['GEN:1337:0:2']);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  it('classifies a same-inode shrink as truncation', async () => {
    await writeFile(filePath, transcript(1, 76));
    const oldStat = await stat(filePath);
    await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    await writeFile(filePath, transcript(2, 70));
    const newStat = await stat(filePath);
    expect(newStat.ino).toBe(oldStat.ino);
    expect(newStat.size).toBeLessThan(oldStat.size);

    const current = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    expect(current).toMatchObject({ sourceChangeKind: 'file-truncation' });
    expect(observedMarkers(current.session)).toEqual(['GEN:1337:0:2']);
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'medium', rows: 10_000 },
    { label: 'large', rows: 20_000 },
  ])(
    'bounds append proof hashing to the anchor windows for a $label transcript',
    async ({ rows }) => {
      await writeFile(filePath, transcript(1, rows));
      await service.getOrParse(SESSION_ID, filePath, adapter); // full parse stores the anchors
      const fileSize = (await stat(filePath)).size;

      // Sum the bytes the append proof hashes by wrapping the fs handle it reads through. The
      // proof is the only `fs/promises` open on this path, so the read lengths are its windows.
      // `import * as fs` in the proof module delegates to this real singleton at call time.
      const realFsp = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
      const originalOpen = realFsp.open;
      let hashedBytes = 0;
      realFsp.open = (async (...openArgs: Parameters<typeof originalOpen>) => {
        const handle = await originalOpen(...openArgs);
        const originalRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        (handle as { read: (...a: unknown[]) => Promise<unknown> }).read = (...readArgs) => {
          const length = readArgs[2];
          if (typeof length === 'number') hashedBytes += Math.max(0, length);
          return originalRead(...readArgs);
        };
        return handle;
      }) as typeof originalOpen;

      let result;
      try {
        await appendFile(filePath, transcript(1, 6, rows));
        result = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);
      } finally {
        realFsp.open = originalOpen;
      }

      expect(result.sourceChangeKind).toBe('same-file-append');
      // Six 64 KiB windows (pre-parse, post-parse re-check, and store — each a head + tail),
      // independent of file size and far below the whole file.
      expect(hashedBytes).toBeGreaterThan(0);
      expect(hashedBytes).toBeLessThanOrEqual(6 * 64 * 1024);
      expect(hashedBytes).toBeLessThan(fileSize);
    },
  );

  it('stores no append proof when the file grows during a full parse (no later duplicates)', async () => {
    await writeFile(filePath, transcript(1, 70));
    const fullSession = adapter.parseFullSession as jest.Mock;
    const baseImpl = fullSession.getMockImplementation()!;
    // Grow the file mid-parse so the post-parse anchor snapshot no longer matches → no anchors.
    fullSession.mockImplementationOnce(async (...args: unknown[]) => {
      await appendFile(filePath, transcript(1, 6, 70));
      return baseImpl(...args);
    });

    await service.getOrParse(SESSION_ID, filePath, adapter);
    expect(service.getEntry(SESSION_ID)?.fileContentAnchors).toBeUndefined();

    // The next growth cannot be proven as an append (no stored anchors) → canonical reparse,
    // so the messages the mid-parse growth already folded in are never re-read as a delta.
    await appendFile(filePath, transcript(1, 3, 76));
    const result = await service.getOrParseWithMeta(SESSION_ID, filePath, adapter);

    expect(result.sourceChangeKind).toBe('same-file-rewrite');
    expect(adapter.parseIncremental).not.toHaveBeenCalled();
    const ids = result.session.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length); // every row exactly once
  });
});
