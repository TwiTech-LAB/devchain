import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import sharp from 'sharp';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { ensureProvider, replicaSeeder, T } from '../remotes/replica/__fixtures__/replica-seed';
import { RemoteHealthService } from '../remotes/services/remote-health.service';
import {
  SessionImageStore,
  type SessionImageReceipt,
} from '../runtime-directory/session-image-store.service';
import {
  RuntimeDirectoryService,
  runtimeSessionDirectory,
} from '../runtime-directory/runtime-directory.service';
import { TerminalSessionRegistry } from '../terminal/services/terminal-session/terminal-session-registry';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { SessionImageUploadService } from './services/session-image-upload.service';
import { SessionsService } from './services/sessions.service';

// Real HTTP parser, ownership gate, /r proxy, independent runtime roots and startup reconciliation.
describe('image staging on the session owner', () => {
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const route = `/api/sessions/${sessionId}/attachments?projectId=${projectId}`;
  const tmux = 'image-test-' + sessionId;
  let apps: TwoInstances;

  function seed(instance: TestInstance) {
    const db = replicaSeeder(instance.sqlite);
    const agent = randomUUID();
    const profile = randomUUID();
    db.seedProject(projectId);
    db.seedProfile(
      profile,
      projectId,
      ensureProvider(instance.sqlite, 'image-test-provider', 'claude', null),
    );
    db.seedAgent(agent, projectId, profile);
    db.insert('sessions', {
      id: sessionId,
      agent_id: agent,
      status: 'running',
      tmux_session_id: tmux,
      provider_name_at_launch: 'claude',
      started_at: T,
      created_at: T,
      updated_at: T,
    });
    instance.app.get(TerminalSessionRegistry).create(sessionId, tmux);
  }

  beforeAll(async () => {
    apps = await startTwoInstances({
      configureModule: (builder) =>
        builder.overrideProvider(TerminalIOService).useValue({
          sessionExists: jest.fn(async ({ name }) => name === tmux),
          startHealthCheck: jest.fn(),
          listAllSessionNames: jest.fn(async () => new Set([tmux])),
          listSessions: jest.fn(async () => []),
          destroyExpectedSession: jest.fn(async () => ({ outcome: 'destroyed' })),
        }),
    });
    seed(apps.home);
    seed(apps.host);
  });
  afterAll(async () => {
    await apps?.close();
  });

  it('publishes privately, routes chunked bytes to the VM, and keeps only completed images when a live session rehydrates', async () => {
    const { home, host } = apps;
    const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const jpeg = await sharp(png).jpeg({ progressive: true }).toBuffer();
    const post = (url: string, bytes: Buffer) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      });
    const local = await post(home.url + route, png);
    expect(local.status).toBe(201);
    const first = (await local.json()) as SessionImageReceipt;
    expect(first).toMatchObject({ mimeType: 'image/png', size: png.length });
    const path = await home.app.get(SessionImageStore).resolvePath(sessionId, first.attachmentId);
    expect(await readFile(path)).toEqual(png);
    expect((await lstat(path)).mode & 0o777).toBe(0o400);
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await post(home.url + route.replace(projectId, randomUUID()), png)).status).toBe(403);

    const remoteId = (await apps.registerRemote()).id;
    await waitForValue(
      async () => (await (await fetch(home.url + '/api/remotes')).json()).items[0]?.online,
      10_000,
    );
    await apps.bindProject(projectId, remoteId);
    expect((await post(home.url + route, png)).status).toBe(423);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(jpeg.subarray(0, 16));
        c.enqueue(jpeg.subarray(16));
        c.close();
      },
    });
    const remote = await fetch(`${home.url}/r/${remoteId}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(remote.status).toBe(201);
    const second = (await remote.json()) as SessionImageReceipt;
    expect(second).toMatchObject({ mimeType: 'image/jpeg', size: jpeg.length });
    await expect(
      home.app.get(SessionImageStore).resolvePath(sessionId, second.attachmentId),
    ).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    const remoteFile = await host.app
      .get(SessionImageStore)
      .resolvePath(sessionId, second.attachmentId);
    expect(await readFile(remoteFile)).toEqual(jpeg);
    await writeFile(join(dirname(remoteFile), `.${randomUUID()}.part`), 'interrupted');
    const restarted = await apps.restartHost();
    await home.app.get(RemoteHealthService).refresh(remoteId);
    await waitForValue(
      async () => (await fetch(`${home.url}/r/${remoteId}/api/runtime`)).ok,
      10_000,
    );
    expect(await readdir(dirname(remoteFile))).toEqual([second.attachmentId]);
    expect(
      await readFile(
        await restarted.app.get(SessionImageStore).resolvePath(sessionId, second.attachmentId),
      ),
    ).toEqual(jpeg);

    const uploads = restarted.app.get(SessionImageUploadService);
    const originalUpload = uploads.upload.bind(uploads);
    const receiving = new Promise<void>((resolve) => {
      jest.spyOn(uploads, 'upload').mockImplementationOnce((...args) => {
        args[2].once('resume', resolve);
        return originalUpload(...args);
      });
    });
    const input = new PassThrough();
    const pending = fetch(`${home.url}/r/${remoteId}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(input),
      duplex: 'half',
      signal: AbortSignal.timeout(10_000),
    } as RequestInit);
    try {
      input.write(jpeg.subarray(0, 12));
      await Promise.race([
        receiving,
        pending.then((response) => {
          throw new Error(`Upload ended before the host began reading: ${response.status}`);
        }),
      ]);
      await restarted.app
        .get(SessionsService)
        .terminateSession(sessionId, { source: 'web-api', reason: 'user-requested' });
      input.end(jpeg.subarray(12));
      const stopped = await pending;
      expect(stopped.status).toBe(409);
      const error: unknown = await stopped.json();
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'conflict',
        message: 'Agent session is no longer live',
      });
      expect(error).not.toHaveProperty('details');
    } finally {
      input.destroy();
    }
    const sessionDirectory = runtimeSessionDirectory(
      (await restarted.app.get(RuntimeDirectoryService).resolve()).path,
      sessionId,
    );
    await expect(lstat(sessionDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 45_000);
});
