import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AntigravityMetricsReader } from './antigravity-metrics.reader';
import { createAntigravityFixtureDb } from '../__fixtures__/antigravity-fixture-db';

// ---- test-only protobuf encoder (mirrors the wire decoder) ----
function varint(n: number): Buffer {
  const b: number[] = [];
  let v = n;
  while (v > 0x7f) {
    b.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  b.push(v);
  return Buffer.from(b);
}
const tag = (f: number, wt: number): Buffer => varint(f * 8 + wt);
const vField = (f: number, n: number): Buffer => Buffer.concat([tag(f, 0), varint(n)]);
const lenField = (f: number, buf: Buffer): Buffer =>
  Buffer.concat([tag(f, 2), varint(buf.length), buf]);
const strField = (f: number, s: string): Buffer => lenField(f, Buffer.from(s, 'utf8'));

/** Build a gen_metadata blob: wrapper(1){ usage(4){2=input,3=output}, 19=id, 21=display } */
function genBlob(input: number, output: number, modelId: string, display: string): Buffer {
  const usage = Buffer.concat([vField(2, input), vField(3, output)]);
  const wrapper = Buffer.concat([lenField(4, usage), strField(19, modelId), strField(21, display)]);
  return lenField(1, wrapper);
}

interface GenSpec {
  input: number;
  output: number;
  modelId?: string;
  display?: string;
  rawBlob?: Buffer;
}

function buildDb(
  dbPath: string,
  cascadeId: string,
  gens: GenSpec[],
  opts: { withTables?: boolean } = {},
): void {
  const db = new Database(dbPath);
  if (opts.withTables !== false) {
    db.exec(
      'CREATE TABLE trajectory_meta(trajectory_id TEXT, cascade_id TEXT, trajectory_type INT, source INT)',
    );
    db.exec('CREATE TABLE gen_metadata(idx INT, data BLOB, size INT)');
    db.prepare('INSERT INTO trajectory_meta VALUES (?,?,?,?)').run(
      'internal-tid',
      cascadeId,
      4,
      17,
    );
    const ins = db.prepare('INSERT INTO gen_metadata VALUES (?,?,?)');
    gens.forEach((g, i) => {
      const blob =
        g.rawBlob ??
        genBlob(
          g.input,
          g.output,
          g.modelId ?? 'gemini-3-flash-a',
          g.display ?? 'Gemini 3.5 Flash (High)',
        );
      ins.run(i, blob, blob.length);
    });
  }
  db.close();
}

describe('AntigravityMetricsReader', () => {
  let dir: string;
  const reader = new AntigravityMetricsReader();
  const CONV = '146794e4-0429-4e81-8fe2-e7fad9db2342';
  const dbPathFor = (id = CONV) => path.join(dir, `${id}.db`);

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-metrics-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('sums input/output across generations and captures model + last context', () => {
    buildDb(dbPathFor(), CONV, [
      { input: 1000, output: 100, modelId: 'gemini-3-flash-a', display: 'Gemini 3.5 Flash (High)' },
      { input: 2000, output: 250 },
      { input: 3000, output: 300 },
    ]);

    const m = reader.decode(dbPathFor(), CONV);
    expect(m.warnings).toEqual([]);
    expect(m.inputTokens).toBe(6000);
    expect(m.outputTokens).toBe(650);
    expect(m.generationCount).toBe(3);
    expect(m.lastContextTokens).toBe(3300); // last gen 3000 + 300
    expect(m.modelId).toBe('gemini-3-flash-a');
    expect(m.displayName).toBe('Gemini 3.5 Flash (High)');
    expect(m.cacheReadTokens).toBe(0);
    expect(m.cacheCreationTokens).toBe(0);
  });

  it('FAIL LOUD: warns on conversation id mismatch and does not trust tokens', () => {
    buildDb(dbPathFor('other'), 'a-different-cascade-id', [{ input: 999, output: 9 }]);
    const m = reader.decode(dbPathFor('other'), CONV);
    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
    expect(m.warnings.join(' ')).toMatch(/conversation id mismatch/i);
  });

  it('FAIL LOUD: warns when the .db is absent (never silent zero)', () => {
    const m = reader.decode(dbPathFor('missing'), 'missing');
    expect(m.inputTokens).toBe(0);
    expect(m.warnings.join(' ')).toMatch(/cannot read \.db/i);
  });

  it('FAIL LOUD: warns on schema drift (missing tables)', () => {
    const db = new Database(dbPathFor());
    db.exec('CREATE TABLE unrelated(x INT)');
    db.close();
    const m = reader.decode(dbPathFor(), CONV);
    expect(m.warnings.join(' ')).toMatch(/schema drift/i);
  });

  it('FAIL LOUD: warns when generation metadata rows are missing', () => {
    buildDb(dbPathFor(), CONV, []);
    const m = reader.decode(dbPathFor(), CONV);
    expect(m.warnings.join(' ')).toMatch(/no generation metadata/i);
  });

  it('FAIL LOUD: warns on an undecodable protobuf blob (version-drift tripwire)', () => {
    buildDb(dbPathFor(), CONV, [{ input: 0, output: 0, rawBlob: Buffer.from([0x0a, 0xff]) }]);
    const m = reader.decode(dbPathFor(), CONV);
    expect(m.warnings.join(' ')).toMatch(/undecodable protobuf|possible version drift/i);
  });

  it('skips a garbled row but still sums the decodable ones', () => {
    buildDb(dbPathFor(), CONV, [
      { input: 500, output: 50 },
      { input: 0, output: 0, rawBlob: Buffer.from([0x0a, 0xff]) }, // garbled
      { input: 700, output: 70 },
    ]);
    const m = reader.decode(dbPathFor(), CONV);
    expect(m.inputTokens).toBe(1200);
    expect(m.outputTokens).toBe(120);
    expect(m.generationCount).toBe(2);
    expect(m.warnings.join(' ')).toMatch(/undecodable protobuf/i);
  });

  // Guards against leaving a temp handle open on a non-existent file path.
  it('does not create the db file when it is absent', () => {
    reader.decode(dbPathFor('nope'), 'nope');
    expect(fs.existsSync(dbPathFor('nope'))).toBe(false);
  });

  // Token-decode parity vs a KNOWN sanitized sample built via the shared fixture builder.
  // Closes the P1-11 "parity vs known sample" gap and exercises a per-variant internal id
  // (`gemini-3.5-flash-high`) end-to-end through the decoder.
  it('decodes token usage from a sanitized fixture-built .db (parity vs known sample)', () => {
    createAntigravityFixtureDb(dbPathFor(), CONV, [
      {
        input: 1500,
        output: 120,
        modelId: 'gemini-3.5-flash-high',
        display: 'Gemini 3.5 Flash (High)',
      },
      {
        input: 2500,
        output: 80,
        modelId: 'gemini-3.5-flash-high',
        display: 'Gemini 3.5 Flash (High)',
      },
    ]);

    const m = reader.decode(dbPathFor(), CONV);
    expect(m.warnings).toEqual([]);
    expect(m.inputTokens).toBe(4000);
    expect(m.outputTokens).toBe(200);
    expect(m.generationCount).toBe(2);
    expect(m.lastContextTokens).toBe(2580); // last gen 2500 + 80
    expect(m.modelId).toBe('gemini-3.5-flash-high');
    expect(m.displayName).toBe('Gemini 3.5 Flash (High)');
  });

  it('decodes a free GPT-OSS sample without warnings and keeps tokens authoritative', () => {
    createAntigravityFixtureDb(dbPathFor(), CONV, [
      {
        input: 900,
        output: 60,
        modelId: 'gpt-oss-120b-medium',
        display: 'GPT-OSS 120B (Medium)',
      },
    ]);
    const m = reader.decode(dbPathFor(), CONV);
    expect(m.warnings).toEqual([]);
    expect(m.inputTokens).toBe(900);
    expect(m.outputTokens).toBe(60);
    expect(m.modelId).toBe('gpt-oss-120b-medium');
  });
});
