import { Injectable } from '@nestjs/common';
import { SerialQueue } from '../../common/serial-queue';
import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AppError,
  NotFoundError,
  StorageError,
  ValidationError,
} from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { RuntimeDirectoryService, runtimeSessionDirectory } from './runtime-directory.service';
import {
  existingImageDirectories,
  isImageName,
  isImagePartial,
  prepareImageDirectory,
} from './session-image-files';

const logger = createLogger('SessionImageStore');

export const SESSION_IMAGE_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  sessionBytes: 64 * 1024 * 1024,
  sessionFiles: 64,
  instanceBytes: 256 * 1024 * 1024,
  instanceFiles: 1024,
  concurrentUploads: 4,
  pixels: 32_000_000,
} as const;

export interface SessionImageReceipt {
  attachmentId: string;
  mimeType: 'image/png' | 'image/jpeg';
  size: number;
}

@Injectable()
export class SessionImageStore {
  private readonly writes = new SerialQueue();

  constructor(private readonly runtime: RuntimeDirectoryService) {}

  /** Body reception and image decoding happen outside this per-instance quota boundary. */
  publish(
    sessionId: string,
    bytes: Buffer,
    mimeType: SessionImageReceipt['mimeType'],
    assertLive: () => void,
    abandoned: AbortSignal,
    signal = abandoned,
  ): Promise<SessionImageReceipt> {
    const result = this.writes.run(async () => {
      assertLive();
      await this.checkQuota(sessionId, bytes.length, signal);
      const root = (await this.runtime.resolve()).path;
      const directory = await prepareImageDirectory(root, runtimeSessionDirectory(root, sessionId));
      const id = randomUUID();
      const attachmentId = id + (mimeType === 'image/png' ? '.png' : '.jpg');
      const part = join(directory, `.${id}.part`);
      const path = join(directory, attachmentId);
      const discard = (file: string) =>
        rm(file, { force: true }).catch(() =>
          logger.warn({ sessionId }, 'Could not discard an abandoned session image'),
        );
      let published = false;
      const handle = await open(part, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(bytes, { signal });
          await handle.chmod(0o400);
        } finally {
          await handle.close();
        }
        assertLive();
        await rename(part, path);
        published = true;
        assertLive();
        // The HTTP disconnect signal is disarmed at response finish. Until then, its
        // caller can still abandon a completed file without ever receiving the reference.
        abandoned.addEventListener(
          'abort',
          () => {
            void discard(path);
          },
          { once: true },
        );
        return { attachmentId, mimeType, size: bytes.length };
      } catch (error) {
        await discard(published ? path : part);
        throw error;
      }
    }, signal);
    return result.catch((error: unknown) => {
      if (signal.aborted) assertLive();
      if (error instanceof AppError) throw error;
      throw new StorageError('Could not store the session image');
    });
  }

  /** Resolves only completed, generated files belonging to this session on this instance. */
  async resolvePath(sessionId: string, attachmentId: string): Promise<string> {
    if (!isImageName(attachmentId)) throw new ValidationError('Invalid image reference');
    try {
      for await (const item of existingImageDirectories(this.runtime.instanceRoots(), sessionId)) {
        const path = join(item.directory, attachmentId);
        const stat = await lstat(path).catch(ignoreMissing);
        if (stat?.isFile()) return path;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new StorageError('Session image storage is unavailable');
    }
    throw new NotFoundError('Session image');
  }

  private async checkQuota(
    sessionId: string,
    incoming: number,
    signal: AbortSignal,
  ): Promise<void> {
    let sessionBytes = incoming;
    let sessionFiles = 1;
    let instanceBytes = incoming;
    let instanceFiles = 1;
    for await (const item of existingImageDirectories(this.runtime.instanceRoots())) {
      const entries = await readdir(item.directory, { withFileTypes: true }).catch(ignoreMissing);
      for (const entry of entries ?? []) {
        signal.throwIfAborted();
        if (!entry.isFile() || (!isImageName(entry.name) && !isImagePartial(entry.name))) continue;
        const stat = await lstat(join(item.directory, entry.name)).catch(ignoreMissing);
        if (!stat?.isFile()) continue;
        instanceBytes += stat.size;
        instanceFiles++;
        if (item.sessionId === sessionId) {
          sessionBytes += stat.size;
          sessionFiles++;
        }
        if (
          sessionBytes > SESSION_IMAGE_LIMITS.sessionBytes ||
          sessionFiles > SESSION_IMAGE_LIMITS.sessionFiles ||
          instanceBytes > SESSION_IMAGE_LIMITS.instanceBytes ||
          instanceFiles > SESSION_IMAGE_LIMITS.instanceFiles
        ) {
          throw new AppError(
            'Session image storage limit reached',
            'session_image_storage_limit',
            413,
          );
        }
      }
    }
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw new StorageError('Session image storage is unavailable');
}
