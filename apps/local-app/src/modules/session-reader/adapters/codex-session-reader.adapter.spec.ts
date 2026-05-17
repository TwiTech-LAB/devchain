import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodexSessionReaderAdapter,
  extractCodexMetadataFromContent,
} from './codex-session-reader.adapter';
import type { PricingServiceInterface } from '../services/pricing.interface';

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

const SESSION_ID = '019e17bb-1111-7222-8333-abcdefabcdef';
const FILENAME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function createAdapter(): CodexSessionReaderAdapter {
  return new CodexSessionReaderAdapter(mockPricing);
}

function sessionMetaLine(id = SESSION_ID): string {
  return JSON.stringify({
    timestamp: '2026-05-11T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-05-11T10:00:00.000Z',
      cwd: '/tmp/project',
    },
  });
}

function writeFile(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function withTempHome(prefix: string): {
  tempHome: string;
  cleanup: () => void;
} {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    tempHome,
    cleanup: () => fs.rmSync(tempHome, { recursive: true, force: true }),
  };
}

function setAdapterHome(adapter: CodexSessionReaderAdapter, homeDir: string): void {
  (adapter as unknown as { homeDir: string }).homeDir = homeDir;
}

describe('CodexSessionReaderAdapter provider session id extraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractProviderSessionIdFromContent', () => {
    it('returns payload id from a valid first-line session_meta event', () => {
      const adapter = createAdapter();

      expect(
        adapter.extractProviderSessionIdFromContent(
          `${sessionMetaLine()}\n${JSON.stringify({ type: 'turn_context', payload: {} })}\n`,
        ),
      ).toBe(SESSION_ID);
    });

    it('returns null for malformed first-line JSON without throwing', () => {
      const adapter = createAdapter();

      expect(adapter.extractProviderSessionIdFromContent('{not-json}\n')).toBeNull();
    });

    it('returns null when the first line is not session_meta', () => {
      const adapter = createAdapter();

      expect(
        adapter.extractProviderSessionIdFromContent(
          `${JSON.stringify({ type: 'turn_context', payload: { id: SESSION_ID } })}\n`,
        ),
      ).toBeNull();
    });

    it('returns null when the first line has not terminated yet', () => {
      const adapter = createAdapter();

      expect(adapter.extractProviderSessionIdFromContent(sessionMetaLine())).toBeNull();
    });
  });

  describe('extractCodexMetadataFromContent', () => {
    it('returns provider id, timestamp, and cwd from a valid first-line session_meta event', () => {
      expect(
        extractCodexMetadataFromContent(
          `${sessionMetaLine()}\n${JSON.stringify({ type: 'turn_context', payload: {} })}\n`,
        ),
      ).toEqual({
        providerSessionId: SESSION_ID,
        metaTimestamp: '2026-05-11T10:00:00.000Z',
        metaCwd: '/tmp/project',
      });
    });

    it('returns null metadata fields for partial or malformed content', () => {
      expect(extractCodexMetadataFromContent(sessionMetaLine())).toEqual({
        providerSessionId: null,
        metaTimestamp: null,
        metaCwd: null,
      });
      expect(extractCodexMetadataFromContent('{bad json}\n')).toEqual({
        providerSessionId: null,
        metaTimestamp: null,
        metaCwd: null,
      });
    });
  });

  describe('extractProviderSessionIdFromFile', () => {
    it('returns payload id from a valid file first line', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-file-');
      const filePath = writeFile(path.join(tempHome, 'rollout.jsonl'), `${sessionMetaLine()}\n`);

      try {
        await expect(adapter.extractProviderSessionIdFromFile(filePath)).resolves.toBe(SESSION_ID);
      } finally {
        cleanup();
      }
    });

    it('returns null for a partially flushed file with no newline within the read cap', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-partial-');
      const filePath = writeFile(path.join(tempHome, 'rollout.jsonl'), sessionMetaLine());

      try {
        await expect(adapter.extractProviderSessionIdFromFile(filePath)).resolves.toBeNull();
      } finally {
        cleanup();
      }
    });

    it('returns null for a missing file', async () => {
      const adapter = createAdapter();

      await expect(
        adapter.extractProviderSessionIdFromFile('/missing/codex-rollout.jsonl'),
      ).resolves.toBeNull();
    });
  });

  describe('discoverSessionFile', () => {
    it('sets providerSessionId from content on the transcriptPath statFile branch', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-stat-');
      const filePath = writeFile(path.join(tempHome, 'plain-name.jsonl'), `${sessionMetaLine()}\n`);

      try {
        const results = await adapter.discoverSessionFile({
          projectRoot: '/tmp/project',
          transcriptPath: filePath,
        });

        expect(results).toHaveLength(1);
        expect(results[0].providerSessionId).toBe(SESSION_ID);
      } finally {
        cleanup();
      }
    });

    it('falls back to filename UUID on transcriptPath when session_meta is missing', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-filename-');
      const filePath = writeFile(
        path.join(tempHome, `rollout-2026-05-11T10-00-00-${FILENAME_ID}.jsonl`),
        `${JSON.stringify({ type: 'turn_context', payload: {} })}\n`,
      );

      try {
        const results = await adapter.discoverSessionFile({
          projectRoot: '/tmp/project',
          transcriptPath: filePath,
        });

        expect(results).toHaveLength(1);
        expect(results[0].providerSessionId).toBe(FILENAME_ID);
      } finally {
        cleanup();
      }
    });

    it('leaves providerSessionId undefined when transcriptPath has neither metadata nor filename UUID', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-none-');
      const filePath = writeFile(path.join(tempHome, 'plain-name.jsonl'), '{bad json}\n');

      try {
        const results = await adapter.discoverSessionFile({
          projectRoot: '/tmp/project',
          transcriptPath: filePath,
        });

        expect(results).toHaveLength(1);
        expect(results[0].providerSessionId).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('uses filename UUID during date-directory scan without reading file content', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-scan-filename-');
      setAdapterHome(adapter, tempHome);
      writeFile(
        path.join(
          tempHome,
          '.codex/sessions/2026/05/11',
          `rollout-2026-05-11T10-00-00-${FILENAME_ID}.jsonl`,
        ),
        `${JSON.stringify({ type: 'turn_context', payload: {} })}\n`,
      );
      const contentSpy = jest.spyOn(adapter, 'extractProviderSessionIdFromFile');

      try {
        const results = await adapter.discoverSessionFile({ projectRoot: '/tmp/project' });

        expect(results).toHaveLength(1);
        expect(results[0].providerSessionId).toBe(FILENAME_ID);
        expect(contentSpy).not.toHaveBeenCalled();
      } finally {
        contentSpy.mockRestore();
        cleanup();
      }
    });

    it('uses session_meta content during date-directory scan when filename has no UUID', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-scan-content-');
      setAdapterHome(adapter, tempHome);
      writeFile(
        path.join(tempHome, '.codex/sessions/2026/05/11', 'rollout-without-uuid.jsonl'),
        `${sessionMetaLine()}\n`,
      );

      try {
        const results = await adapter.discoverSessionFile({ projectRoot: '/tmp/project' });

        expect(results).toHaveLength(1);
        expect(results[0].providerSessionId).toBe(SESSION_ID);
      } finally {
        cleanup();
      }
    });
  });

  describe('parseFullSession', () => {
    it('uses parser session_meta id before filename extraction for non-rollout filenames', async () => {
      const adapter = createAdapter();
      const { tempHome, cleanup } = withTempHome('codex-provider-id-parse-');
      const filePath = writeFile(path.join(tempHome, 'plain-name.jsonl'), `${sessionMetaLine()}\n`);

      try {
        await expect(adapter.parseFullSession(filePath)).resolves.toMatchObject({
          id: SESSION_ID,
          providerName: 'codex',
        });
      } finally {
        cleanup();
      }
    });
  });
});
