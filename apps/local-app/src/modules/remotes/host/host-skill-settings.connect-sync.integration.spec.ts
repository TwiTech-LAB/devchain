/**
 * Storage, replica and filesystem integration: the Connect import and the
 * settings apply converge on catalog sync when a global source switch turns
 * on. Real SQLite, replica build/apply, lifecycle and sync run together; the
 * catalog content — not a spy call — is the proof.
 */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import type { HostSkillSettings } from '@devchain/shared';
import { createReplicaDb, seedReplicaSource } from '../replica/__fixtures__/replica-seed';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { SettingsService } from '../../settings/services/settings.service';
import { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';
import { SkillSourceRegistryService } from '../../skills/services/skill-source-registry.service';
import { SkillSyncService } from '../../skills/services/skill-sync.service';
import type { SyncResult } from '../../skills/services/skill-sync.types';
import { SkillsService } from '../../skills/services/skills.service';
import { SkillCategoryService } from '../../skills/services/skill-category.service';
import { SKILL_SOURCE_ADAPTERS } from '../../skills/adapters/skill-source.adapter';
import { HostSkillSettingsService } from './host-skill-settings.service';
import { HostService } from './host.service';
import { ProjectFreezeService } from './project-freeze.service';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import { ProjectSessionsStopper } from '../services/project-sessions-stopper.service';
import { ProjectTimeSettler } from '../time/project-time-settler.service';

// The sync materializes skill folders under the homedir-based skills root;
// a scratch home keeps the test hermetic instead of writing the real one.
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const home = fs.mkdtempSync(path.join(actual.tmpdir(), 'host-skill-connect-home-'));
  return { ...actual, homedir: () => home };
});

const community = { name: 'home-source', repoOwner: 'owner', repoName: 'repo', branch: 'main' };
const syncSuccess: SyncResult = {
  status: 'completed',
  added: 0,
  updated: 0,
  removed: 0,
  failed: 0,
  unchanged: 0,
  errors: [],
};
const emptyBody = (): HostSkillSettings => ({
  revision: 'r1',
  communitySources: [],
  localSources: [],
  sourcesEnabled: {},
  projectIds: ['A'],
  projectSourceSwitches: [],
});

describe('Host skill settings Connect enablement', () => {
  let database: ReturnType<typeof createReplicaDb>;
  let storage: LocalStorageService;
  let settings: SettingsService;
  let lifecycle: SkillSourceLifecycleService;
  let sync: SkillSyncService;
  let service: HostSkillSettingsService;
  let host: HostService;
  let builder: ProjectReplicaBuilder;
  let root: string;

  beforeEach(async () => {
    database = createReplicaDb();
    seedReplicaSource(database.sqlite);
    storage = new LocalStorageService(database.db);
    root = await fs.mkdtemp(join(tmpdir(), 'host-skill-connect-'));
    const module = await Test.createTestingModule({
      providers: [
        HostSkillSettingsService,
        HostService,
        ProjectFreezeService,
        ProjectWriteGate,
        SettingsService,
        SkillSourceLifecycleService,
        SkillSourceRegistryService,
        SkillSyncService,
        SkillsService,
        SkillCategoryService,
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: SKILL_SOURCE_ADAPTERS, useValue: [] },
        {
          provide: ProjectReplicaBuilder,
          useFactory: (storage: StorageService) => new ProjectReplicaBuilder(storage),
          inject: [STORAGE_SERVICE],
        },
        {
          provide: ProjectReplicaApplier,
          useFactory: (storage: StorageService) =>
            new ProjectReplicaApplier(storage, {
              prepareCommitted: (name, payload) => ({
                id: randomUUID(),
                name,
                payload,
                requestId: null,
                publishedAt: new Date().toISOString(),
              }),
              emitCommitted: () => undefined,
            }),
          inject: [STORAGE_SERVICE],
        },
        { provide: ProjectSessionsStopper, useValue: { stop: async () => undefined } },
        { provide: ProjectTimeSettler, useValue: { settle: async () => undefined } },
      ],
    }).compile();
    module.get(ProjectWriteGate).bindStorage(storage);
    service = module.get(HostSkillSettingsService);
    host = module.get(HostService);
    builder = module.get(ProjectReplicaBuilder);
    lifecycle = module.get(SkillSourceLifecycleService);
    sync = module.get(SkillSyncService);
    settings = module.get(SettingsService);
    jest.spyOn(service, 'managedRoot').mockReturnValue(root);
  });

  afterEach(async () => {
    await lifecycle.enqueueExclusiveJob(async () => undefined);
    database.sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(os.homedir(), { recursive: true, force: true });
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

  function localBody(sourcesEnabled: Record<string, boolean>): HostSkillSettings {
    return {
      ...emptyBody(),
      localSources: [{ name: 'local', folderPath: '/home/source', contentHash: 'hash1' }],
      sourcesEnabled,
    };
  }

  async function connect(
    switches: Record<string, boolean>,
    options: { resnapshot: boolean },
  ): Promise<void> {
    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    result.replica.tables.instance_settings.skillsSources = {
      ...result.replica.tables.instance_settings.skillsSources,
      ...switches,
    };
    await host.importProject(result.replica, options);
  }

  it('syncs a source turned on by Connect, before the next settings apply, into the catalog', async () => {
    await apply(localBody({ local: false }));
    await service.upload('local', 'hash1', await archive());
    await lifecycle.enqueueExclusiveJob(async () => undefined);
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM skills WHERE source = 'local'").get(),
    ).toEqual({ count: 0 });

    await connect({ local: true }, { resnapshot: true });
    await apply({ ...localBody({ local: true }), revision: 'enabled-after-connect' });
    await lifecycle.enqueueExclusiveJob(async () => undefined);

    expect(settings.getSkillSourcesEnabled().local).toBe(true);
    expect((await service.status()).needsContent).toEqual([]);
    expect(
      database.sqlite
        .prepare("SELECT slug, instruction_content, status FROM skills WHERE source = 'local'")
        .all(),
    ).toEqual([{ slug: 'local/example', instruction_content: 'one', status: 'available' }]);
  });

  it('enqueues one deferred sync per source a Connect turns on and none when no switch turns on', async () => {
    jest.spyOn(sync, 'syncSource').mockResolvedValue(syncSuccess);
    await storage.createCommunitySkillSource(community);
    await storage.createLocalSkillSource({ name: 'local', folderPath: join(root, 'local') });
    await settings.setSkillSourceEnabled(community.name, false);
    await settings.setSkillSourceEnabled('local', false);
    await lifecycle.enqueueExclusiveJob(async () => undefined);
    const enqueue = jest.spyOn(lifecycle, 'enqueueDeferredSync');

    await connect({ [community.name]: true, local: true }, { resnapshot: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map(([name]) => name).sort()).toEqual([community.name, 'local']);

    enqueue.mockClear();
    await connect({ [community.name]: true, local: true }, { resnapshot: true });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues nothing when the import apply fails', async () => {
    await settings.setSkillSourceEnabled('local', false);
    const enqueue = jest.spyOn(lifecycle, 'enqueueDeferredSync');
    await expect(connect({ local: true }, { resnapshot: false })).rejects.toThrow(
      'Project already exists',
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(settings.getSkillSourcesEnabled().local).toBe(false);
  });
});
