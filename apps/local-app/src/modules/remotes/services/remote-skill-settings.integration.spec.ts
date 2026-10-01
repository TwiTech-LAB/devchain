import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { RemoteProviderCliSettingsService } from './remote-provider-cli-settings.service';
import { ProviderCliVersionsService } from '../../providers/services/provider-cli-versions.service';
import { getAppVersion } from '../../../common/app-version';
import { REALTIME_BROADCASTER } from '../../realtime/ports/realtime-broadcaster.port';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { RemoteHealthService } from './remote-health.service';
/** Integration layer uses real SQLite, fingerprints, tar and HTTP; a fake host controls applied/pending state and failures. */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Server } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostSkillSettings, HostSkillSettingsStatus } from '@devchain/shared';
import { createReplicaDb, seedReplicaSource } from '../replica/__fixtures__/replica-seed';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { SettingsService } from '../../settings/services/settings.service';
import { LocalSkillSourceAdapter } from '../../skills/adapters/local-skill-source.adapter';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteSkillSettingsService } from './remote-skill-settings.service';
import * as homeSkillArchive from './home-skill-archive';
import { unpackHomeSkillContent } from '../host/host-skill-content';
import { Readable } from 'node:stream';
import { fixtureTls } from '../../../common/test/tls-fixture';

jest.mock('../../../common/logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  createLogger: () => jest.requireMock('../../../common/logging/logger').logger,
}));

const blank = (): HostSkillSettingsStatus => ({
  appliedRevision: null,
  pendingRevision: null,
  skipped: [],
  needsContent: [],
});
describe('home skill settings push', () => {
  let database: ReturnType<typeof createReplicaDb>;
  let storage: LocalStorageService;
  let settings: SettingsService;
  let service: RemoteSkillSettingsService;
  let host: RemoteHostClient;
  let health: RemoteHealthService;
  let server: Server;
  let remoteId: string;
  let root: string;
  let status: HostSkillSettingsStatus;
  let statusCode: number;
  let malformed: boolean;
  let pushCode: number;
  let uploadCode: number;
  let pushes: HostSkillSettings[];
  let uploads: Buffer[];
  let uploadPaths: string[];
  let holdUpload: Promise<void> | undefined;
  let releaseUpload: (() => void) | undefined;
  let uploadAttempts: number;
  beforeEach(async () => {
    jest.requireMock('../../../common/logging/logger').logger.debug.mockClear();
    database = createReplicaDb();
    seedReplicaSource(database.sqlite);
    storage = new LocalStorageService(database.db);
    root = await fs.mkdtemp(join(tmpdir(), 'skill-push-'));
    status = blank();
    statusCode = 200;
    pushCode = 202;
    uploadCode = 200;
    malformed = false;
    pushes = [];
    uploads = [];
    uploadPaths = [];
    uploadAttempts = 0;
    holdUpload = undefined;
    server = createServer(
      { key: fixtureTls.key, cert: fixtureTls.cert },
      async (request, response) => {
        const url = new URL(request.url!, 'http://host');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/api/runtime') {
          response.end(JSON.stringify({ version: getAppVersion() }));
        } else if (url.pathname === '/api/host/stats') {
          response.end(JSON.stringify({ cpuPercent: 0 }));
        } else if (url.pathname.endsWith('/status')) {
          response.writeHead(statusCode).end(JSON.stringify(malformed ? {} : status));
        } else if (url.pathname.endsWith('/content')) {
          uploadAttempts++;
          await holdUpload;
          uploads.push(Buffer.concat(chunks));
          uploadPaths.push(url.pathname);
          response.writeHead(uploadCode).end(
            JSON.stringify({
              name: url.pathname.split('/').at(-2),
              contentHash: url.searchParams.get('contentHash'),
            }),
          );
        } else {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as HostSkillSettings;
          pushes.push(body);
          response.writeHead(pushCode).end(JSON.stringify({ revision: body.revision }));
        }
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const remote = await storage.createRemote({
      kind: 'address',
      name: 'fake-host',
      baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      tlsCertificate: fixtureTls.cert,
    });
    remoteId = remote.id;
    const module = await Test.createTestingModule({
      providers: [
        RemoteApiKeyService,
        SettingsService,
        RemoteHostClient,
        RemoteSkillSettingsService,
        RemoteHealthService,
        {
          provide: RemoteProviderCliSettingsService,
          useValue: { pushIfChanged: async () => undefined },
        },
        {
          provide: ProviderCliVersionsService,
          useValue: { registerRemoteCheck: () => () => undefined },
        },
        { provide: REALTIME_BROADCASTER, useValue: { broadcastEvent: jest.fn() } },
        {
          provide: ProviderAuthWritebackService,
          useValue: { pullIfChanged: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: VmProvidersService, useValue: {} },
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: STORAGE_SERVICE, useValue: storage },
      ],
    }).compile();
    health = module.get(RemoteHealthService);
    settings = module.get(SettingsService);
    service = module.get(RemoteSkillSettingsService);
    host = module.get(RemoteHostClient);
  });
  afterEach(async () => {
    releaseUpload?.();
    releaseUpload = undefined;
    service?.onModuleDestroy();
    if (service)
      await waitFor(
        () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
      );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });
  async function waitFor(predicate: () => boolean): Promise<void> {
    const until = Date.now() + 2000;
    while (!predicate() && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(predicate()).toBe(true);
  }
  const poll = () => service.pushIfChanged(remoteId, service.createPollCycle());
  async function local(): Promise<string> {
    await fs.mkdir(join(root, 'skills', 'example'), { recursive: true });
    await fs.writeFile(
      join(root, 'skills', 'example', 'SKILL.md'),
      '---\nname: example\ndescription: Example\n---\none',
    );
    await storage.createLocalSkillSource({ name: 'local', folderPath: root });
    await poll();
    return pushes.at(-1)!.localSources[0].contentHash;
  }

  it('pushes first, sends effective switches, and skips matching applied/pending revisions', async () => {
    await storage.createCommunitySkillSource({
      name: 'community',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });
    await poll();
    const body = pushes[0];
    expect(body.sourcesEnabled).toMatchObject({ microsoft: true, community: false });
    expect(body.sourcesEnabled).not.toHaveProperty('team');
    status.appliedRevision = body.revision;
    await poll();
    status.appliedRevision = null;
    status.pendingRevision = body.revision;
    await poll();
    expect(pushes).toHaveLength(1);
    status = blank();
    await poll();
    expect(pushes).toHaveLength(2);
  });

  it('pushes the built-in devchain source as enabled despite a legacy stored "off"', async () => {
    database.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES ('legacy-sources', 'skills.sources', ?, '', '')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify({ devchain: false, microsoft: false }));

    await poll();

    expect(pushes[0].sourcesEnabled).toMatchObject({ devchain: true, microsoft: false });
  });

  it('changes revision for global settings and per-remote Connect/Disconnect bindings', async () => {
    await poll();
    const first = pushes[0].revision;
    await settings.setSkillSourceEnabled('microsoft', false);
    await poll();
    expect(pushes.at(-1)!.revision).not.toBe(first);
    await storage.createRemoteProjectBinding({ projectId: 'A', remoteId });
    await storage.updateRemoteProjectBinding('A', { state: 'remote' });
    await storage.setSourceProjectEnabled('A', 'microsoft', false);
    await poll();
    expect(pushes.at(-1)).toMatchObject({
      projectIds: ['A'],
      projectSourceSwitches: [{ projectId: 'A', sourceName: 'microsoft', enabled: false }],
    });
    const connected = pushes.at(-1)!.revision;
    await storage.deleteRemoteProjectBinding('A');
    await poll();
    expect(pushes.at(-1)!.projectIds).toEqual([]);
    expect(pushes.at(-1)!.revision).not.toBe(connected);
  });

  it('builds the global snapshot and local fingerprints once for all remotes in a cycle', async () => {
    await local();
    const fingerprint = jest.spyOn(LocalSkillSourceAdapter.prototype, 'getLatestCommit');
    const list = jest.spyOn(storage, 'listCommunitySkillSources');
    const second = await storage.createRemote({
      kind: 'address',
      name: 'second',
      baseUrl: (await storage.getRemote(remoteId)).baseUrl! + '/second',
      tlsCertificate: fixtureTls.cert,
    });
    await storage.createRemoteProjectBinding({ projectId: 'B', remoteId: second.id });
    await storage.updateRemoteProjectBinding('B', { state: 'remote' });
    const cycle = service.createPollCycle();
    await Promise.all([
      service.pushIfChanged(remoteId, cycle),
      service.pushIfChanged(second.id, cycle),
    ]);
    expect(fingerprint).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(
      pushes
        .slice(-2)
        .map((body) => body.projectIds)
        .sort((a, b) => a.length - b.length),
    ).toEqual([[], ['B']]);
  });

  it('does not overlap pushes to one remote', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = jest.spyOn(host, 'getSkillSettingsStatus').mockImplementationOnce(async () => {
      await gate;
      return blank();
    });
    const first = poll();
    await waitFor(() => read.mock.calls.length === 1);
    await poll();
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(pushes).toHaveLength(1);
  });

  it('retries skipped sources only after five minutes and never while pending', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await poll();
    const revision = pushes[0].revision;
    status = {
      ...blank(),
      appliedRevision: revision,
      skipped: [{ name: 'source', kind: 'community', reason: 'offline' }],
    };
    await poll();
    expect(pushes).toHaveLength(1);
    now += 300_000;
    status.pendingRevision = revision;
    await poll();
    expect(pushes).toHaveLength(1);
    status.pendingRevision = null;
    await poll();
    expect(pushes).toHaveLength(2);
    await poll();
    expect(pushes).toHaveLength(2);
    const logs = jest.requireMock('../../../common/logging/logger').logger.debug.mock.calls;
    expect(logs.filter((call: unknown[]) => call[1] === 'Host skipped skill sources')).toHaveLength(
      1,
    );
  });

  it.each([404, 409, 500])('swallows HTTP %s on status or push', async (code) => {
    statusCode = code;
    await expect(poll()).resolves.toBeUndefined();
    expect(pushes).toHaveLength(0);
    statusCode = 200;
    pushCode = code;
    await expect(poll()).resolves.toBeUndefined();
    expect(pushes).toHaveLength(1);
  });
  it('swallows malformed responses, network/timeout failures and snapshot errors', async () => {
    malformed = true;
    await expect(poll()).resolves.toBeUndefined();
    expect(pushes).toHaveLength(0);
    malformed = false;
    jest
      .spyOn(host, 'getSkillSettingsStatus')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new TypeError('network failed'));
    await expect(poll()).resolves.toBeUndefined();
    await expect(poll()).resolves.toBeUndefined();
    jest
      .spyOn(storage, 'listCommunitySkillSources')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(poll()).resolves.toBeUndefined();
    await poll();
    expect(pushes).toHaveLength(1);
  });

  it.each([404, 409, 500])(
    'keeps the host online through repeated skill status %s failures',
    async (code) => {
      statusCode = code;
      for (let i = 0; i < 2; i++) {
        expect((await health.refresh(remoteId)).online).toBe(true);
        await waitFor(() => (service as unknown as { pushing: Set<string> }).pushing.size === 0);
        expect(health.getState(remoteId)).toMatchObject({
          online: true,
          versionMatches: true,
          error: null,
        });
      }
    },
  );

  it('uploads matching gzip tar content without links, ignores stale hashes, and follows file edits', async () => {
    const hash = await local();
    await fs.symlink('/outside', join(root, 'skills', 'link'));
    status.needsContent = [{ name: 'local', contentHash: 'stale' }];
    await poll();
    expect(uploadAttempts).toBe(0);
    status.needsContent = [{ name: 'local', contentHash: hash }];
    await poll();
    await waitFor(() => uploads.length === 1);
    const extracted = await unpackHomeSkillContent(
      Readable.from([uploads[0]]),
      join(root, 'unpacked'),
    );
    expect(await fs.readdir(join(extracted, 'skills'))).toEqual(['example']);
    expect(await fs.readFile(join(extracted, 'skills', 'example', 'SKILL.md'), 'utf8')).toContain(
      'one',
    );
    const revision = pushes.at(-1)!.revision;
    await fs.appendFile(join(root, 'skills', 'example', 'SKILL.md'), ' edited');
    await poll();
    expect(pushes.at(-1)!.revision).not.toBe(revision);
    expect(pushes.at(-1)!.localSources[0].contentHash).not.toBe(hash);
    expect(uploadPaths[0]).toBe('/api/host/skill-settings/local-sources/local/content');
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    status.needsContent = [
      { name: 'local', contentHash: pushes.at(-1)!.localSources[0].contentHash },
    ];
    await poll();
    await waitFor(() => uploads.length === 2);
  });

  it('does not block another poll or overlap uploads while an upload is in flight', async () => {
    const hash = await local();
    status.needsContent = [{ name: 'local', contentHash: hash }];
    holdUpload = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    await poll();
    await waitFor(() => uploadAttempts === 1);
    await poll();
    expect(uploadAttempts).toBe(1);
    expect(pushes).toHaveLength(3);
    releaseUpload!();
    await waitFor(() => uploads.length === 1);
  });

  it('skips an oversized folder before making any upload request', async () => {
    await local();
    await fs.writeFile(
      join(root, 'skills', 'example', 'large'),
      Buffer.alloc(20 * 1024 * 1024 + 1),
    );
    await poll();
    const hash = pushes.at(-1)!.localSources[0].contentHash;
    status.needsContent = [{ name: 'local', contentHash: hash }];
    await poll();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    expect(uploadAttempts).toBe(0);
  });

  it('packs an oversized source once, then not again for five minutes across polls and remotes', async () => {
    let offset = 0;
    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const prepare = jest
      .spyOn(homeSkillArchive, 'prepareHomeSkillArchive')
      .mockRejectedValue(new homeSkillArchive.HomeSkillArchiveTooLargeError());
    const hash = await local();
    status.needsContent = [{ name: 'local', contentHash: hash }];
    await poll();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    await poll();
    expect(prepare).toHaveBeenCalledTimes(1);
    const second = await storage.createRemote({
      kind: 'address',
      name: 'second-vm',
      baseUrl: (await storage.getRemote(remoteId)).baseUrl! + '/second',
      tlsCertificate: fixtureTls.cert,
    });
    const cycle = service.createPollCycle();
    await Promise.all([
      service.pushIfChanged(remoteId, cycle),
      service.pushIfChanged(second.id, cycle),
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(uploadAttempts).toBe(0);
    offset += 300_000;
    await poll();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('retries a shrunk oversized source only after expiry even when its hash is unchanged', async () => {
    let offset = 0;
    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const hash = await local();
    await fs.writeFile(join(root, 'skills', '.big'), Buffer.alloc(20 * 1024 * 1024 + 1));
    const prepare = jest.spyOn(homeSkillArchive, 'prepareHomeSkillArchive');
    status.needsContent = [{ name: 'local', contentHash: hash }];
    await poll();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(uploadAttempts).toBe(0);
    await fs.rm(join(root, 'skills', '.big'));
    await poll();
    expect(pushes.at(-1)!.localSources[0].contentHash).toBe(hash);
    expect(prepare).toHaveBeenCalledTimes(1);
    offset += 300_000;
    await poll();
    await waitFor(() => uploads.length === 1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('packs a changed hash at once despite an active refusal memo', async () => {
    const prepare = jest
      .spyOn(homeSkillArchive, 'prepareHomeSkillArchive')
      .mockRejectedValue(new homeSkillArchive.HomeSkillArchiveTooLargeError());
    const hash = await local();
    status.needsContent = [{ name: 'local', contentHash: hash }];
    await poll();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    await fs.appendFile(join(root, 'skills', 'example', 'SKILL.md'), ' edited');
    await poll();
    const changed = pushes.at(-1)!.localSources[0].contentHash;
    expect(changed).not.toBe(hash);
    status.needsContent = [{ name: 'local', contentHash: changed }];
    await poll();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('records no refusal memo for an ordinary upload failure', async () => {
    const prepare = jest.spyOn(homeSkillArchive, 'prepareHomeSkillArchive');
    const hash = await local();
    status.needsContent = [{ name: 'local', contentHash: hash }];
    uploadCode = 500;
    await poll();
    await waitFor(() => uploads.length === 1);
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    uploadCode = 200;
    await poll();
    await waitFor(() => uploads.length === 2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('records no refusal memo for an aborted upload', async () => {
    const prepare = jest.spyOn(homeSkillArchive, 'prepareHomeSkillArchive');
    const hash = await local();
    status.needsContent = [{ name: 'local', contentHash: hash }];
    holdUpload = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    await poll();
    await waitFor(() => uploadAttempts === 1);
    service.prune(new Set());
    releaseUpload!();
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    await poll();
    await waitFor(() => uploads.length === 2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('keeps unreadable folders in the body with a stable missing-content hash and sends no upload', async () => {
    await storage.createLocalSkillSource({ name: 'missing', folderPath: join(root, 'missing') });
    await poll();
    const source = pushes[0].localSources[0];
    expect(source).toMatchObject({ name: 'missing', contentHash: 'unavailable' });
    status.needsContent = [{ name: source.name, contentHash: source.contentHash }];
    await poll();
    expect(pushes[1].revision).toBe(pushes[0].revision);
    expect(uploadAttempts).toBe(0);
  });

  it('swallows upload failure and retries on the next poll', async () => {
    const hash = await local();
    status.needsContent = [{ name: 'local', contentHash: hash }];
    uploadCode = 500;
    await poll();
    await waitFor(() => uploads.length === 1);
    await waitFor(
      () => (service as unknown as { uploading: Map<string, unknown> }).uploading.size === 0,
    );
    uploadCode = 200;
    await poll();
    await waitFor(() => uploads.length === 2);
  });
});
