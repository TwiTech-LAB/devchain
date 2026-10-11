import { Transform, type TransformCallback } from 'node:stream';
import { Header, types } from 'tar';

export interface DockerArchiveOwnerIds {
  readonly uid: number;
  readonly gid: number;
}
export interface DockerArchiveOwnerMapping {
  readonly from: DockerArchiveOwnerIds;
  readonly to: DockerArchiveOwnerIds;
}
export interface DockerArchiveOwnerResult {
  readonly alreadyTargetEntries: number;
}

export const MAX_DOCKER_ARCHIVE_PAX_BYTES = 1024 * 1024;
const BLOCK = 512;
type Dimension = { readonly from: number; readonly to: number };
type PaxFields = Partial<Record<'uid' | 'gid' | 'size', number | null>>;
type State =
  | { kind: 'header'; block: Buffer; used: number }
  | { kind: 'body'; remaining: number }
  | { kind: 'pax'; block: Buffer; header: Header; body: Buffer; used: number; remaining: number }
  | { kind: 'tail' };

function headerState(): State {
  return { kind: 'header', block: Buffer.alloc(BLOCK), used: 0 };
}
function size(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid Docker tar entry size');
  return value;
}
function padded(length: number): number {
  return Math.ceil(length / BLOCK) * BLOCK;
}
function mapId(value: number | undefined, dimension?: Dimension): number | undefined {
  return dimension && value === dimension.from ? dimension.to : value;
}

// Repacking an entry would normalize unrelated metadata. Copy only changed
// numeric fields from tar's encoder and recalculate the original block's checksum.
function mappedHeader(
  block: Buffer,
  header: Header,
  uid?: Dimension,
  gid?: Dimension,
  length = header.size,
): Buffer {
  const nextUid = mapId(header.uid, uid);
  const nextGid = mapId(header.gid, gid);
  if (nextUid === header.uid && nextGid === header.gid && length === header.size) return block;
  const encoded = new Header({ uid: nextUid, gid: nextGid, size: length });
  encoded.encode();
  const result = Buffer.from(block);
  if (nextUid !== header.uid) encoded.block!.copy(result, 108, 108, 116);
  if (nextGid !== header.gid) encoded.block!.copy(result, 116, 116, 124);
  if (length !== header.size) encoded.block!.copy(result, 124, 124, 136);
  result.fill(0x20, 148, 156);
  const checksum = result.reduce((sum, byte) => sum + byte, 0);
  result.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return result;
}

function paxRecord(key: string, value: number): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

function rewritePax(body: Buffer, fields: PaxFields, uid?: Dimension, gid?: Dimension): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < body.length; ) {
    const space = body.indexOf(0x20, offset);
    const digits = body.subarray(offset, space).toString('ascii');
    const length = /^\d+$/.test(digits) ? Number(digits) : NaN;
    const end = offset + length;
    const equals = body.indexOf(0x3d, space + 1);
    if (
      space < offset ||
      !Number.isSafeInteger(length) ||
      end > body.length ||
      equals <= space ||
      equals >= end - 1 ||
      body[end - 1] !== 0x0a
    )
      throw new Error('Invalid Docker tar PAX record');
    const key = body.subarray(space + 1, equals).toString('utf8');
    let record = body.subarray(offset, end);
    if (key === 'uid' || key === 'gid' || key === 'size') {
      const text = body.subarray(equals + 1, end - 1).toString('ascii');
      const value = text === '' ? null : Number(text);
      if (value !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(value)))
        throw new Error('Invalid Docker tar PAX numeric field');
      fields[key] = value;
      let dimension: Dimension | undefined;
      if (key === 'uid') dimension = uid;
      else if (key === 'gid') dimension = gid;
      if (dimension && value === dimension.from) record = paxRecord(key, dimension.to);
    }
    parts.push(record);
    offset = end;
  }
  return Buffer.concat(parts);
}

/**
 * Equal ids pass through without tar validation; mapped streams check framing.
 * Await the full source→transform→destination pipeline before accepting result:
 * a finished transform does not prove the destination accepted the archive.
 */
export class DockerArchiveOwnerTransform extends Transform {
  private readonly uid?: Dimension;
  private readonly gid?: Dimension;
  private state: State = headerState();
  private local: PaxFields = {};
  private global: PaxFields = {};
  private count = 0;
  private completed?: DockerArchiveOwnerResult;

  constructor(mapping: DockerArchiveOwnerMapping) {
    super();
    for (const ids of [mapping.from, mapping.to])
      for (const id of [ids.uid, ids.gid])
        if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid Docker tar owner id');
    if (mapping.from.uid !== mapping.to.uid)
      this.uid = { from: mapping.from.uid, to: mapping.to.uid };
    if (mapping.from.gid !== mapping.to.gid)
      this.gid = { from: mapping.from.gid, to: mapping.to.gid };
  }

  get result(): DockerArchiveOwnerResult | undefined {
    return this.completed;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (!this.uid && !this.gid) this.push(chunk);
      else this.consume(chunk);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Cannot rewrite Docker tar owners'));
    }
  }

  override _flush(callback: TransformCallback): void {
    if (
      (this.state.kind === 'header' && this.state.used > 0) ||
      (this.state.kind !== 'header' && this.state.kind !== 'tail')
    ) {
      callback(new Error('Truncated Docker tar archive'));
      return;
    }
    this.completed = { alreadyTargetEntries: this.count };
    callback();
  }

  private consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const state = this.state;
      if (state.kind === 'tail') {
        this.push(chunk.subarray(offset));
        return;
      }
      if (state.kind === 'header') {
        const length = Math.min(BLOCK - state.used, chunk.length - offset);
        chunk.copy(state.block, state.used, offset, offset + length);
        state.used += length;
        offset += length;
        if (state.used === BLOCK) this.header(state.block);
      } else {
        const length = Math.min(state.remaining, chunk.length - offset);
        const part = chunk.subarray(offset, offset + length);
        if (state.kind === 'pax') {
          part.copy(state.body, state.used);
          state.used += length;
        } else this.push(part);
        state.remaining -= length;
        offset += length;
        if (state.remaining === 0) {
          if (state.kind === 'pax') this.pax(state);
          this.state = headerState();
        }
      }
    }
  }

  private header(block: Buffer): void {
    const header = new Header(block);
    if (header.nullBlock) {
      this.push(block);
      this.state = { kind: 'tail' };
      return;
    }
    if (!header.cksumValid) throw new Error('Invalid Docker tar header checksum');
    let length = size(header.size);
    if (header.typeKey === 'x' || header.typeKey === 'g' || header.typeKey === 'X') {
      if (length > MAX_DOCKER_ARCHIVE_PAX_BYTES)
        throw new Error('Docker tar PAX metadata exceeds the 1 MiB limit');
      const state: State = {
        kind: 'pax',
        block,
        header,
        body: Buffer.alloc(padded(length)),
        used: 0,
        remaining: padded(length),
      };
      if (state.remaining) this.state = state;
      else {
        this.pax(state);
        this.state = headerState();
      }
      return;
    }
    if (header.typeKey !== 'Unsupported' && types.normalFsTypes.has(header.typeKey)) {
      const effective = (key: 'uid' | 'gid' | 'size'): number | undefined =>
        Object.hasOwn(this.local, key)
          ? (this.local[key] ?? header[key])
          : (this.global[key] ?? header[key]);
      if (
        (this.uid && effective('uid') === this.uid.to) ||
        (this.gid && effective('gid') === this.gid.to)
      )
        this.count++;
      if (header.typeKey !== '5') length = size(effective('size'));
      this.local = {};
    }
    this.push(mappedHeader(block, header, this.uid, this.gid));
    this.state = length ? { kind: 'body', remaining: padded(length) } : headerState();
  }

  private pax(state: Extract<State, { kind: 'pax' }>): void {
    const original = state.body;
    const fields: PaxFields = {};
    const body = rewritePax(original.subarray(0, state.header.size), fields, this.uid, this.gid);
    const target = state.header.typeKey === 'g' ? this.global : this.local;
    for (const key of ['uid', 'gid', 'size'] as const) {
      if (!Object.hasOwn(fields, key)) continue;
      if (fields[key] === null && state.header.typeKey === 'g') delete target[key];
      else target[key] = fields[key];
    }
    this.push(mappedHeader(state.block, state.header, this.uid, this.gid, body.length));
    this.push(body);
    this.push(
      body.length === state.header.size
        ? original.subarray(body.length)
        : Buffer.alloc(padded(body.length) - body.length),
    );
  }
}
