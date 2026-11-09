import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevinSessionReaderAdapter } from './devin-session-reader.adapter';
import { DEVIN_TRANSCRIPTS_ROOT } from '../../../common/devin-transcript-paths';
import type { PricingServiceInterface } from '../services/pricing.interface';

jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});
const realHomedir = jest.requireActual<typeof import('node:os')>('node:os').homedir;
const homedirMock = os.homedir as jest.Mock;

const homeDir = os.homedir();
const pricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

const ATIF = JSON.stringify({
  schema_version: 'ATIF-v1.7',
  session_id: 'functional-share',
  agent: { name: 'devin' },
  steps: [
    { step_id: 1, timestamp: '2026-11-05T20:00:00.000000000+00:00', source: 'user', message: 'hi' },
    {
      step_id: 2,
      timestamp: '2026-11-05T20:00:01.000000000+00:00',
      source: 'agent',
      message: 'hi back',
      metrics: { prompt_tokens: 100, completion_tokens: 5 },
    },
  ],
});

describe('DevinSessionReaderAdapter', () => {
  let adapter: DevinSessionReaderAdapter;
  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new DevinSessionReaderAdapter(pricing);
  });

  it('declares devin file/snapshot identity + allowedRoots under the DevChain store', () => {
    expect(adapter.providerName).toBe('devin');
    expect(adapter.sourceKind).toBe('file');
    expect(adapter.incrementalMode).toBe('snapshot');
    expect(adapter.allowedRoots).toEqual([path.join(homeDir, DEVIN_TRANSCRIPTS_ROOT)]);
    expect(adapter.getWatchPaths('/any')).toEqual([path.join(homeDir, DEVIN_TRANSCRIPTS_ROOT)]);
  });

  it('onModuleInit creates the export folder with mode 0700 and keeps existing exports', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-home-'));
    homedirMock.mockReturnValue(home);
    try {
      const reader = new DevinSessionReaderAdapter(pricing);
      const root = path.join(home, DEVIN_TRANSCRIPTS_ROOT);
      await reader.onModuleInit();
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);

      fs.writeFileSync(path.join(root, 'sess-1.json'), ATIF);
      await reader.onModuleInit();
      expect(fs.readFileSync(path.join(root, 'sess-1.json'), 'utf8')).toBe(ATIF);
    } finally {
      homedirMock.mockImplementation(realHomedir);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('derives the export path from context.sessionId; [] when missing on disk', async () => {
    expect(
      await adapter.discoverSessionFile({ projectRoot: '/p', sessionId: 'nope-nope-nope' }),
    ).toEqual([]);
    expect(await adapter.discoverSessionFile({ projectRoot: '/p' })).toEqual([]);
  });

  it('discovers via derived path and stamps providerSessionId from the file session_id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-disc-'));
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, ATIF);
    try {
      const results = await adapter.discoverSessionFile({
        projectRoot: '/p',
        transcriptPath: file,
        sessionId: 'sess-1',
      });
      expect(results).toHaveLength(1);
      expect(results[0].providerSessionId).toBe('functional-share');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to sessionId derivation when transcriptPath is gone', async () => {
    const results = await adapter.discoverSessionFile({
      projectRoot: '/p',
      transcriptPath: '/nonexistent/x.json',
      sessionId: 'missing-too',
    });
    expect(results).toEqual([]);
  });

  it('parseIncremental (snapshot) always re-reads the whole file, incl. a SHRUNK rewrite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-inc-'));
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, ATIF);
    try {
      const r = await adapter.parseIncremental(file, { byteOffset: 5 });
      expect(r.messageCount).toBe(2);
      const stat = fs.statSync(file);
      // byteOffset == size does NOT mean "nothing new" — the export is a
      // whole-document rewrite (compaction can even shrink it). Always re-parse.
      const second = await adapter.parseIncremental(file, { byteOffset: stat.size });
      expect(second.messageCount).toBe(2);
      // Rewrite the file SMALLER (compaction dropped the first step): a byte
      // offset that exceeds the new size must still surface the fresh state.
      const shrunk = JSON.stringify({
        schema_version: 'ATIF-v1.7',
        session_id: 'functional-share',
        steps: [
          {
            step_id: 5,
            timestamp: '2026-11-05T21:00:00.000000000+00:00',
            source: 'user',
            message: 'next',
          },
          {
            step_id: 6,
            timestamp: '2026-11-05T21:00:01.000000000+00:00',
            source: 'agent',
            message: 'ok',
            metrics: { prompt_tokens: 50, completion_tokens: 2 },
          },
        ],
      });
      fs.writeFileSync(file, shrunk);
      const third = await adapter.parseIncremental(file, { byteOffset: stat.size + 10 });
      // Fresh state: user + assistant messages and the NEW step's metrics.
      expect(third.messageCount).toBe(2);
      expect(third.metrics?.outputTokens).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseFullSession ids by export session_id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-full-'));
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, ATIF);
    try {
      const s = await adapter.parseFullSession(file);
      expect(s.id).toBe('functional-share');
      expect(s.providerName).toBe('devin');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
