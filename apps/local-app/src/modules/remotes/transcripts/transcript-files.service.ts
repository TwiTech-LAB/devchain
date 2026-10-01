import { Inject, Injectable } from '@nestjs/common';
import { ValidationError, ConflictError } from '../../../common/errors/error-types';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sessions, agents } from '../../storage/db/schema';
import {
  TranscriptPathValidator,
  isWithin,
} from '../../session-reader/services/transcript-path-validator.service';
import {
  CLAUDE_COMPANION_FOLDERS,
  TranscriptFileSchema,
  TranscriptRefSchema,
  TRANSCRIPT_MAX_BYTES,
  type TranscriptFile,
  type TranscriptRef,
  type TranscriptListing,
} from './transcript-transfer.dto';

@Injectable()
export class TranscriptFilesService {
  private readonly writing = new Set<string>();

  constructor(
    private readonly validator: TranscriptPathValidator,
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
  ) {}

  /**
   * The project's recorded transcripts. A record whose path lies outside the provider
   * root or has an unexpected name is counted in `skipped`, not thrown: one such row
   * must not block every Connect and Disconnect of the project.
   */
  projectRefs(projectId: string): { refs: TranscriptRef[]; skipped: number } {
    let skipped = 0;
    const refs = this.db
      .select({ path: sessions.transcriptPath, provider: sessions.providerNameAtLaunch })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(eq(agents.projectId, projectId))
      .all()
      .flatMap((row) => {
        if (!row.path || (row.provider !== 'claude' && row.provider !== 'codex')) return [];
        try {
          const absolute = this.validator.validateShape(row.path, row.provider);
          const path = relative(this.validator.root(row.provider), absolute);
          return [
            TranscriptRefSchema.parse({
              provider: row.provider,
              path: row.provider === 'claude' ? path.replace(/\.jsonl$/, '') : path,
            }),
          ];
        } catch {
          skipped++;
          return [];
        }
      });
    return { refs, skipped };
  }

  path(file: TranscriptFile): string {
    TranscriptFileSchema.parse(file);
    return this.validator.validateShape(
      join(this.validator.root(file.provider), file.path),
      file.provider,
    );
  }

  async list(refs: TranscriptRef[]): Promise<TranscriptListing> {
    const files = new Map<string, TranscriptListing['files'][number]>();
    let missing = 0;
    for (const ref of refs) {
      TranscriptRefSchema.parse(ref);
      const main: TranscriptFile = {
        provider: ref.provider,
        path: ref.path + (ref.provider === 'claude' ? '.jsonl' : ''),
      };
      if (!(await this.addFile(files, main))) missing++;
      if (ref.provider !== 'claude') continue;
      for (const folder of CLAUDE_COMPANION_FOLDERS) {
        const dir = join(this.validator.root('claude'), ref.path, folder);
        if (!(await this.regularAncestors(dir, this.validator.root('claude')))) continue;
        let names: string[];
        try {
          if (!(await lstat(dir)).isDirectory()) continue;
          const actual = await realpath(dir);
          if (!isWithin(this.validator.root('claude'), actual)) continue;
          names = await readdir(dir);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        for (const name of names) {
          const file = TranscriptFileSchema.safeParse({
            provider: 'claude',
            path: `${ref.path}/${folder}/${name}`,
          });
          if (file.success) await this.addFile(files, file.data);
        }
      }
    }
    return {
      files: [...files.values()].sort((a, b) => a.file.path.localeCompare(b.file.path)),
      missing,
    };
  }

  private async addFile(
    files: Map<string, TranscriptListing['files'][number]>,
    file: TranscriptFile,
  ): Promise<boolean> {
    const path = this.path(file);
    if (!(await this.regularAncestors(path, this.validator.root(file.provider)))) return false;
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!stat.isFile()) return false;
    await this.validator.validateForRead(path, file.provider);
    files.set(`${file.provider}:${file.path}`, { file, size: stat.size });
    return true;
  }

  async read(file: TranscriptFile): Promise<{ stream: Readable; size: number }> {
    const path = this.path(file);
    if (!(await this.regularAncestors(path, this.validator.root(file.provider))))
      throw new ValidationError('Transcript contains a symlink or is missing');
    await this.validator.validateForRead(path, file.provider);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ValidationError('Transcript is not a regular file');
      return { stream: handle.createReadStream(), size: stat.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async write(
    file: TranscriptFile,
    body: Readable,
    size: number,
    signal?: AbortSignal,
  ): Promise<void> {
    assertTranscriptSize(size);
    const target = this.path(file);
    if (this.writing.has(target))
      throw new ConflictError('Transcript transfer already in progress');
    this.writing.add(target);
    // Network streams can fail while the destination directories are being prepared.
    const earlyError = () => undefined;
    body.on('error', earlyError);
    const part = join(
      dirname(target),
      `.${createHash('sha256').update(basename(target)).digest('hex')}.part`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let ownsPart = false;
    try {
      await this.prepareTarget(target, this.validator.root(file.provider));
      // A crash may leave a part file. Recreate it so hard links cannot overwrite another file.
      await unlink(part).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      handle = await open(
        part,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      ownsPart = true;
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > size ? new ValidationError('Transcript exceeds Content-Length') : null,
            chunk,
          );
        },
      });
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          void handle!.writeFile(chunk).then(() => callback(), callback);
        },
      });
      await pipeline(body, counter, output, { signal });
      if (bytes !== size) throw new ValidationError('Transcript shorter than Content-Length');
      signal?.throwIfAborted();
      await handle.sync();
      await handle.close();
      handle = undefined;
      signal?.throwIfAborted();
      await this.prepareTarget(target, this.validator.root(file.provider));
      signal?.throwIfAborted();
      await rename(part, target);
    } finally {
      try {
        try {
          await handle?.close();
        } finally {
          if (ownsPart)
            await unlink(part).catch((error: unknown) => {
              if (!isMissing(error)) throw error;
            });
        }
      } finally {
        this.writing.delete(target);
        body.off('error', earlyError);
      }
    }
  }

  private async prepareTarget(target: string, root: string): Promise<void> {
    let ancestor = dirname(target);
    while (true) {
      try {
        const actual = await realpath(ancestor);
        // Missing provider roots may be created beneath their real, non-symlink parent.
        if (isWithin(root, ancestor)) {
          if (!isWithin(root, actual))
            throw new ValidationError('Transcript ancestor escapes provider root');
        } else if (actual !== ancestor)
          throw new ValidationError('Transcript root ancestor is a symlink');
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        ancestor = dirname(ancestor);
      }
    }
    if (!(await this.regularAncestors(target, root, true)))
      throw new ValidationError('Transcript path contains a symlink or non-regular file');
    await mkdir(dirname(target), { recursive: true });
  }

  private async regularAncestors(
    target: string,
    root: string,
    allowMissing = false,
  ): Promise<boolean> {
    let current = root;
    for (const segment of ['', ...relative(current, target).split(sep)]) {
      current = segment ? join(current, segment) : current;
      try {
        const stat = await lstat(current);
        if (
          stat.isSymbolicLink() ||
          (current !== target && !stat.isDirectory()) ||
          (current === target && !stat.isDirectory() && !stat.isFile())
        )
          return false;
      } catch (error) {
        if (isMissing(error)) return allowMissing;
        throw error;
      }
    }
    if (allowMissing) {
      try {
        if (!(await lstat(target)).isFile()) return false;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return true;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function assertTranscriptSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > TRANSCRIPT_MAX_BYTES)
    throw new ValidationError('Content-Length must be between 0 and 1 GiB');
}
