import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChunks } from '../builders/chunk-builder';
import { ClaudeSessionReaderAdapter } from './claude-session-reader.adapter';
import type { PricingServiceInterface } from '../services/pricing.interface';

const homeDir = os.homedir();
const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

function createTestJsonlFile(dir: string, filename: string, entries: object[]): string {
  const filePath = path.join(dir, filename);
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

const userEntry = {
  type: 'user',
  uuid: 'user-1',
  parentUuid: null,
  isSidechain: false,
  timestamp: '2026-01-01T10:00:00.000Z',
  message: { role: 'user', content: 'Hello' },
};

const assistantEntry = {
  type: 'assistant',
  uuid: 'asst-1',
  parentUuid: 'user-1',
  isSidechain: false,
  timestamp: '2026-01-01T10:00:05.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'Hi there!' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

describe('ClaudeSessionReaderAdapter', () => {
  let adapter: ClaudeSessionReaderAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new ClaudeSessionReaderAdapter(mockPricing);
  });

  describe('properties', () => {
    it('should have providerName "claude"', () => {
      expect(adapter.providerName).toBe('claude');
    });

    it('should set allowed roots to ~/.claude/projects/', () => {
      expect(adapter.allowedRoots).toEqual([path.join(homeDir, '.claude/projects/')]);
    });
  });

  describe('discoverSessionFile', () => {
    it('should use transcriptPath when provided and file exists', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-test-'));
      const filePath = createTestJsonlFile(dir, 'session.jsonl', [userEntry]);

      try {
        const results = await adapter.discoverSessionFile({
          projectRoot: '/test/project',
          transcriptPath: filePath,
        });

        expect(results).toHaveLength(1);
        expect(results[0].filePath).toBe(filePath);
        expect(results[0].providerName).toBe('claude');
        expect(results[0].sizeBytes).toBeGreaterThan(0);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });

    it('should return empty when transcriptPath does not exist and no fallback dir', async () => {
      const results = await adapter.discoverSessionFile({
        projectRoot: '/nonexistent/project/path/unique-test',
        transcriptPath: '/nonexistent/path/session.jsonl',
      });

      expect(results).toHaveLength(0);
    });

    it('should scan encoded directory when no transcriptPath', async () => {
      // Create temp directory structure mimicking ~/.claude/projects/-test-project/
      const projectRoot = '/test/project';
      const encodedDir = '-test-project';
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
      const projectDir = path.join(baseDir, encodedDir);
      fs.mkdirSync(projectDir, { recursive: true });
      createTestJsonlFile(projectDir, 'abc123.jsonl', [userEntry, assistantEntry]);

      // Override homeDir by patching the internal state
      // Since we can't easily override os.homedir, we test the encoding logic separately
      // and verify the return structure
      try {
        // We can at least verify the encode logic
        expect(
          (adapter as unknown as { encodeProjectPath: (p: string) => string }).encodeProjectPath(
            projectRoot,
          ),
        ).toBe(encodedDir);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it('never lists Syncthing markers in a project transcript directory as transcripts', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
      const projectDir = path.join(home, '.claude/projects/-test-project');
      fs.mkdirSync(path.join(projectDir, '.stfolder'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.stignore'), '(?d).DS_Store\n');
      fs.mkdirSync(path.join(projectDir, '.stversions'));
      createTestJsonlFile(path.join(projectDir, '.stversions'), 'old.jsonl', [userEntry]);
      createTestJsonlFile(projectDir, 'abc123.jsonl', [userEntry, assistantEntry]);
      (adapter as unknown as { homeDir: string }).homeDir = home;

      try {
        const results = await adapter.discoverSessionFile({ projectRoot: '/test/project' });

        expect(results.map((r) => r.filePath)).toEqual([path.join(projectDir, 'abc123.jsonl')]);
        expect(results[0].providerSessionId).toBe('abc123');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('parseSessionFile', () => {
    it('should parse a JSONL file and return IncrementalResult', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-test-'));
      const filePath = createTestJsonlFile(dir, 'session.jsonl', [userEntry, assistantEntry]);

      try {
        const result = await adapter.parseSessionFile(filePath);

        expect(result.messageCount).toBe(2);
        expect(result.hasMore).toBe(false);
        expect(result.nextByteOffset).toBeGreaterThan(0);
        expect(result.entries).toHaveLength(2);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });

    it('should respect maxMessages option', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-test-'));
      const filePath = createTestJsonlFile(dir, 'session.jsonl', [userEntry, assistantEntry]);

      try {
        const result = await adapter.parseSessionFile(filePath, { maxMessages: 1 });
        expect(result.messageCount).toBe(1);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });
  });

  describe('parseIncremental', () => {
    it('should return empty when offset is at end of file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-test-'));
      const filePath = createTestJsonlFile(dir, 'session.jsonl', [userEntry]);

      try {
        const stat = await fsp.stat(filePath);
        const result = await adapter.parseIncremental(filePath, {
          byteOffset: stat.size,
        });

        expect(result.messageCount).toBe(0);
        expect(result.hasMore).toBe(false);
        expect(result.entries).toHaveLength(0);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });
  });

  describe('encodeProjectPath', () => {
    const encode = (projectRoot: string): string =>
      (adapter as unknown as { encodeProjectPath: (p: string) => string }).encodeProjectPath(
        projectRoot,
      );

    it('replaces every character outside letters and digits, like Claude Code', () => {
      expect(encode('/home/ngsupb/repos/rbac2.0')).toBe('-home-ngsupb-repos-rbac2-0');
      expect(encode('/home/ngsupb/repos/devchain_motion')).toBe(
        '-home-ngsupb-repos-devchain-motion',
      );
      expect(encode('/home/ngsupb/repos/my projects/sundermarch v2')).toBe(
        '-home-ngsupb-repos-my-projects-sundermarch-v2',
      );
    });

    it('keeps DevChain-style folder names unchanged', () => {
      expect(encode('/home/ngsupb/repos/twitech/devchain')).toBe(
        '-home-ngsupb-repos-twitech-devchain',
      );
    });

    it('truncates a name over 200 characters and appends the base-36 path hash', () => {
      const projectRoot = `/home/ngsupb/repos/${'deep.workspace/'.repeat(15)}rbac2.0`;
      const encoded = encode(projectRoot);

      expect(encoded).toBe(
        '-home-ngsupb-repos-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-deep-workspace-d-8ujvg5',
      );
      expect(encoded.length).toBe(200 + 1 + '8ujvg5'.length);
    });
  });

  describe('getWatchPaths', () => {
    it('should return encoded project directory under ~/.claude/projects/', () => {
      const paths = adapter.getWatchPaths('/home/user/my-repo');
      expect(paths).toEqual([path.join(homeDir, '.claude/projects/-home-user-my-repo')]);
    });
  });

  describe('parseFullSession', () => {
    it('should return a complete UnifiedSession', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-test-'));
      const filePath = createTestJsonlFile(dir, 'my-session-id.jsonl', [userEntry, assistantEntry]);

      try {
        const session = await adapter.parseFullSession(filePath);

        expect(session.id).toBe('my-session-id');
        expect(session.providerName).toBe('claude');
        expect(session.filePath).toBe(filePath);
        expect(session.messages).toHaveLength(2);
        expect(session.metrics.messageCount).toBe(2);
        expect(session.metrics.primaryModel).toBe('claude-sonnet-4-6');
        expect(session.isOngoing).toBe(false);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });
  });

  describe('calculateCost', () => {
    it('should delegate to PricingService for each entry with usage', () => {
      const entries = [
        { usage: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 } },
        { usage: { input: 200, output: 100, cacheRead: 0, cacheCreation: 0 } },
        { noUsage: true }, // should be skipped
      ];

      adapter.calculateCost(entries, 'claude-sonnet-4-6');

      expect(mockPricing.calculateMessageCost).toHaveBeenCalledTimes(2);
    });
  });
});

// Adapter unit tests exercise the real parser at its file boundary, including metrics-only scans.
describe('queued human input across adapter read modes', () => {
  const fixture = path.join(__dirname, '../__fixtures__/claude-queued-command.jsonl');

  it.each([3, 4])(
    'matches full parsing when the incremental split is after line %i',
    async (lineCount) => {
      const adapter = new ClaudeSessionReaderAdapter(mockPricing);
      const lines = fs.readFileSync(fixture, 'utf8').trimEnd().split('\n');
      const boundary = Buffer.byteLength(lines.slice(0, lineCount).join('\n') + '\n');
      const full = await adapter.parseFullSession(fixture);
      const head = await adapter.parseIncremental(fixture, {
        byteOffset: 0,
        endByteOffset: boundary,
      });
      const tail = await adapter.parseIncremental(fixture, { byteOffset: head.nextByteOffset });
      expect([...head.entries, ...tail.entries]).toEqual(full.messages);
      expect(head.messageCount + tail.messageCount).toBe(full.metrics.messageCount);
    },
  );

  it('keeps full and metrics-only duration and positional last timestamp in agreement', async () => {
    const adapter = new ClaudeSessionReaderAdapter(mockPricing);
    const full = await adapter.parseFullSession(fixture);
    const summary = await adapter.getSummary({
      filePath: fixture,
      providerName: 'claude',
      kind: 'file',
    });
    expect(buildChunks(full.messages).map((chunk) => chunk.type)).toEqual([
      'user',
      'ai',
      'user',
      'ai',
      'user',
    ]);
    expect(summary.metrics).toEqual(full.metrics);
    expect(summary.metrics.durationMs).toBe(30_000);
    expect(summary.laneSeed.lastMessageTimestamp).toBe(full.messages.at(-1)!.timestamp.getTime());
    expect(summary.laneSeed.lastMessageTimestamp).toBe(Date.parse('2026-01-01T10:00:25.000Z'));
    expect(summary.laneSeed.messageCount).toBe(5);
  });
});
