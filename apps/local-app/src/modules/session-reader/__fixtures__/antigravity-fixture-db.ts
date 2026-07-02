/**
 * Sanitized agy (Antigravity) fixture builder — programmatic, NOT a checked-in binary.
 *
 * Mirrors the `opencode-fixture-db.ts` pattern (a TS builder that mints a real-schema
 * SQLite container in WAL mode) so the fixture is auditable and contains NO real user
 * content / secrets / paths. Produces a `conversations/<convId>.db` whose `gen_metadata`
 * rows carry protobuf `Usage` blobs (field `1.4`: `2`=input, `3`=output), a model id
 * (`1.19`), and a display name (`1.21`) — exactly what `AntigravityMetricsReader` decodes.
 *
 * The protobuf encoder is the test-only wire format shared with
 * `antigravity-metrics.reader.spec.ts`; kept here so fixture-driven parity tests resolve
 * token usage against a KNOWN sample (the keystone of fail-loud metrics correctness).
 */
import Database from 'better-sqlite3';

// ---- test-only protobuf encoder (mirrors the production wire decoder) ----

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

const tag = (field: number, wireType: number): Buffer => varint(field * 8 + wireType);
const vField = (field: number, n: number): Buffer => Buffer.concat([tag(field, 0), varint(n)]);
const lenField = (field: number, buf: Buffer): Buffer =>
  Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const strField = (field: number, s: string): Buffer => lenField(field, Buffer.from(s, 'utf8'));

/**
 * Build a `gen_metadata` blob:
 * `wrapper(1){ usage(4){ 2=input, 3=output }, 19=modelId, 21=displayName }`.
 */
export function genMetadataBlob(
  input: number,
  output: number,
  modelId = 'gemini-3-flash-a',
  display = 'Gemini 3.5 Flash (High)',
): Buffer {
  const usage = Buffer.concat([vField(2, input), vField(3, output)]);
  const wrapper = Buffer.concat([lenField(4, usage), strField(19, modelId), strField(21, display)]);
  return lenField(1, wrapper);
}

/** One model-generation row (per-call token usage). */
export interface AgyFixtureGen {
  input: number;
  output: number;
  modelId?: string;
  display?: string;
  /** Override the whole blob (for fail-loud / version-drift fixtures). */
  rawBlob?: Buffer;
}

export interface AgyFixtureDbOptions {
  /**
   * The cascade id recorded in `trajectory_meta`. Defaults to `convId` so the
   * metrics reader's conversation-id guard passes; pass a mismatch to exercise
   * the fail-loud id-mismatch path.
   */
  cascadeId?: string;
}

/**
 * Create a sanitized `conversations/<convId>.db` at `dbPath` with the agy schema and
 * one `gen_metadata` row per generation. Tables are only created when `gens` is non-empty
 * (pass `{ gens: [] }` to exercise the "no generation metadata" fail-loud path).
 */
export function createAntigravityFixtureDb(
  dbPath: string,
  convId: string,
  gens: AgyFixtureGen[],
  opts: AgyFixtureDbOptions = {},
): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE trajectory_meta(trajectory_id TEXT, cascade_id TEXT, trajectory_type INT, source INT)',
  );
  db.exec('CREATE TABLE gen_metadata(idx INT, data BLOB, size INT)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?,?,?)').run(
    'internal-trajectory-id',
    opts.cascadeId ?? convId,
    4,
    17,
  );
  const ins = db.prepare('INSERT INTO gen_metadata VALUES (?,?,?)');
  gens.forEach((g, idx) => {
    const blob = g.rawBlob ?? genMetadataBlob(g.input, g.output, g.modelId, g.display);
    ins.run(idx, blob, blob.length);
  });
  db.close();
}
