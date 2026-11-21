import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { isUint8Array } from 'node:util/types';
import { waitWithSignal } from '../../../common/wait-with-signal';
import {
  AppError,
  ConflictError,
  TimeoutError,
  ValidationError,
} from '../../../common/errors/error-types';
import {
  SESSION_IMAGE_LIMITS,
  SessionImageStore,
  type SessionImageReceipt,
} from '../../runtime-directory/session-image-store.service';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsService } from './sessions.service';

@Injectable()
export class SessionImageUploadService {
  private active = 0;

  constructor(
    private readonly sessions: SessionsService,
    private readonly registry: TerminalSessionRegistry,
    private readonly terminal: TerminalIOService,
    private readonly gate: ProjectWriteGate,
    private readonly coordinator: SessionCoordinatorService,
    private readonly images: SessionImageStore,
  ) {}

  async upload(
    projectId: string,
    sessionId: string,
    body: Readable,
    declaredSize: number | undefined,
    disconnected: AbortSignal,
  ): Promise<SessionImageReceipt> {
    if (this.active >= SESSION_IMAGE_LIMITS.concurrentUploads) {
      throw new AppError('Too many image uploads in progress', 'session_image_upload_busy', 503);
    }
    const instance = this.registry.get(sessionId);
    const timeout = AbortSignal.timeout(60_000);
    const signal = AbortSignal.any(
      instance ? [timeout, disconnected, instance.disposedSignal] : [timeout, disconnected],
    );
    const assertLive = () => {
      if (disconnected.aborted) throw new ValidationError('Image upload was cancelled');
      if (timeout.aborted) throw new TimeoutError('Image upload timed out');
      if (instance?.disposedSignal.aborted || this.registry.get(sessionId) !== instance) {
        throw new ConflictError('Agent session is no longer live');
      }
      this.gate.assertWritable(projectId);
    };
    // The HTTP stream can disconnect while the ownership and tmux checks are pending.
    const earlyError = () => undefined;
    body.on('error', earlyError);
    this.active++;
    try {
      if (signal.aborted) assertLive();
      const row = await waitWithSignal(
        this.sessions.validateSessionInProject(sessionId, projectId),
        signal,
      );
      assertLive();
      if (
        !instance ||
        !row.agentId ||
        row.status !== 'running' ||
        row.tmuxSessionId !== instance.tmuxSessionName
      ) {
        throw new ConflictError('Agent session is not live');
      }
      const checkPane = async () => {
        assertLive();
        const exists = await this.terminal.sessionExists(
          { name: instance.tmuxSessionName },
          signal,
        );
        assertLive();
        if (!exists) throw new ConflictError('Agent session is not live');
      };
      await checkPane();
      const bytes = await readUpload(body, declaredSize, signal, assertLive);
      const mimeType = await validateImage(bytes);
      // Termination can proceed while a slow client sends or the decoder validates its image.
      return await this.coordinator.withAgentLock(
        row.agentId,
        async () => {
          const current = await waitWithSignal(
            this.sessions.validateSessionInProject(sessionId, projectId),
            signal,
          );
          if (
            current.status !== 'running' ||
            current.agentId !== row.agentId ||
            current.tmuxSessionId !== instance.tmuxSessionName
          ) {
            throw new ConflictError('Agent session is no longer live');
          }
          await checkPane();
          return this.images.publish(sessionId, bytes, mimeType, assertLive, disconnected, signal);
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) assertLive();
      throw error;
    } finally {
      this.active--;
      body.off('error', earlyError);
    }
  }
}

function readUpload(
  body: Readable,
  length: number | undefined,
  signal: AbortSignal,
  assertLive: () => void,
): Promise<Buffer> {
  assertLive();
  if (body.destroyed || body.readableEnded) throw new ValidationError('Incomplete image upload');
  const limit = SESSION_IMAGE_LIMITS.fileBytes;
  if (length !== undefined && length > limit)
    throw new AppError('Image exceeds the file limit', 'session_image_file_limit', 413);
  if (length === 0) throw new ValidationError('Empty image upload');
  // One allocation per admitted request also bounds the overhead of many tiny chunks.
  const bytes = Buffer.allocUnsafe(length ?? limit);
  return new Promise((resolve, reject) => {
    let size = 0;
    const cleanup = () => {
      body.off('data', data).off('end', end).off('error', failed).off('close', failed);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const failed = () => fail(new ValidationError('Incomplete image upload'));
    const abort = () => {
      try {
        assertLive();
      } catch (error) {
        fail(error);
      }
    };
    const data = (chunk: unknown) => {
      if (!isUint8Array(chunk)) return failed();
      if (size + chunk.length > limit)
        return fail(new AppError('Image exceeds the file limit', 'session_image_file_limit', 413));
      if (size + chunk.length > bytes.length) return failed();
      bytes.set(chunk, size);
      size += chunk.length;
    };
    const end = () => {
      if (!size || (length !== undefined && size !== length)) return failed();
      cleanup();
      resolve(bytes.subarray(0, size));
    };
    signal.addEventListener('abort', abort, { once: true });
    body.once('end', end).once('error', failed).once('close', failed).on('data', data);
  });
}

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');

async function validateImage(bytes: Buffer): Promise<SessionImageReceipt['mimeType']> {
  const png = bytes.subarray(0, 8).equals(pngSignature);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg)
    throw new AppError('Only PNG and JPEG images are supported', 'unsupported_image_format', 415);
  if (png ? !bytes.subarray(-12).equals(pngEnd) : bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new ValidationError('Incomplete PNG or JPEG');
  }
  const { default: sharp } = await import('sharp');
  try {
    // Metadata alone can succeed with a broken image body. Force the decoder to consume the pixels.
    await sharp(bytes, { failOn: 'warning', limitInputPixels: SESSION_IMAGE_LIMITS.pixels })
      .resize(1, 1, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch {
    throw new ValidationError('Invalid image or image dimensions exceed the limit');
  }
  return png ? 'image/png' : 'image/jpeg';
}
