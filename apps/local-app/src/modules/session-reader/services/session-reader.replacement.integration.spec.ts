import { appendFile, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import type { SessionSourceRef } from '../adapters/session-reader-adapter.interface';
import type { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { ProviderAdapterFactory } from '../../providers/adapters';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { SessionCacheService } from './session-cache.service';
import { SessionReaderService } from './session-reader.service';
import type { TranscriptPathValidator } from './transcript-path-validator.service';
import type { PricingServiceInterface } from './pricing.interface';
import { decodeCursor } from './transcript-cursor';

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
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
    } as unknown as PricingServiceInterface;
    adapter = new ClaudeSessionReaderAdapter(pricing);
    const providerAdapterFactory = { getAdapter: jest.fn().mockReturnValue({}) };

    service = new SessionReaderService(
      {} as SessionReaderAdapterFactory,
      {} as TranscriptPathValidator,
      cache,
      {} as SessionsService,
      {} as StorageService,
      providerAdapterFactory as unknown as ProviderAdapterFactory,
    );

    const sourceRef: SessionSourceRef = {
      filePath,
      providerName: 'claude',
      kind: 'file',
    };
    resolveSpy = jest
      .spyOn(service as unknown as { resolveAdapter: () => unknown }, 'resolveAdapter')
      .mockResolvedValue({
        adapter,
        transcriptPath: filePath,
        sourceRef,
        providerName: 'claude',
        oneMillionContextEnabled: false,
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

  it('requires a full refetch after cache loss makes the prior source identity unprovable', async () => {
    await writeFile(filePath, transcript('ORIGINAL'));
    const summary = await service.getTranscriptSummaryWithCursor(SESSION_ID);

    await atomicReplace(transcript('REVISED!'));
    cache.clear();

    await expect(service.getTranscriptTail(SESSION_ID, summary.cursor)).resolves.toEqual({
      kind: 'full-refetch-required',
      sourceChangeKind: 'unknown-full-parse',
    });
  });

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
});
