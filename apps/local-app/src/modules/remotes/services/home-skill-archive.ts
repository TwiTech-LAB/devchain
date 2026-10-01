import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { HOME_SKILL_CONTENT_LIMIT } from '../host/host-skill-content';

export class HomeSkillArchiveTooLargeError extends Error {
  constructor() {
    super('Local skill content exceeds 20 MB');
  }
}

/** Spooling bounds both sizes before sending any bytes to a host, without buffering the archive in memory. */
export async function prepareHomeSkillArchive(
  folderPath: string,
  signal: AbortSignal,
): Promise<{ stream: Readable; dispose: () => Promise<void> }> {
  if (!(await fs.lstat(join(folderPath, 'skills'))).isDirectory())
    throw new Error('Local skills folder is unavailable');
  const temporary = await fs.mkdtemp(join(tmpdir(), 'devchain-skill-upload-'));
  const archivePath = join(temporary, 'skills.tar.gz');
  let expanded = 0;
  let received = 0;
  let refusal: Error | undefined;
  const pack = tar.c(
    {
      cwd: folderPath,
      gzip: true,
      portable: true,
      strict: true,
      filter(_path, stat) {
        if (!('isFile' in stat) || (!stat.isFile() && !stat.isDirectory())) return false;
        if (stat.isFile()) expanded += stat.size;
        if (expanded > HOME_SKILL_CONTENT_LIMIT) {
          refusal = new HomeSkillArchiveTooLargeError();
          pack.destroy(refusal);
          return false;
        }
        return true;
      },
    },
    ['skills'],
  );
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received > HOME_SKILL_CONTENT_LIMIT ? new HomeSkillArchiveTooLargeError() : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(pack, limit, createWriteStream(archivePath), { signal });
    if (refusal) throw refusal;
    const stream = createReadStream(archivePath);
    return {
      stream,
      dispose: async () => {
        stream.destroy();
        await fs.rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw refusal ?? error;
  }
}
