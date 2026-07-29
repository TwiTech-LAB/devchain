import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotSessionReaderAdapter } from './copilot-session-reader.adapter';
import { SessionReaderAdapterFactory } from './session-reader-adapter.factory';
import type { PricingServiceInterface } from '../services/pricing.interface';

const homeDir = os.homedir();
const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

function writeJsonl(dir: string, filename: string, entries: object[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return filePath;
}

const userEvent = {
  type: 'user.message',
  data: { content: 'Hello', messageId: 'u-1' },
  id: 'u-1',
  timestamp: '2026-06-27T10:00:00.000Z',
  parentId: null,
};
const assistantEvent = {
  type: 'assistant.message',
  data: {
    model: 'claude-haiku-4.5',
    content: 'Hi',
    outputTokens: 10,
    toolRequests: [],
    messageId: 'a-1',
    turnId: '0',
    interactionId: 'i-1',
  },
  id: 'a-1',
  timestamp: '2026-06-27T10:00:01.000Z',
  parentId: 'u-1',
};
const shutdownEvent = {
  type: 'session.shutdown',
  data: {
    shutdownType: 'routine',
    currentModel: 'claude-haiku-4.5',
    modelMetrics: {
      'claude-haiku-4.5': {
        requests: { count: 1, cost: 0.33 },
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    },
  },
  id: 's-1',
  timestamp: '2026-06-27T10:00:02.000Z',
  parentId: 'a-1',
};

describe('CopilotSessionReaderAdapter', () => {
  let adapter: CopilotSessionReaderAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new CopilotSessionReaderAdapter(mockPricing);
  });

  describe('properties', () => {
    it('declares copilot file/snapshot identity', () => {
      expect(adapter.providerName).toBe('copilot');
      expect(adapter.sourceKind).toBe('file');
      // Snapshot: authoritative metrics arrive cumulatively at session.shutdown → cache REPLACES
      // (additive delta-merge would double-count). Gemini uses snapshot for the same reason.
      expect(adapter.incrementalMode).toBe('snapshot');
      expect(adapter.allowedRoots).toEqual([path.join(homeDir, '.copilot/session-state/')]);
    });
  });

  describe('discoverSessionFile (zero-scan derivation)', () => {
    it('derives ~/.copilot/session-state/<sessionId>/events.jsonl from context.sessionId', () => {
      const derive = (
        adapter as unknown as { deriveEventsPath: (sid: string) => string }
      ).deriveEventsPath.bind(adapter);
      const sid = '11111111-2222-3333-4444-555555555555';
      expect(derive(sid)).toBe(path.join(homeDir, '.copilot/session-state', sid, 'events.jsonl'));
    });

    it('returns [] when the derived file does not exist yet (retry loop re-attempts)', async () => {
      const results = await adapter.discoverSessionFile({
        projectRoot: '/proj',
        sessionId: '00000000-0000-0000-0000-000000000000',
      });
      expect(results).toHaveLength(0);
    });

    it('returns [] when no sessionId and no transcriptPath are provided', async () => {
      const results = await adapter.discoverSessionFile({ projectRoot: '/proj' });
      expect(results).toHaveLength(0);
    });

    it('honors an explicit transcriptPath and stamps providerSessionId from sessionId', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-disc-'));
      const sid = '22222222-2222-3333-4444-555555555555';
      const filePath = writeJsonl(dir, 'events.jsonl', [userEvent]);
      try {
        const results = await adapter.discoverSessionFile({
          projectRoot: '/proj',
          transcriptPath: filePath,
          sessionId: sid,
        });
        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(filePath);
        expect(results[0].providerName).toBe('copilot');
        expect(results[0].providerSessionId).toBe(sid);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to sessionId derivation when transcriptPath does not exist', async () => {
      const results = await adapter.discoverSessionFile({
        projectRoot: '/proj',
        transcriptPath: '/nonexistent/copilot/events.jsonl',
        sessionId: '00000000-0000-0000-0000-000000000000',
      });
      expect(results).toHaveLength(0);
    });
  });

  describe('getWatchPaths', () => {
    it('returns the session-state root (projectRoot is irrelevant for Copilot)', () => {
      expect(adapter.getWatchPaths('/any/project')).toEqual([
        path.join(homeDir, '.copilot/session-state/'),
      ]);
    });
  });

  describe('parseSessionFile / parseIncremental / parseFullSession', () => {
    it('parses a full session into a UnifiedSession with id from session.start', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-full-'));
      const filePath = writeJsonl(dir, 'events.jsonl', [
        {
          type: 'session.start',
          data: { sessionId: 'sid-from-start' },
          id: 'x',
          timestamp: '2026-06-27T10:00:00.000Z',
          parentId: null,
        },
        userEvent,
        assistantEvent,
        shutdownEvent,
      ]);
      try {
        const session = await adapter.parseFullSession(filePath);
        expect(session.id).toBe('sid-from-start');
        expect(session.providerName).toBe('copilot');
        expect(session.filePath).toBe(filePath);
        expect(session.messages).toHaveLength(2);
        expect(session.metrics.messageCount).toBe(2);
        expect(session.metrics.isOngoing).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parseSessionFile returns an IncrementalResult', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-psf-'));
      const filePath = writeJsonl(dir, 'events.jsonl', [userEvent, assistantEvent]);
      try {
        const result = await adapter.parseSessionFile(filePath);
        expect(result.messageCount).toBe(2);
        expect(result.hasMore).toBe(false);
        expect(result.nextByteOffset).toBeGreaterThan(0);
        expect(result.entries).toHaveLength(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parseIncremental returns empty when offset is at end of file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-inc-'));
      const filePath = writeJsonl(dir, 'events.jsonl', [userEvent]);
      try {
        const stat = await fsp.stat(filePath);
        const result = await adapter.parseIncremental(filePath, { byteOffset: stat.size });
        expect(result.messageCount).toBe(0);
        expect(result.entries).toHaveLength(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parseIncremental (snapshot) re-reads the whole file ignoring byteOffset', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-snap-'));
      const filePath = writeJsonl(dir, 'events.jsonl', [userEvent, assistantEvent]);
      try {
        // Pass a non-zero byteOffset; snapshot ignores it and returns the full message list.
        const result = await adapter.parseIncremental(filePath, { byteOffset: 5 });
        expect(result.messageCount).toBe(2);
        expect(result.entries).toHaveLength(2);
        expect(result.metrics).toBeDefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('calculateCost', () => {
    it('delegates to PricingService for each entry with usage', () => {
      const entries = [
        { usage: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } },
        { noUsage: true },
      ];
      adapter.calculateCost(entries, 'claude-haiku-4.5');
      expect(mockPricing.calculateMessageCost).toHaveBeenCalledTimes(1);
    });
  });

  describe('factory registration', () => {
    it('resolves via SessionReaderAdapterFactory by provider name', () => {
      const factory = new SessionReaderAdapterFactory();
      factory.registerAdapter(adapter);
      expect(factory.getAdapter('copilot')).toBe(adapter);
      expect(factory.isSupported('copilot')).toBe(true);
      expect(factory.getSupportedProviders()).toContain('copilot');
    });

    it('auto-detects via allowedRoots for a session-state path', () => {
      const factory = new SessionReaderAdapterFactory();
      factory.registerAdapter(adapter);
      const detected = factory.getAdapterForPath(
        path.join(homeDir, '.copilot/session-state/some-uuid/events.jsonl'),
      );
      expect(detected).toBe(adapter);
    });
  });
});
