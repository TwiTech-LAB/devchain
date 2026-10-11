// Pure streams catch header/metadata corruption and backpressure without an engine.
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Header, list, Pax, type HeaderData } from 'tar';
import {
  DockerArchiveOwnerTransform,
  MAX_DOCKER_ARCHIVE_PAX_BYTES,
  type DockerArchiveOwnerMapping,
} from './docker-archive-owners';

const home = { uid: 1000, gid: 1000 };
const vm = { uid: 10001, gid: 10002 };
const time = new Date('2020-03-04T05:06:07.000Z');
const payload = Buffer.from([0, 255, 127, 10, 0, 1]);

function entry(fields: HeaderData, body = Buffer.alloc(0)): Buffer {
  const header = new Header({ mode: 0o640, mtime: time, size: body.length, ...fields });
  header.encode();
  return Buffer.concat([header.block!, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function archive(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}
function record(key: string, value: string): Buffer {
  const content = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(content) + 1;
  while (String(length).length + Buffer.byteLength(content) !== length)
    length = String(length).length + Buffer.byteLength(content);
  return Buffer.from(`${length}${content}`);
}
const discard = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
async function rewrite(input: Buffer, mapping: DockerArchiveOwnerMapping, chunkSize = 113) {
  const transform = new DockerArchiveOwnerTransform(mapping);
  const chunks: Buffer[] = [];
  const source = Readable.from(
    (function* () {
      for (let offset = 0; offset < input.length; offset += chunkSize)
        yield input.subarray(offset, offset + chunkSize);
    })(),
  );
  await pipeline(
    source,
    transform,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  return { body: Buffer.concat(chunks), result: transform.result };
}
async function entries(input: Buffer) {
  const found: Record<
    string,
    {
      uid?: number;
      gid?: number;
      mode?: number;
      mtime?: Date;
      type: string;
      linkpath?: string;
      body: Buffer;
    }
  > = {};
  await pipeline(
    Readable.from([input]),
    list({
      strict: true,
      onReadEntry(item) {
        const chunks: Buffer[] = [];
        const saved = {
          // ReadEntry reapplies global owners after local ones; Header preserves
          // the effective local override used by POSIX/Docker extractors.
          uid: item.header.uid,
          gid: item.header.gid,
          mode: item.mode,
          mtime: item.mtime,
          type: item.type,
          linkpath: item.linkpath,
          body: Buffer.alloc(0),
        };
        found[item.path] = saved;
        item.on('data', (chunk: Buffer) => chunks.push(chunk));
        item.on('end', () => {
          saved.body = Buffer.concat(chunks);
        });
      },
    }),
  );
  return found;
}

it.each([
  ['uid only', { uid: vm.uid, gid: home.gid }],
  ['gid only', { uid: home.uid, gid: vm.gid }],
  ['both', vm],
] as const)(
  'maps %s independently and preserves other owners, modes, times and payload',
  async (_name, to) => {
    const owners = [
      home,
      { uid: 0, gid: 0 },
      { uid: 999, gid: 999 },
      { uid: 3000, gid: 4000 },
      { uid: home.uid, gid: 4000 },
      { uid: 3000, gid: home.gid },
    ];
    const input = archive(
      ...owners.map((ids, index) =>
        entry({ path: `file-${index}`, ...ids, atime: time, ctime: time }, payload),
      ),
    );
    const output = await rewrite(input, { from: home, to });
    const found = await entries(output.body);
    for (const [index, ids] of owners.entries()) {
      expect(found[`file-${index}`]).toMatchObject({
        uid: ids.uid === home.uid ? to.uid : ids.uid,
        gid: ids.gid === home.gid ? to.gid : ids.gid,
        mode: 0o640,
        mtime: time,
        body: payload,
      });
      const originalHeader = input.subarray(index * 1024, index * 1024 + 512);
      const mapped = output.body.subarray(index * 1024, index * 1024 + 512);
      expect(mapped.subarray(0, 108)).toEqual(originalHeader.subarray(0, 108));
      expect(mapped.subarray(124, 148)).toEqual(originalHeader.subarray(124, 148));
      expect(mapped.subarray(156)).toEqual(originalHeader.subarray(156));
    }
    expect(output.result).toEqual({ alreadyTargetEntries: 0 });
  },
);

it.each([
  ['mixed and both target', vm, [{ uid: vm.uid, gid: home.gid }, vm], 2],
  [
    'unchanged gid does not count',
    { uid: vm.uid, gid: home.gid },
    [home, { uid: 999, gid: home.gid }],
    0,
  ],
  [
    'unchanged uid does not count',
    { uid: home.uid, gid: vm.gid },
    [home, { uid: home.uid, gid: 999 }],
    0,
  ],
] as const)('counts logical entries once: %s', async (_name, to, owners, expected) => {
  const output = await rewrite(
    archive(...owners.map((ids, index) => entry({ path: `file-${index}`, ...ids }, payload))),
    { from: home, to },
  );
  expect(output.result).toEqual({ alreadyTargetEntries: expected });
  expect((await entries(output.body))['file-0']).toMatchObject(to);
});

it('maps directories, hardlinks, symlinks and base-256 numeric owner headers without rewriting their metadata', async () => {
  const from = { uid: 3_000_000, gid: 4_000_000 };
  const to = { uid: 5_000_000, gid: 6_000_000 };
  const input = archive(
    entry({ path: 'data/', type: 'Directory', mode: 0o700, ...from }),
    entry({ path: 'data/file', ...from }, payload),
    entry({ path: 'data/hard', type: 'Link', linkpath: 'data/file', ...from }),
    entry({ path: 'data/soft', type: 'SymbolicLink', linkpath: 'file', mode: 0o777, ...from }),
  );
  const output = await rewrite(input, { from, to }, 1);
  const found = await entries(output.body);
  expect(found['data/']).toMatchObject({ ...to, type: 'Directory', mode: 0o700 });
  expect(found['data/file']).toMatchObject({ ...to, body: payload });
  expect(found['data/hard']).toMatchObject({ ...to, type: 'Link', linkpath: 'data/file' });
  expect(found['data/soft']).toMatchObject({
    ...to,
    type: 'SymbolicLink',
    linkpath: 'file',
    mode: 0o777,
  });
  expect(output.body[108] & 0x80).toBe(0x80);
  expect(output.result).toEqual({ alreadyTargetEntries: 0 });
});

it('preserves long PAX names, local/global owner overrides and unrelated byte-exact PAX records', async () => {
  const long = `data/${'long-'.repeat(60)}é`;
  const custom = record('SCHILY.xattr.user.note', 'arbitrary=é\nmetadata');
  const local = Buffer.concat([
    record('path', long),
    record('uid', String(vm.uid)),
    record('gid', String(home.gid)),
    record('mtime', '1583298367.125'),
    custom,
  ]);
  const input = archive(
    new Pax({ uid: home.uid, gid: home.gid }, true).encode(),
    entry({ path: 'PaxHeader/local', type: 'ExtendedHeader', uid: vm.uid, gid: vm.gid }, local),
    entry({ path: 'short', uid: 999, gid: 999 }, payload),
    new Pax({ uid: 999, gid: 999 }).encode(),
    entry({ path: 'service', ...home }, payload),
    entry({ path: 'global', uid: 999, gid: 999 }, payload),
  );
  const output = await rewrite(input, { from: home, to: vm });
  const found = await entries(output.body);
  expect(found[long]).toMatchObject({
    ...vm,
    body: payload,
    mtime: new Date('2020-03-04T05:06:07.125Z'),
  });
  expect(found.service).toMatchObject({ uid: 999, gid: 999, body: payload });
  expect(found.global).toMatchObject({ ...vm, body: payload });
  expect(output.body.includes(custom)).toBe(true);
  expect(output.body.includes(record('mtime', '1583298367.125'))).toBe(true);
  expect(output.result).toEqual({ alreadyTargetEntries: 1 });
});

it('respects PAX size overrides and preserves the payload and trailing bytes on return', async () => {
  const content = Buffer.alloc(1025, 0xaa);
  const file = entry({ path: 'file', ...home }, content);
  const misleading = new Header({ path: 'file', ...home, mode: 0o600, size: 0 });
  misleading.encode();
  misleading.block!.copy(file, 0);
  const trailer = Buffer.from('whole-stream trailer bytes');
  const raw = Buffer.concat([archive(new Pax({ size: content.length }).encode(), file), trailer]);
  const output = await rewrite(raw, { from: home, to: vm });
  const restored = await rewrite(output.body, { from: vm, to: home });
  expect(restored.body.subarray(-trailer.length)).toEqual(trailer);
  expect((await entries(restored.body)).file).toMatchObject({
    ...home,
    mode: 0o600,
    body: content,
  });
});

it('passes an equal-id archive byte-for-byte with no target count', async () => {
  const raw = archive(
    new Pax({ uid: home.uid, gid: home.gid }).encode(),
    entry({ path: 'file', ...home }, payload),
  );
  expect(await rewrite(raw, { from: home, to: home })).toEqual({
    body: raw,
    result: { alreadyTargetEntries: 0 },
  });
});

it.each(['CharacterDevice', 'BlockDevice', 'FIFO', 'ContiguousFile'] as const)(
  'preserves %s entry metadata while mapping its numeric owners',
  async (type) => {
    const input = archive(entry({ path: 'special', type, ...home, devmaj: 1, devmin: 3 }));
    const output = await rewrite(input, { from: home, to: vm });
    expect(new Header(output.body)).toMatchObject({ ...vm, type, devmaj: 1, devmin: 3 });
    expect(output.body.subarray(156, 512)).toEqual(input.subarray(156, 512));
    expect(output.result).toEqual({ alreadyTargetEntries: 0 });
  },
);

it('keeps pending PAX owners across GNU extension headers without using their PAX size', async () => {
  const long = `data/${'file-'.repeat(30)}`;
  const input = archive(
    new Pax({ uid: vm.uid, gid: home.gid, size: payload.length }).encode(),
    entry({ path: 'LongName', type: 'NextFileHasLongPath', ...home }, Buffer.from(`${long}\0`)),
    entry({ path: 'short', uid: 999, gid: 999 }, payload),
  );
  const output = await rewrite(input, { from: home, to: vm });
  expect((await entries(output.body))[long]).toMatchObject({ ...vm, body: payload });
  expect(output.result).toEqual({ alreadyTargetEntries: 1 });
});

it('propagates source failures without exposing a successful result', async () => {
  const transform = new DockerArchiveOwnerTransform({ from: home, to: vm });
  const source = Readable.from(
    (function* () {
      yield entry({ path: 'file', ...home }, payload);
      throw new Error('source failed');
    })(),
  );
  await expect(pipeline(source, transform, discard())).rejects.toThrow('source failed');
  expect(transform.result).toBeUndefined();
});

it.each(['header', 'payload', 'PAX limit', 'PAX record'] as const)(
  'fails %s errors without a completed result',
  async (kind) => {
    let input = entry({ path: 'file', ...home }, payload);
    if (kind === 'header') input[0] ^= 1;
    if (kind === 'payload') input = input.subarray(0, 513);
    if (kind === 'PAX limit')
      input = entry({
        path: 'meta',
        type: 'ExtendedHeader',
        size: MAX_DOCKER_ARCHIVE_PAX_BYTES + 1,
      });
    if (kind === 'PAX record')
      input = entry({ path: 'meta', type: 'ExtendedHeader' }, Buffer.from('20 uid=1000\n'));
    const transform = new DockerArchiveOwnerTransform({ from: home, to: vm });
    await expect(pipeline(Readable.from([input]), transform, discard())).rejects.toThrow(
      /Docker tar/,
    );
    expect(transform.result).toBeUndefined();
  },
);

it('streams a large payload with downstream backpressure instead of buffering the archive', async () => {
  const block = Buffer.alloc(64 * 1024, 0xa5);
  let produced = 0;
  let release: (() => void) | undefined;
  let first: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    first = resolve;
  });
  const source = Readable.from(
    (function* () {
      yield entry({ path: 'large', ...home, size: block.length * 128 });
      for (let index = 0; index < 128; index++) {
        produced++;
        yield block;
      }
      yield Buffer.alloc(1024);
    })(),
    { objectMode: false },
  );
  let received = 0;
  const consume = pipeline(
    source,
    new DockerArchiveOwnerTransform({ from: home, to: vm }),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (!release) {
          release = done;
          first?.();
        } else done();
      },
    }),
  );
  await entered;
  expect(produced).toBeLessThan(128);
  release?.();
  await consume;
  expect(received).toBe(512 + 128 * block.length + 1024);
});
