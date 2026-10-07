import { PayloadTooLargeException } from '@nestjs/common';
import { HOME_SKILL_CONTENT_LIMIT } from './host-skill-content';
/** Storage and filesystem integration: real lifecycle and SQLite expose reconciliation and catalog regressions; only community network sync is stubbed. */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { HostSkillSettings } from '@devchain/shared';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { createReplicaDb, seedReplicaSource } from '../replica/__fixtures__/replica-seed';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { SettingsService } from '../../settings/services/settings.service';
import { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';
import { SkillSourceRegistryService } from '../../skills/services/skill-source-registry.service';
import { SkillSyncService } from '../../skills/services/skill-sync.service';
import { LocalSkillSourceAdapter } from '../../skills/adapters/local-skill-source.adapter';
import { HostSkillSettingsService } from './host-skill-settings.service';

const community = { name: 'home-source', repoOwner: 'owner', repoName: 'repo', branch: 'main' };
const empty = (): HostSkillSettings => ({
  revision: 'r1',
  communitySources: [],
  localSources: [],
  sourcesEnabled: {},
  projectIds: ['A'],
  projectSourceSwitches: [],
});
const success = {
  status: 'completed',
  added: 0,
  updated: 0,
  removed: 0,
  failed: 0,
  unchanged: 0,
  errors: [],
};

describe('Host skill settings reconciliation', () => {
  let database: ReturnType<typeof createReplicaDb>;
  let storage: LocalStorageService;
  let settings: SettingsService;
  let lifecycle: SkillSourceLifecycleService;
  let service: HostSkillSettingsService;
  let root: string;
  const syncSource = jest.fn().mockResolvedValue(success);
  beforeEach(async () => {
    database = createReplicaDb();
    seedReplicaSource(database.sqlite);
    storage = new LocalStorageService(database.db);
    root = await fs.mkdtemp(join(tmpdir(), 'host-skills-'));
    syncSource.mockReset().mockResolvedValue(success);
    const module = await Test.createTestingModule({
      providers: [
        HostSkillSettingsService,
        SettingsService,
        SkillSourceLifecycleService,
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        {
          provide: SkillSourceRegistryService,
          useValue: { getBuiltInSourceNames: () => ['microsoft'] },
        },
        { provide: SkillSyncService, useValue: { syncSource } },
      ],
    }).compile();
    service = module.get(HostSkillSettingsService);
    lifecycle = module.get(SkillSourceLifecycleService);
    settings = module.get(SettingsService);
    jest.spyOn(service, 'managedRoot').mockReturnValue(root);
    // Materialized download roots are external to this fixture; deletion admission and DB writes stay real.
    jest
      .spyOn(
        lifecycle as unknown as { deleteSourceSkillsDirectory: () => Promise<void> },
        'deleteSourceSkillsDirectory',
      )
      .mockResolvedValue();
  });
  afterEach(async () => {
    await lifecycle.enqueueExclusiveJob(async () => undefined);
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });
  async function apply(body: HostSkillSettings): Promise<void> {
    service.accept(body);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if ((await service.status()).pendingRevision === null) return;
    }
    throw new Error('Apply did not finish');
  }
  async function archive(text = 'one'): Promise<Readable> {
    const folder = join(root, 'input');
    await fs.mkdir(join(folder, 'skills', 'example'), { recursive: true });
    await fs.writeFile(
      join(folder, 'skills', 'example', 'SKILL.md'),
      `---\nname: example\ndescription: Example\n---\n${text}`,
    );
    return tar.c({ cwd: folder, gzip: true }, ['skills']) as unknown as Readable;
  }
  function localBody(hash = 'hash1', revision = hash): HostSkillSettings {
    return {
      ...empty(),
      revision,
      localSources: [{ name: 'local', folderPath: '/home/source', contentHash: hash }],
      sourcesEnabled: { local: true },
    };
  }

  it('creates sources with home effective switches, preserves host rows and is idempotent', async () => {
    await settings.setSkillSourceEnabled('microsoft', false);
    await settings.setSkillSourceEnabled('host-only', false);
    await storage.setSourceProjectEnabled('A', community.name, false);
    const body = {
      ...empty(),
      communitySources: [community],
      sourcesEnabled: { [community.name]: true, microsoft: true },
      projectSourceSwitches: [{ projectId: 'A', sourceName: community.name, enabled: true }],
    };
    await apply(body);
    expect(await service.status()).toEqual({
      appliedRevision: 'r1',
      pendingRevision: null,
      skipped: [],
      needsContent: [],
    });
    expect(settings.getSkillSourcesEnabled()).toMatchObject({
      microsoft: true,
      'host-only': false,
    });
    expect(await storage.getSourceProjectEnabled('A', community.name)).toBe(false);
    expect(await storage.getSourceProjectEnabled('B', community.name)).toBe(true);
    const before = database.sqlite.prepare('SELECT * FROM community_skill_sources').all();
    const calls = syncSource.mock.calls.length;
    await apply(body);
    expect(database.sqlite.prepare('SELECT * FROM community_skill_sources').all()).toEqual(before);
    expect(syncSource).toHaveBeenCalledTimes(calls);
  });

  it('skips switch rows of projects missing on the VM and still completes the apply', async () => {
    const folder = join(root, 'local');
    await fs.mkdir(join(folder, 'skills'), { recursive: true });
    await fs.writeFile(join(folder, '.devchain-content-hash'), 'hash1');
    const getProject = jest.spyOn(storage, 'getProject');
    const body = {
      ...empty(),
      revision: 'released',
      communitySources: [community],
      localSources: [{ name: 'local', folderPath: '/home/source', contentHash: 'hash1' }],
      sourcesEnabled: { [community.name]: true, local: true },
      projectIds: ['A', 'gone'],
      projectSourceSwitches: [
        { projectId: 'A', sourceName: community.name, enabled: false },
        { projectId: 'A', sourceName: 'local', enabled: false },
        { projectId: 'gone', sourceName: community.name, enabled: true },
      ],
    };
    await apply(body);
    expect(await service.status()).toEqual({
      appliedRevision: 'released',
      pendingRevision: null,
      skipped: [],
      needsContent: [],
    });
    expect(await storage.getCommunitySkillSourceByName(community.name)).not.toBeNull();
    expect((await storage.getLocalSkillSourceByName('local'))?.folderPath).toBe(folder);
    expect(await storage.getSourceProjectEnabled('A', community.name)).toBe(false);
    expect(await storage.getSourceProjectEnabled('A', 'local')).toBe(false);
    expect(await storage.getSourceProjectEnabled('gone', community.name)).toBeNull();
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('replaces the seeded repo under another name, changes branch and removes only owned sources', async () => {
    await storage.createCommunitySkillSource({ ...community, name: 'jeffallan' });
    await storage.createCommunitySkillSource({
      ...community,
      name: 'host-only',
      repoName: 'other',
    });
    await apply({
      ...empty(),
      communitySources: [community],
      sourcesEnabled: { [community.name]: true },
    });
    expect(await storage.getCommunitySkillSourceByName('jeffallan')).toBeNull();
    await apply({
      ...empty(),
      revision: 'r2',
      communitySources: [{ ...community, branch: 'next' }],
      sourcesEnabled: { [community.name]: true },
    });
    expect((await storage.getCommunitySkillSourceByName(community.name))?.branch).toBe('next');
    await apply({ ...empty(), revision: 'r3' });
    expect((await storage.listCommunitySkillSources()).map((source) => source.name)).toEqual([
      'host-only',
    ]);
  });

  it('adopts the same community definition and skips same-name conflicts while continuing', async () => {
    await storage.createCommunitySkillSource(community);
    await storage.createCommunitySkillSource({ ...community, name: 'conflict', repoName: 'other' });
    await apply({
      ...empty(),
      communitySources: [community, { ...community, name: 'conflict', repoName: 'wanted' }],
      sourcesEnabled: { [community.name]: true, conflict: true },
    });
    expect(settings.getHomePushedSkillSources()).toContainEqual({
      name: community.name,
      kind: 'community',
    });
    expect((await service.status()).skipped).toEqual([
      { name: 'conflict', kind: 'community', reason: 'Host source has another definition' },
    ]);
  });

  it('retries a failed creation at the same revision without overwriting switches', async () => {
    const create = jest
      .spyOn(lifecycle, 'createCommunitySource')
      .mockRejectedValueOnce(new Error('offline'));
    const body = {
      ...empty(),
      communitySources: [community],
      sourcesEnabled: { [community.name]: true },
    };
    await apply(body);
    expect((await service.status()).skipped).toHaveLength(1);
    await settings.setSkillSourceEnabled(community.name, false);
    await apply(body);
    expect(create).toHaveBeenCalledTimes(2);
    expect((await service.status()).skipped).toEqual([]);
    expect(settings.getSkillSourcesEnabled()[community.name]).toBe(false);
  });

  it('retries a failed removal and a managed rename with the same repo', async () => {
    await apply({
      ...empty(),
      communitySources: [community],
      sourcesEnabled: { [community.name]: true },
    });
    jest
      .spyOn(lifecycle, 'deleteCommunitySource')
      .mockRejectedValueOnce(new Error('busy filesystem'));
    const renamed = { ...community, name: 'renamed' };
    const body = {
      ...empty(),
      revision: 'renamed',
      communitySources: [renamed],
      sourcesEnabled: { renamed: true },
    };
    await apply(body);
    expect((await service.status()).skipped.length).toBeGreaterThan(0);
    await apply(body);
    expect((await service.status()).skipped).toEqual([]);
    expect((await storage.listCommunitySkillSources()).map((source) => source.name)).toEqual([
      'renamed',
    ]);
  });

  it('keeps a VM-only same-name local source with another folder and refuses its content', async () => {
    await storage.createLocalSkillSource({ name: 'local', folderPath: '/vm-only' });
    await apply(localBody());
    expect((await service.status()).skipped).toEqual([
      { name: 'local', kind: 'local', reason: 'Host source has another definition' },
    ]);
    await expect(service.upload('local', 'hash1', await archive())).rejects.toThrow(
      'another definition',
    );
    expect((await storage.getLocalSkillSourceByName('local'))?.folderPath).toBe('/vm-only');
  });

  it('omits needsContent for a name taken by a VM local source or a community source', async () => {
    await storage.createLocalSkillSource({ name: 'vm-local', folderPath: '/vm-only' });
    await storage.createCommunitySkillSource({ ...community, name: 'vm-community' });
    await apply({
      ...empty(),
      localSources: [
        { name: 'vm-local', folderPath: '/home/a', contentHash: 'hash1' },
        { name: 'vm-community', folderPath: '/home/b', contentHash: 'hash2' },
        { name: 'free', folderPath: '/home/c', contentHash: 'hash3' },
      ],
      sourcesEnabled: { 'vm-local': true, 'vm-community': true, free: true },
    });
    expect((await service.status()).needsContent).toEqual([{ name: 'free', contentHash: 'hash3' }]);
  });

  it('relists a conflicted name once the conflict is gone and a same-revision upload creates the source', async () => {
    await storage.createLocalSkillSource({ name: 'local', folderPath: '/vm-only' });
    await apply(localBody());
    expect((await service.status()).needsContent).toEqual([]);
    await storage.deleteLocalSkillSource((await storage.getLocalSkillSourceByName('local'))!.id);
    expect((await service.status()).needsContent).toEqual([
      { name: 'local', contentHash: 'hash1' },
    ]);
    await service.upload('local', 'hash1', await archive());
    expect((await storage.getLocalSkillSourceByName('local'))?.folderPath).toBe(
      join(root, 'local'),
    );
  });

  it('creates a local source from a matching copy already present after restart', async () => {
    const folder = join(root, 'local');
    await fs.mkdir(join(folder, 'skills'), { recursive: true });
    await fs.writeFile(join(folder, '.devchain-content-hash'), 'hash1');
    await apply(localBody());
    expect((await storage.getLocalSkillSourceByName('local'))?.folderPath).toBe(folder);
    expect((await service.status()).needsContent).toEqual([]);
  });

  it('clears pending on an unexpected error and keeps the applied revision', async () => {
    await apply(empty());
    jest.spyOn(settings, 'mergeSkillSourcesEnabled').mockImplementationOnce(() => {
      throw new Error('database down');
    });
    await apply({ ...empty(), revision: 'r2' });
    expect(await service.status()).toMatchObject({ appliedRevision: 'r1', pendingRevision: null });
  });

  it('coalesces queued bodies while an apply is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = jest.spyOn(lifecycle, 'createCommunitySource');
    create.mockImplementationOnce(async (data, options) => {
      await gate;
      return SkillSourceLifecycleService.prototype.createCommunitySource.call(
        lifecycle,
        data,
        options,
      );
    });
    service.accept({
      ...empty(),
      communitySources: [community],
      sourcesEnabled: { [community.name]: true },
    });
    while (!create.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    expect((await service.status()).pendingRevision).toBe('r1');
    service.accept({ ...empty(), revision: 'r2' });
    service.accept({ ...empty(), revision: 'r3' });
    expect((await service.status()).pendingRevision).toBe('r3');
    release();
    for (let i = 0; i < 100 && (await service.status()).pendingRevision; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect((await service.status()).appliedRevision).toBe('r3');
  });

  it('applies pending project rows before an upload can seed defaults', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = jest.spyOn(lifecycle, 'createCommunitySource');
    create.mockImplementationOnce(async (data, options) => {
      await gate;
      return SkillSourceLifecycleService.prototype.createCommunitySource.call(
        lifecycle,
        data,
        options,
      );
    });
    service.accept({
      ...empty(),
      communitySources: [community],
      sourcesEnabled: { [community.name]: true },
    });
    while (!create.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    service.accept({
      ...localBody(),
      projectSourceSwitches: [{ projectId: 'A', sourceName: 'local', enabled: false }],
    });
    const upload = service.upload('local', 'hash1', await archive());
    release();
    await upload;
    expect(await storage.getSourceProjectEnabled('A', 'local')).toBe(false);
    expect((await service.status()).appliedRevision).toBe('hash1');
  });

  it('requests missing local content, swaps successive copies, changes version and removes the managed copy', async () => {
    await apply(localBody());
    expect((await service.status()).needsContent).toEqual([
      { name: 'local', contentHash: 'hash1' },
    ]);
    let version = '';
    for (const [hash, text] of [
      ['hash1', 'one'],
      ['hash2', 'two'],
      ['hash3', 'new'],
    ]) {
      if (hash !== 'hash1') await apply(localBody(hash));
      await service.upload('local', hash, await archive(text));
      const source = (await storage.getLocalSkillSourceByName('local'))!;
      expect(source.folderPath).toBe(join(root, 'local'));
      const adapter = new LocalSkillSourceAdapter(source);
      const next = await adapter.getLatestCommit();
      expect(next).not.toBe(version);
      version = next;
      expect((await adapter.listSkills()).get('example')?.instructionContent).toBe(text);
      expect((await service.status()).needsContent).toEqual([]);
    }
    expect(syncSource).toHaveBeenCalledWith('local');
    await apply({ ...empty(), revision: 'removed' });
    expect(await storage.getLocalSkillSourceByName('local')).toBeNull();
    await expect(fs.stat(join(root, 'local'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['local', 'old-name'])(
    'replaces a VM-only local folder named %s with a managed copy',
    async (name) => {
      await storage.createLocalSkillSource({ name, folderPath: '/home/source' });
      await storage.setSourceProjectEnabled('A', name, false);
      await apply({
        ...localBody(),
        projectSourceSwitches: [{ projectId: 'A', sourceName: 'local', enabled: true }],
      });
      expect(await storage.getLocalSkillSourceByName(name)).toBeNull();
      await service.upload('local', 'hash1', await archive());
      expect((await storage.getLocalSkillSourceByName('local'))?.folderPath).toBe(
        join(root, 'local'),
      );
      expect(await storage.getSourceProjectEnabled('A', 'local')).toBe(true);
    },
  );

  it('deletes the old managed copy on a same-name home folder change', async () => {
    await apply(localBody());
    await service.upload('local', 'hash1', await archive());
    const changed = localBody('hash2');
    changed.localSources[0].folderPath = '/another/folder';
    await apply(changed);
    expect(await storage.getLocalSkillSourceByName('local')).toBeNull();
    await expect(fs.stat(join(root, 'local'))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.upload('local', 'hash2', await archive('two'));
    expect(settings.getHomePushedSkillSources()).toContainEqual({
      name: 'local',
      kind: 'local',
      homeFolderPath: '/another/folder',
      contentHash: 'hash2',
    });
  });

  it('refuses stale and oversized uploads and leaves the current copy unchanged', async () => {
    await apply(localBody());
    await service.upload('local', 'hash1', await archive());
    await apply(localBody('hash2'));
    await expect(service.upload('local', 'hash1', Readable.from([]))).rejects.toThrow(
      'no longer current',
    );
    await expect(service.upload('unknown', 'hash2', Readable.from([]))).rejects.toThrow(
      'no longer current',
    );
    await expect(
      service.upload('local', 'hash2', Readable.from([Buffer.alloc(HOME_SKILL_CONTENT_LIMIT + 1)])),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(await fs.readFile(join(root, 'local', '.devchain-content-hash'), 'utf8')).toBe('hash1');
    expect(
      await fs.readFile(join(root, 'local', 'skills', 'example', 'SKILL.md'), 'utf8'),
    ).toContain('one');
  });

  it('enqueues sync when a source with content uploaded while off is turned on', async () => {
    const body = localBody();
    body.sourcesEnabled.local = false;
    await apply(body);
    await service.upload('local', 'hash1', await archive());
    syncSource.mockClear();
    await apply({ ...body, revision: 'enabled', sourcesEnabled: { local: true } });
    expect(syncSource).toHaveBeenCalledWith('local');
  });

  it('reports a legacy devchain=false as enabled after a home push and schedules its sync', async () => {
    database.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES ('legacy-sources', 'skills.sources', ?, '', '')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify({ devchain: false, microsoft: false }));
    expect(settings.getSkillSourcesEnabled()).toEqual({ microsoft: false });

    await apply({ ...empty(), sourcesEnabled: { devchain: true, microsoft: false } });
    await lifecycle.enqueueExclusiveJob(async () => undefined);

    expect(settings.getSkillSourcesEnabled().devchain).toBeUndefined();
    expect(settings.getStoredSkillSourcesEnabled()).toEqual({ devchain: true, microsoft: false });
    expect(syncSource).toHaveBeenCalledWith('devchain');
    expect(syncSource).not.toHaveBeenCalledWith('microsoft');
  });
});
