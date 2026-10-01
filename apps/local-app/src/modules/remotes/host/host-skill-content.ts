import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

export const HOME_SKILL_CONTENT_LIMIT = 20 * 1024 * 1024;

/** Extraction stays isolated until every entry and both size limits have passed. */
export async function unpackHomeSkillContent(stream: Readable, root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const temporary = await fs.mkdtemp(join(root, '.upload-'));
  let received = 0;
  let expanded = 0;
  let refusal: Error | undefined;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received > HOME_SKILL_CONTENT_LIMIT
          ? new PayloadTooLargeException('Skill archive exceeds 20 MB')
          : null,
        chunk,
      );
    },
  });
  const extractor = tar.x({
    cwd: temporary,
    strict: true,
    preservePaths: true,
    filter(path, entry) {
      expanded += entry.size;
      const parts = path.split('/');
      if (expanded > HOME_SKILL_CONTENT_LIMIT)
        refusal = new PayloadTooLargeException('Unpacked skills exceed 20 MB');
      else if (
        isAbsolute(path) ||
        path.includes('\\') ||
        parts.includes('..') ||
        parts[0] !== 'skills' ||
        !('type' in entry) ||
        !['File', 'Directory'].includes(entry.type)
      )
        refusal = new BadRequestException(
          'Archive must contain only files and directories under skills/',
        );
      if (refusal) {
        counter.destroy(refusal);
        return false;
      }
      return true;
    },
  });
  const onStreamError = (error: Error): void => {
    counter.destroy(error);
  };
  stream.on('error', onStreamError);
  stream.pipe(counter);
  try {
    await pipeline(counter, extractor);
    if (refusal) throw refusal;
    if (!(await fs.stat(join(temporary, 'skills'))).isDirectory())
      throw new BadRequestException('Archive requires skills/');
    return temporary;
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    if (refusal) throw refusal;
    if (error instanceof PayloadTooLargeException || error instanceof BadRequestException)
      throw error;
    throw new BadRequestException('Invalid skill archive');
  } finally {
    stream.unpipe(counter);
    stream.off('error', onStreamError);
    stream.resume();
  }
}

export async function swapHomeSkillContent(
  temporary: string,
  destination: string,
  assertCurrent: () => void,
  afterSwap?: () => Promise<void>,
): Promise<void> {
  const aside = `${temporary}.old`;
  let movedOld = false;
  let installed = false;
  try {
    assertCurrent();
    try {
      await fs.rename(destination, aside);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    assertCurrent();
    await fs.rename(temporary, destination);
    installed = true;
    assertCurrent();
    await afterSwap?.();
  } catch (error) {
    if (installed) await fs.rename(destination, temporary);
    if (movedOld) await fs.rename(aside, destination);
    throw error;
  }
  // The new copy is committed. A failed cleanup must not turn a successful swap into a refused upload.
  if (movedOld) await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
}
