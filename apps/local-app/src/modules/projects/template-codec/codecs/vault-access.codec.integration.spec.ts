/**
 * vaultAccess codec against real `:memory:` SQLite storage, run through the TemplatePipeline so
 * the declared non-fatal behavior and the storage write's transaction are both real.
 */
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../../../common/test/test-database.helper';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { LocalStorageService } from '../../../storage/local/local-storage.service';
import type { VaultGrantAccess } from '../../../storage/models/domain.models';
import { VaultAccessService } from '../../../vault/vault-access.service';
import { REPLACE_MODE_CODECS } from '../codec-registry';
import { ImportContext } from '../import-context';
import { TemplatePipeline } from '../template-pipeline';
import type {
  CodecApplyResult,
  ParsedTemplatePayload,
  PipelineMode,
} from '../template-section-codec';

const MODES: PipelineMode[] = ['create', 'replace'];

describe('vaultAccess codec (real storage)', () => {
  let sqlite: Database.Database;
  let storage: StorageService;
  let projectId: string;
  const pipeline = new TemplatePipeline();

  beforeEach(async () => {
    const testDb = createTestDatabase();
    sqlite = testDb.sqlite;
    storage = new LocalStorageService(testDb.db);
    projectId = (
      await storage.createProject({
        name: 'Target',
        description: null,
        rootPath: '/tmp/target',
        isTemplate: false,
      })
    ).id;
    for (const [name, familySlug] of [
      ['Coder', 'Coder'],
      ['Reviewer', 'reviewer'],
      ['Helper', null],
    ] as const) {
      await storage.createAgentProfile({ projectId, name, familySlug });
    }
  });

  afterEach(() => sqlite.close());

  const apply = (
    vaultAccess: unknown,
    mode: PipelineMode,
    target = projectId,
  ): Promise<CodecApplyResult[]> =>
    pipeline.applySections(
      ['vaultAccess'],
      { vaultAccess } as unknown as ParsedTemplatePayload,
      new ImportContext({}, ['profilesPersisted']),
      mode,
      { projectId: target, storage },
    );

  const accessOf = async (target = projectId) =>
    (await storage.listVaultFamilyAccess({ projectId: target }))
      .map((row) => row.familySlug)
      .sort();

  const seedAccess = (access: VaultGrantAccess) => storage.setVaultFamilyAccess(projectId, access);

  it('runs last in the registry and requires persisted profiles', () => {
    const last = REPLACE_MODE_CODECS[REPLACE_MODE_CODECS.length - 1];
    expect(last.declaration).toMatchObject({
      section: 'vaultAccess',
      requiresState: ['profilesPersisted'],
      modes: ['replace', 'create'],
      onFailure: { replace: 'swallow', create: 'swallow' },
    });
  });

  it.each(MODES)('%s: "all" turns the Vault on for every agent', async (mode) => {
    await apply({ mode: 'all' }, mode);
    expect(await accessOf()).toEqual([null]);
  });

  it('replace: families normalize, dedupe, drop unknown slugs and replace access exactly', async () => {
    await seedAccess({ mode: 'all' });

    const [result] = await apply(
      { mode: 'families', familySlugs: [' CODER ', 'coder', 'Ghost'] },
      'replace',
    );

    expect(await accessOf()).toEqual(['coder']);
    expect(result.log).toMatchObject({
      accessMode: 'families',
      familySlugs: ['coder'],
      droppedFamilySlugs: ['ghost'],
    });
  });

  it('replace: a families list emptied by dropped slugs turns the Vault off, never "all"', async () => {
    await seedAccess({ mode: 'all' });

    const [result] = await apply({ mode: 'families', familySlugs: ['ghost'] }, 'replace');

    expect(await accessOf()).toEqual([]);
    expect(result.log).toMatchObject({ accessMode: 'none', droppedFamilySlugs: ['ghost'] });
  });

  it('replace: an absent section leaves Vault-On access untouched', async () => {
    await seedAccess({ mode: 'families', familySlugs: ['reviewer'] });
    await apply(undefined, 'replace');
    expect(await accessOf()).toEqual(['reviewer']);
  });

  it('create: an absent section leaves the Vault off', async () => {
    await apply(undefined, 'create');
    expect(await accessOf()).toEqual([]);
  });

  it.each(MODES)(
    '%s: a failed storage write is swallowed and keeps the previous access',
    async (mode) => {
      await seedAccess({ mode: 'families', familySlugs: ['reviewer'] });
      // Fails after the write's DELETE has run, so the transaction must roll it back.
      sqlite.exec(`CREATE TRIGGER fail_access_insert BEFORE INSERT ON vault_family_access
                   BEGIN SELECT RAISE(ABORT, 'injected'); END`);

      const results = await apply({ mode: 'all' }, mode);

      expect(results).toEqual([{ section: 'vaultAccess', log: { failedNonFatal: true } }]);
      expect(await accessOf()).toEqual(['reviewer']);
    },
  );

  it('applies while another project is remote-bound and the Vault is locked', async () => {
    const otherId = (
      await storage.createProject({
        name: 'Remote',
        description: null,
        rootPath: '/tmp/remote',
        isTemplate: false,
      })
    ).id;
    const remoteId = (
      await storage.createRemote({
        name: 'VM',
        kind: 'address',
        baseUrl: 'https://vm.example:3000',
      })
    ).id;
    await storage.createRemoteProjectBinding({ projectId: otherId, remoteId });
    await storage.updateRemoteProjectBinding(otherId, { state: 'remote' });
    const lockedAccessService = new VaultAccessService(
      storage as never,
      { getState: () => 'locked' } as never,
      {} as never,
    );
    await expect(lockedAccessService.assertAccessWritable()).rejects.toMatchObject({
      details: { code: 'VAULT_LOCKED_REMOTE_ACCESS' },
    });

    const [result] = await apply({ mode: 'families', familySlugs: ['coder'] }, 'replace');

    expect(result.log).toMatchObject({ applied: true });
    expect(await accessOf()).toEqual(['coder']);
  });
});
