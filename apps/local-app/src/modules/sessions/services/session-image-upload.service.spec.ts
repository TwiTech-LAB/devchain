import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, truncate, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  RUNTIME_DIRECTORY_HOST,
  systemRuntimeDirectoryHost,
} from '../../runtime-directory/runtime-directory';
import { RuntimeDirectoryService } from '../../runtime-directory/runtime-directory.service';
import {
  SESSION_IMAGE_LIMITS,
  SessionImageStore,
} from '../../runtime-directory/session-image-store.service';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsService } from './sessions.service';
import { SessionImageUploadService } from './session-image-upload.service';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWPwmyAEQQxwFgA5vAWhR83TqgAAAABJRU5ErkJggg==',
  'base64',
);

// A real stream and temporary runtime root exercise admission, quotas and publication together.
describe('SessionImageUploadService', () => {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  let scratch: string;
  let service: SessionImageUploadService;
  let store: SessionImageStore;
  let registry: TerminalSessionRegistry;
  let gate: ProjectWriteGate;
  let terminal: TerminalIOService;
  let coordinator: SessionCoordinatorService;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'session-images-'));
    const module = await Test.createTestingModule({
      providers: [
        SessionImageUploadService,
        SessionImageStore,
        RuntimeDirectoryService,
        SessionCoordinatorService,
        ProjectWriteGate,
        {
          provide: RUNTIME_DIRECTORY_HOST,
          useValue: { ...systemRuntimeDirectoryHost(join(scratch, 'db.sqlite')), env: () => ({}) },
        },
        { provide: TerminalSessionRegistry, useFactory: () => new TerminalSessionRegistry() },
        {
          provide: TerminalIOService,
          useValue: { sessionExists: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: SessionsService,
          useValue: {
            validateSessionInProject: jest
              .fn()
              .mockResolvedValue({ agentId: 'agent', status: 'running', tmuxSessionId: 'pane' }),
          },
        },
      ],
    }).compile();
    service = module.get(SessionImageUploadService);
    coordinator = module.get(SessionCoordinatorService);
    terminal = module.get(TerminalIOService);
    store = module.get(SessionImageStore);
    gate = module.get(ProjectWriteGate);
    registry = module.get(TerminalSessionRegistry);
    registry.create(sessionId, 'pane');
  });
  afterEach(async () => {
    registry.dispose(sessionId);
    await rm(scratch, { recursive: true, force: true });
  });

  function upload(body: Readable, length?: number, signal = new AbortController().signal) {
    return service.upload(projectId, sessionId, body, length, signal);
  }
  it.each([
    ['empty', Buffer.alloc(0), undefined, 400, 'validation_error'],
    ['incomplete PNG', png.subarray(0, -2), undefined, 400, 'validation_error'],
    [
      'invalid pixel data',
      Buffer.concat([png.subarray(0, 33), png.subarray(-12)]),
      undefined,
      400,
      'validation_error',
    ],
    ['incomplete JPEG', Buffer.from([255, 216, 255, 224]), undefined, 400, 'validation_error'],
    ['other format', Buffer.from('a text file'), undefined, 415, 'unsupported_image_format'],
    ['shorter than declared', png, png.length + 1, 400, 'validation_error'],
    ['longer than declared', png, png.length - 1, 400, 'validation_error'],
    [
      'excess declared size',
      png,
      SESSION_IMAGE_LIMITS.fileBytes + 1,
      413,
      'session_image_file_limit',
    ],
    [
      'excess actual size',
      Buffer.alloc(SESSION_IMAGE_LIMITS.fileBytes + 1),
      undefined,
      413,
      'session_image_file_limit',
    ],
  ] as const)('rejects %s before publishing', async (_case, bytes, length, statusCode, code) => {
    await expect(upload(Readable.from([bytes]), length)).rejects.toMatchObject({
      statusCode,
      code,
    });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('counts simultaneous uploads across the backend and releases capacity on cancellation', async () => {
    const controller = new AbortController();
    let probesStarted!: () => void;
    const allChecking = new Promise<void>((resolve) => (probesStarted = resolve));
    const stopped = jest.fn();
    const probe = jest.spyOn(terminal, 'sessionExists').mockImplementation((_target, signal) => {
      if (probe.mock.calls.length === SESSION_IMAGE_LIMITS.concurrentUploads) probesStarted();
      return new Promise<boolean>((resolve) =>
        signal!.addEventListener(
          'abort',
          () => {
            stopped();
            resolve(false);
          },
          { once: true },
        ),
      );
    });
    const streams = Array.from(
      { length: SESSION_IMAGE_LIMITS.concurrentUploads },
      () => new PassThrough(),
    );
    const pending = streams.map((s) =>
      expect(upload(s, undefined, controller.signal)).rejects.toMatchObject({
        statusCode: 400,
        code: 'validation_error',
        message: 'Image upload was cancelled',
      }),
    );
    const other = randomUUID();
    registry.create(other, 'pane');
    await allChecking;
    await expect(
      service.upload(
        randomUUID(),
        other,
        Readable.from([png]),
        png.length,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: 'session_image_upload_busy' });
    controller.abort();
    await Promise.all(pending);
    expect(stopped).toHaveBeenCalledTimes(streams.length);
    streams.forEach((s) => s.destroy());
    probe.mockResolvedValue(true);

    let unlock!: () => void;
    const locked = coordinator.withAgentLock(
      'agent',
      () => new Promise<void>((resolve) => (unlock = resolve)),
    );
    let waitersQueued!: () => void;
    const enqueued = new Promise<void>((resolve) => (waitersQueued = resolve));
    const acquire = coordinator.withAgentLock.bind(coordinator);
    const admission = jest
      .spyOn(coordinator, 'withAgentLock')
      .mockImplementation((agentId, fn, signal) => {
        const result = acquire(agentId, fn, signal);
        if (admission.mock.calls.length === streams.length) waitersQueued();
        return result;
      });
    const publish = jest.spyOn(store, 'publish');
    const waiting = new AbortController();
    const cancelled = streams.map(() =>
      expect(upload(Readable.from([png]), png.length, waiting.signal)).rejects.toMatchObject({
        code: 'validation_error',
      }),
    );
    await enqueued;
    waiting.abort();
    await Promise.all(cancelled);
    unlock();
    await locked;
    await expect(
      service.upload(
        randomUUID(),
        other,
        Readable.from([png]),
        png.length,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ size: png.length });
    expect(publish).toHaveBeenCalledTimes(1);
    registry.dispose(other);
  });

  it('checks the gate again after receiving the stream', async () => {
    const body = new PassThrough();
    const ready = new Promise<void>((resolve) => body.once('resume', resolve));
    const outcome = expect(upload(body)).rejects.toMatchObject({ code: 'PROJECT_FROZEN' });
    body.write(png.subarray(0, 10));
    await ready;
    gate.markFrozen(projectId, new Date().toISOString());
    body.end(png.subarray(10));
    await outcome;
    expect(await readdir(scratch)).toEqual([]);
  });

  it('discards a finalized image when the response closes before delivering its reference', async () => {
    const connection = new AbortController();
    const receipt = await upload(Readable.from([png]), png.length, connection.signal);
    const path = await store.resolvePath(sessionId, receipt.attachmentId);
    const events = watch(dirname(path), { signal: AbortSignal.timeout(3000) });
    try {
      const removed = events.next();
      connection.abort();
      await removed;
      expect(await readdir(dirname(path))).toEqual([]);
    } finally {
      await events.return?.();
    }
  });

  it('charges retained bytes on disk and serializes the last available slot', async () => {
    const first = await upload(Readable.from([png]));
    const path = await store.resolvePath(sessionId, first.attachmentId);
    await chmod(path, 0o600);
    await truncate(path, SESSION_IMAGE_LIMITS.sessionBytes - png.length);
    const results = await Promise.allSettled([
      upload(Readable.from([png])),
      upload(Readable.from([png])),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await readdir(dirname(path))).toHaveLength(2);
    await expect(store.resolvePath(randomUUID(), first.attachmentId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'not_found',
    });
    await expect(store.resolvePath(sessionId, 'unrelated')).rejects.toMatchObject({
      statusCode: 400,
      code: 'validation_error',
    });
  });

  it('bounds the number of small files and counts another session against the instance quota', async () => {
    const first = await upload(Readable.from([png]));
    const path = await store.resolvePath(sessionId, first.attachmentId);
    const dir = dirname(path);
    const others = Array.from({ length: SESSION_IMAGE_LIMITS.sessionFiles - 1 }, () =>
      join(dir, randomUUID() + '.jpg'),
    );
    await Promise.all(others.map((f) => writeFile(f, png)));
    const storageLimit = { statusCode: 413, code: 'session_image_storage_limit' };
    await expect(upload(Readable.from([png]))).rejects.toMatchObject(storageLimit);
    await truncate(others[0], SESSION_IMAGE_LIMITS.instanceBytes);
    await expect(
      store.publish(randomUUID(), png, 'image/png', () => undefined, new AbortController().signal),
    ).rejects.toMatchObject(storageLimit);
  });
});
