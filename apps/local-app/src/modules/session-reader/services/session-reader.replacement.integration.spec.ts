import { appendFile, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import type { SessionSourceRef } from '../adapters/session-reader-adapter.interface';
import type { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCacheService } from './session-cache.service';
import { SessionReaderService } from './session-reader.service';
import type { TranscriptPathValidator } from './transcript-path-validator.service';
import type { PricingServiceInterface } from './pricing.interface';
import { decodeCursor, TRANSCRIPT_PARSER_GENERATION } from './transcript-cursor';
import type { TranscriptTailResponse } from './session-reader.service';

const SESSION_ID = 'equal-size-replacement';

const metricsService = {
  registerCacheStatsProvider: jest.fn(),
  registerStatsProvider: jest.fn(),
} as never;

function userRow(index: number, content: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `u-${index.toString().padStart(3, '0')}`,
    parentUuid: index === 1 ? null : 'a-001',
    isSidechain: false,
    timestamp: `2026-01-01T10:00:${(index * 10).toString().padStart(2, '0')}.000Z`,
    message: { role: 'user', content },
  };
}

function transcript(assistantText: string, extraMessages = 0): string {
  return (
    [
      userRow(1, 'Describe the current generation.'),
      {
        type: 'assistant',
        uuid: 'a-001',
        parentUuid: 'u-001',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: assistantText }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      ...Array.from({ length: extraMessages }, (_, offset) =>
        userRow(offset + 2, `Follow-up ${offset + 1}`),
      ),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
}

function appendedUser(index: number, content: string): string {
  return `${JSON.stringify(userRow(index, content))}\n`;
}

/** A later assistant row of the open turn; it joins the last AI chunk, which grows in place. */
function appendedAssistant(index: number, text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: `a-${index.toString().padStart(3, '0')}`,
    parentUuid: 'a-001',
    isSidechain: false,
    timestamp: `2026-01-01T10:01:${(index * 2).toString().padStart(2, '0')}.000Z`,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })}\n`;
}

function expectDelta(tail: TranscriptTailResponse | null) {
  if (tail?.kind !== 'delta') throw new Error(`expected a delta, got ${tail?.kind ?? 'null'}`);
  return tail;
}

/** The cursor's leading fields re-encoded without its proof, at `generation`. */
function withoutProof(cursor: string, generation: number): string {
  const fields = Buffer.from(cursor, 'base64url').toString().split(':').slice(0, 3);
  return Buffer.from([...fields, generation].join(':')).toString('base64url');
}

describe('SessionReaderService file replacement cursor integration', () => {
  let directory: string;
  let filePath: string;
  let cache: SessionCacheService;
  let service: SessionReaderService;
  let adapter: ClaudeSessionReaderAdapter;
  let resolveSpy: jest.SpyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'devchain-tail-replacement-'));
    filePath = join(directory, 'session.jsonl');
    cache = new SessionCacheService(metricsService);

    const pricing = {
      calculateMessageCost: jest.fn().mockReturnValue(0),
      getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
    } as unknown as PricingServiceInterface;
    adapter = new ClaudeSessionReaderAdapter(pricing);

    service = new SessionReaderService(
      {} as SessionReaderAdapterFactory,
      {} as TranscriptPathValidator,
      cache,
      {} as SessionsService,
    );

    const sourceRef: SessionSourceRef = {
      filePath,
      providerName: 'claude',
      kind: 'file',
    };
    resolveSpy = jest
      .spyOn(service as unknown as { resolveAdapter: () => Promise<unknown> }, 'resolveAdapter')
      .mockResolvedValue({
        adapter,
        transcriptPath: filePath,
        sourceRef,
        providerName: 'claude',
      });
  });

  afterEach(async () => {
    resolveSpy?.mockRestore();
    cache?.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function atomicReplace(content: string): Promise<void> {
    const replacementPath = join(directory, `replacement-${Date.now()}.jsonl`);
    await writeFile(replacementPath, content);
    await rename(replacementPath, filePath);
  }

  it('requires a full refetch for an equal-size, equal-count early atomic replacement', async () => {
    const original = transcript('ORIGINAL', 2);
    const replacement = transcript('REVISED!', 2);
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));

    await writeFile(filePath, original);
    const originalStat = await stat(filePath);
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);
    const initialCursor = decodeCursor(summary.cursor);

    expect(initialCursor).not.toBeNull();
    expect(Number.isSafeInteger(initialCursor?.fileSize)).toBe(true);
    expect(initialCursor?.messageCount).toBe(4);

    await atomicReplace(replacement);
    const replacementStat = await stat(filePath);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(replacementStat.ino).not.toBe(originalStat.ino);

    const changed = await service.getTranscriptTail(SESSION_ID, summary.cursor);
    expect(changed).toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'file-replacement',
    });
    expect(changed).not.toHaveProperty('cursor');
    expect(changed).not.toHaveProperty('deltaChunks');

    const refreshed = await service.getTranscriptSummaryWithCursor(SESSION_ID);
    expect(refreshed.cursor).not.toBe(summary.cursor);
    expect(decodeCursor(refreshed.cursor)?.messageCount).toBe(initialCursor?.messageCount);
    const canonical = await service.getTranscript(SESSION_ID);
    expect(JSON.stringify(canonical.messages)).toContain('REVISED!');
    expect(JSON.stringify(canonical.messages)).not.toContain('ORIGINAL');

    const unchanged = await service.getTranscriptTail(SESSION_ID, refreshed.cursor);
    expect(unchanged).toMatchObject({
      kind: 'delta',
      cursor: refreshed.cursor,
      replaceFromChunkId: null,
      deltaChunks: [],
      deltaMessages: [],
    });
  });

  it('requires a full refetch when an atomic replacement also grows the message count', async () => {
    await writeFile(filePath, transcript('ORIGINAL'));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await atomicReplace(transcript('REVISED!', 2));

    await expect(service.getTranscriptTail(SESSION_ID, summary.cursor)).resolves.toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'file-replacement',
    });
  });

  it('requires a full refetch when the same file is truncated', async () => {
    await writeFile(filePath, transcript('ORIGINAL', 2));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await writeFile(filePath, appendedUser(1, 'Describe the current generation.'));

    await expect(service.getTranscriptTail(SESSION_ID, summary.cursor)).resolves.toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'file-truncation',
    });
  });

  it('requires a full refetch when the same file is rewritten at equal size', async () => {
    const original = transcript('ORIGINAL');
    const replacement = transcript('REVISED!');
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));

    await writeFile(filePath, original);
    const originalStat = await stat(filePath);
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await writeFile(filePath, replacement);
    const future = new Date(originalStat.mtimeMs + 2_000);
    await utimes(filePath, future, future);

    await expect(service.getTranscriptTail(SESSION_ID, summary.cursor)).resolves.toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'same-file-rewrite',
    });
  });

  it('requires a full refetch when a growing same-inode rewrite changes the prior prefix', async () => {
    await writeFile(filePath, transcript('ORIGINAL', 2));
    const oldStat = await stat(filePath);
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await writeFile(filePath, transcript('REVISED!', 4));
    const newStat = await stat(filePath);
    expect(newStat.ino).toBe(oldStat.ino);
    expect(newStat.size).toBeGreaterThan(oldStat.size);

    const changed = await service.getTranscriptTail(SESSION_ID, summary.cursor);
    expect(changed).toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'same-file-rewrite',
    });
    expect(changed).not.toHaveProperty('cursor');

    const refreshed = await service.getTranscriptSummaryWithCursor(SESSION_ID);
    const canonical = await service.getTranscript(SESSION_ID);
    expect(JSON.stringify(canonical.messages)).toContain('REVISED!');
    expect(JSON.stringify(canonical.messages)).not.toContain('ORIGINAL');

    await expect(service.getTranscriptTail(SESSION_ID, refreshed.cursor)).resolves.toMatchObject({
      kind: 'delta',
      cursor: refreshed.cursor,
      deltaChunks: [],
      deltaMessages: [],
    });
  });

  it('requires a full refetch for a replacement after the cache entry was evicted', async () => {
    await writeFile(filePath, transcript('ORIGINAL'));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await atomicReplace(transcript('REVISED!'));
    cache.clear();

    await expect(service.getTranscriptTail(SESSION_ID, summary.cursor)).resolves.toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'file-replacement',
    });
  });

  it.each([
    ['truncation', 'file-truncation', () => writeFile(filePath, appendedUser(1, 'Short'))],
    ['growing rewrite', 'same-file-rewrite', () => writeFile(filePath, transcript('REVISED!', 4))],
  ] as const)(
    'requires a full refetch for a %s after the cache entry was evicted',
    async (_label, sourceChangeKind, change) => {
      await writeFile(filePath, transcript('ORIGINAL', 2));
      const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

      await change();
      cache.clear();

      await expect(service.getTranscriptTail(SESSION_ID, summary.cursor)).resolves.toEqual({
        kind: 'full-refetch-required',
        sourceChangeKind,
      });
    },
  );

  it('returns a safe delta only for a proven same-file append', async () => {
    await writeFile(filePath, transcript('ORIGINAL'));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await appendFile(filePath, appendedUser(2, 'Appended follow-up'));

    const changed = await service.getTranscriptTail(SESSION_ID, summary.cursor);
    expect(changed).toMatchObject({
      kind: 'delta',
      totalMessageCount: 3,
      deltaMessages: [{ id: 'u-002' }],
    });
    expect(changed).toHaveProperty('cursor');
  });

  it('discards an incremental suffix when the path rotates after proof and before adapter read', async () => {
    await writeFile(filePath, transcript('GENERATION-A'));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await appendFile(filePath, appendedUser(2, 'Tentative append from generation B'));
    const currentGeneration = transcript('GENERATION-C', 3);
    const parseIncremental = adapter.parseIncremental.bind(adapter);
    jest.spyOn(adapter, 'parseIncremental').mockImplementationOnce(async (...args) => {
      await atomicReplace(currentGeneration);
      return parseIncremental(...args);
    });

    const changed = await service.getTranscriptTail(SESSION_ID, summary.cursor);

    expect(adapter.parseIncremental).toHaveBeenCalledTimes(1);
    expect(changed).toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'file-replacement',
    });
    expect(changed).not.toHaveProperty('cursor');
    expect(changed).not.toHaveProperty('deltaMessages');

    const canonical = await service.getTranscript(SESSION_ID);
    const serialized = JSON.stringify(canonical.messages);
    expect(serialized).toContain('GENERATION-C');
    expect(serialized).not.toContain('GENERATION-A');
    expect(serialized).not.toContain('Tentative append from generation B');

    const refreshed = await service.getTranscriptSummaryWithCursor(SESSION_ID);
    await expect(service.getTranscriptTail(SESSION_ID, refreshed.cursor)).resolves.toEqual(
      expect.objectContaining({
        kind: 'delta',
        cursor: refreshed.cursor,
        replaceFromChunkId: null,
        deltaChunks: [],
        deltaMessages: [],
      }),
    );
  });

  it('accepts a same-file append while a later append lands during the incremental read', async () => {
    await writeFile(filePath, transcript('ORIGINAL'));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    // The proven follow-up grows the file; the cache bounds the delta read to this snapshot.
    await appendFile(filePath, appendedUser(2, 'Proven append'));

    // A LATE append lands during the adapter read — past the proven bound. Same inode, larger
    // file: the post-parse proof must still accept, and the bounded read must not consume it.
    const realIncremental = adapter.parseIncremental.bind(adapter);
    jest.spyOn(adapter, 'parseIncremental').mockImplementationOnce(async (...args) => {
      await appendFile(filePath, appendedUser(3, 'Late append past the bound'));
      return realIncremental(...args);
    });

    const changed = await service.getTranscriptTail(SESSION_ID, summary.cursor);
    expect(changed).toMatchObject({ kind: 'delta', deltaMessages: [{ id: 'u-002' }] });
    expect(changed).toHaveProperty('cursor');

    // The withheld u-003 arrives on the next tail, read exactly once (no duplicate of u-002).
    const nextCursor = (changed as { cursor: string }).cursor;
    const followUp = await service.getTranscriptTail(SESSION_ID, nextCursor);
    expect(followUp).toMatchObject({ kind: 'delta', deltaMessages: [{ id: 'u-003' }] });
  });

  describe('during an active turn (another reader advanced the cache first)', () => {
    async function mintAtR1() {
      await writeFile(filePath, transcript('ORIGINAL'));
      const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);
      const r1Chunks = await service.getUnifiedTranscriptChunks(
        SESSION_ID,
        undefined,
        20,
        'backward',
      );
      return { cursor: summary.cursor, lastChunk: r1Chunks.chunks[r1Chunks.chunks.length - 1] };
    }

    const advances = [
      [
        'a page read',
        () => service.getUnifiedTranscriptChunks(SESSION_ID, undefined, 20, 'backward'),
      ],
      ['the watcher', () => cache.refreshIfPresent(SESSION_ID, filePath, adapter)],
    ] as const;

    it.each(advances)(
      'returns a delta with the growing chunk after %s advanced the cache to R2',
      async (_label, advance) => {
        const r1 = await mintAtR1();
        await appendFile(filePath, appendedAssistant(2, 'Second step of the same turn'));
        await advance();
        expect(cache.getEntry(SESSION_ID)?.session.messages).toHaveLength(3);

        const delta = expectDelta(await service.getTranscriptTail(SESSION_ID, r1.cursor));

        expect(delta.replaceFromChunkId).toBe(r1.lastChunk.id);
        expect(delta.deltaChunks[0].id).toBe(r1.lastChunk.id);
        expect(delta.deltaChunks[0].messages.length).toBeGreaterThan(r1.lastChunk.messages.length);
        expect(delta.deltaMessages.map((message) => message.id)).toEqual(['a-002']);
        expect(decodeCursor(delta.cursor)?.proof?.offset).toBe((await stat(filePath)).size);
      },
    );

    it.each(advances)(
      'returns a delta after %s advanced the cache and the entry was then evicted',
      async (_label, advance) => {
        const r1 = await mintAtR1();
        await appendFile(filePath, appendedAssistant(2, 'Second step of the same turn'));
        await advance();
        cache.invalidate(SESSION_ID);

        const delta = expectDelta(await service.getTranscriptTail(SESSION_ID, r1.cursor));

        expect(delta.replaceFromChunkId).toBe(r1.lastChunk.id);
        expect(delta.deltaMessages.map((message) => message.id)).toEqual(['a-002']);
      },
    );

    it('returns a delta when the entry was evicted before the append', async () => {
      const r1 = await mintAtR1();
      cache.clear();
      await appendFile(filePath, appendedAssistant(2, 'Second step of the same turn'));

      const delta = expectDelta(await service.getTranscriptTail(SESSION_ID, r1.cursor));

      expect(delta.replaceFromChunkId).toBe(r1.lastChunk.id);
      expect(delta.deltaMessages.map((message) => message.id)).toEqual(['a-002']);
    });

    it('fails closed for an older-generation cursor and a cursor without a proof', async () => {
      const r1 = await mintAtR1();
      await appendFile(filePath, appendedAssistant(2, 'Second step of the same turn'));
      await service.getUnifiedTranscriptChunks(SESSION_ID, undefined, 20, 'backward');

      for (const cursor of [
        withoutProof(r1.cursor, TRANSCRIPT_PARSER_GENERATION - 1),
        withoutProof(r1.cursor, TRANSCRIPT_PARSER_GENERATION),
      ]) {
        await expect(service.getTranscriptTail(SESSION_ID, cursor)).resolves.toMatchObject({
          kind: 'full-refetch-required',
        });
      }
      // The same position with its proof still answers a delta.
      expect(await service.getTranscriptTail(SESSION_ID, r1.cursor)).toMatchObject({
        kind: 'delta',
      });
    });
  });

  describe('a snapshot that ends in the middle of a line', () => {
    const partialLine = (text: string) => appendedUser(2, text).slice(0, 40);

    it('mints a cursor whose proof ends at the last complete line and proves on the next tail', async () => {
      const complete = transcript('ORIGINAL');
      await writeFile(filePath, complete + partialLine('Completed later'));
      const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);
      expect(decodeCursor(summary.cursor)?.proof?.offset).toBe(Buffer.byteLength(complete));
      expect(summary.messageCount).toBe(2);

      // The writer finishes the line, and the entry is evicted before the next tail.
      await writeFile(filePath, complete + appendedUser(2, 'Completed later'));
      cache.clear();

      const delta = expectDelta(await service.getTranscriptTail(SESSION_ID, summary.cursor));
      expect(delta.deltaMessages.map((message) => message.id)).toEqual(['u-002']);
      expect(delta.totalMessageCount).toBe(3);
    });

    it('answers a delta while the current file ends in a partial line, then reads it once', async () => {
      await writeFile(filePath, transcript('ORIGINAL'));
      const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

      await appendFile(filePath, partialLine('Arrives in two writes'));
      const partial = expectDelta(await service.getTranscriptTail(SESSION_ID, summary.cursor));
      expect(partial.deltaMessages).toEqual([]);
      expect(decodeCursor(partial.cursor)?.proof?.offset).toBe(
        decodeCursor(summary.cursor)?.proof?.offset,
      );

      await writeFile(filePath, transcript('ORIGINAL') + appendedUser(2, 'Arrives in two writes'));
      const completed = expectDelta(await service.getTranscriptTail(SESSION_ID, partial.cursor));
      expect(completed.deltaMessages.map((message) => message.id)).toEqual(['u-002']);
      expect(completed.totalMessageCount).toBe(3);
    });
  });
});
