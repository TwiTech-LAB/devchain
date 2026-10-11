import { Header, type HeaderData } from 'tar';

const BLOCK = 512;

/** A tar stream of the entries, whose contents are UTF-8 text, ended by the two zero blocks. */
export function tarArchive(records: Array<HeaderData & { contents: string }>): Buffer {
  return Buffer.concat([
    ...records.flatMap(({ contents, ...entry }) => {
      const header = new Header({ ...entry, size: Buffer.byteLength(contents) });
      header.encode();
      const body = Buffer.alloc(Math.ceil(Buffer.byteLength(contents) / BLOCK) * BLOCK);
      body.write(contents);
      return [header.block!, body];
    }),
    Buffer.alloc(2 * BLOCK),
  ]);
}

/** The owners, mode and text contents of each entry; an invalid header checksum throws. */
export function tarEntries(archive: Buffer) {
  const entries = [];
  for (let offset = 0; offset < archive.length; ) {
    const header = new Header(archive, offset);
    if (header.nullBlock) break;
    if (!header.cksumValid) throw new Error(`Invalid tar header checksum at ${offset}`);
    entries.push({
      path: header.path,
      uid: header.uid,
      gid: header.gid,
      mode: header.mode,
      contents: archive.subarray(offset + BLOCK, offset + BLOCK + (header.size ?? 0)).toString(),
    });
    offset += BLOCK + Math.ceil((header.size ?? 0) / BLOCK) * BLOCK;
  }
  return entries;
}
