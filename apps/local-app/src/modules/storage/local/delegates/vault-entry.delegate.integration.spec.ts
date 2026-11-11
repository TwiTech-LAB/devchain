/**
 * Vault entry storage over a migrated in-memory SQLite database.
 * Test layer: storage integration. Owner uniqueness, grant validation against
 * profiles, name precedence, family access and project-delete cascades live in SQL,
 * so only a real migrated schema exercises them.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../../../../common/test/test-database.helper';
import { vaultSnapshotRevision } from '../../../vault/vault-snapshot-revision';
import type {
  CreateVaultEntry,
  VaultEntryProjectAccess,
  VaultResolvedEntry,
} from '../../models/domain.models';
import { LocalStorageService } from '../local-storage.service';

describe('Vault entry storage (integration)', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(database.db);
    for (const id of ['A', 'B']) {
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, created_at, updated_at)
           VALUES (?, ?, ?, 'T', 'T')`,
        )
        .run(id, `Project ${id}`, `/tmp/${id}`);
    }
    profile('A', 'Coder');
    profile('A', 'reviewer');
    profile('A', null);
    profile('B', 'tester');
    // Every agent may use the Vault unless a test narrows the access.
    for (const id of ['A', 'B']) await storage.setVaultFamilyAccess(id, { mode: 'all' });
  });

  afterEach(() => sqlite.close());

  function profile(projectId: string, familySlug: string | null): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'T', 'T')`,
      )
      .run(id, projectId, `profile-${id}`, familySlug);
    return id;
  }

  /** A project entry with an all-agents grant, or an ungranted global entry. */
  function entry(
    name: string,
    projectId: string | null,
    overrides: Partial<CreateVaultEntry> = {},
  ) {
    return storage.createVaultEntry({
      id: randomUUID(),
      projects: projectId ? [{ projectId, mode: 'all' }] : [],
      name,
      kind: 'secret',
      description: `${name} description`,
      valueCiphertext: `ciphertext-${name}`,
      ...overrides,
    });
  }

  const names = (rows: VaultResolvedEntry[]) => rows.map((row) => `${row.name}:${row.owner}`);
  const all = (projectId: string): VaultEntryProjectAccess => ({ projectId, mode: 'all' });
  const coders: VaultEntryProjectAccess = {
    projectId: 'A',
    mode: 'families',
    familySlugs: ['coder'],
  };
  const row = (id: string) =>
    sqlite
      .prepare(
        'SELECT project_id, name, revision, value_ciphertext FROM vault_entries WHERE id = ?',
      )
      .get(id);

  it('takes the owner from the project list at create and grants each project its mode', async () => {
    const shared = await entry('NO_PROJECT', null);
    const own = await entry('ONE_PROJECT', null, { projects: [coders] });
    const many = await entry('TWO_PROJECTS', null, { projects: [all('B'), coders] });

    expect(own).not.toHaveProperty('valueCiphertext');
    expect([shared, own, many].map((created) => created.projectId)).toEqual([null, 'A', null]);
    expect(await storage.listVaultEntryGrants(shared.id)).toEqual([]);
    expect(await storage.listVaultEntryGrants(own.id)).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
    ]);
    expect(await storage.listVaultEntryGrants(many.id)).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);
    expect(names(await storage.resolveVaultGrantsForAgent('A', 'reviewer'))).toEqual([]);
  });

  it('keeps the owner until the project list names another project, then converts in place', async () => {
    const own = await entry('OWN_KEY', 'A');
    const before = row(own.id);

    await storage.updateVaultEntry(own.id, { projects: [] });
    expect(row(own.id)).toEqual(before);
    expect(await storage.listVaultEntryGrants(own.id)).toEqual([]);
    await storage.updateVaultEntry(own.id, { projects: [coders] });
    expect(row(own.id)).toEqual(before);

    const pushed = vaultSnapshotRevision(await storage.readVaultSnapshot());
    const converted = await storage.updateVaultEntry(own.id, { projects: [coders, all('B')] });

    expect(converted).toMatchObject({ id: own.id, projectId: null, revision: 1 });
    expect(row(own.id)).toEqual({ ...(before as object), project_id: null });
    expect(vaultSnapshotRevision(await storage.readVaultSnapshot())).not.toBe(pushed);
    expect(await storage.listVaultEntryGrants(own.id)).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);

    // A shared entry stays shared; projects left out of the list lose access.
    await storage.updateVaultEntry(own.id, { projects: [all('A')] });
    expect(row(own.id)).toMatchObject({ project_id: null });
    expect(await storage.listVaultEntryGrants(own.id)).toEqual([
      { projectId: 'A', familySlug: null, familyMatched: true },
    ]);
  });

  it('checks a rename against the final owner and rolls back name, owner and grants together', async () => {
    const x = await entry('X', 'A');
    await entry('Y', 'A');
    const z = await entry('Z', 'A');
    await entry('W', 'A');

    // Inside project A the name Y is taken; as a shared entry it is free.
    await expect(
      storage.updateVaultEntry(x.id, { name: 'Y', projects: [all('A'), all('B')] }),
    ).resolves.toMatchObject({ name: 'Y', projectId: null, revision: 2 });

    const before = row(z.id);
    await expect(
      storage.updateVaultEntry(z.id, { name: 'Y', projects: [all('B')] }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'A shared entry named Y already exists.',
      details: { code: 'VAULT_ENTRY_NAME_TAKEN' },
    });
    await expect(
      storage.updateVaultEntry(z.id, { name: 'W', projects: [coders] }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Project Project A already has an entry named W.',
    });
    expect(row(z.id)).toEqual(before);
    expect(await storage.listVaultEntryGrants(z.id)).toEqual([
      { projectId: 'A', familySlug: null, familyMatched: true },
    ]);
  });

  it('keeps names unique per owner only', async () => {
    await entry('API_KEY', null);
    await entry('API_KEY', 'A');
    await entry('API_KEY', 'B');

    for (const projectId of [null, 'A']) {
      await expect(entry('API_KEY', projectId)).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'VAULT_ENTRY_NAME_TAKEN' },
      });
    }
    const other = await entry('OTHER', 'A');
    await expect(storage.updateVaultEntry(other.id, { name: 'API_KEY' })).rejects.toMatchObject({
      details: { code: 'VAULT_ENTRY_NAME_TAKEN' },
    });
    expect(
      (await storage.listVaultEntries({ projectId: 'B' })).map((row) => row.projectId),
    ).toEqual([null, 'B']);
  });

  it('raises the revision when the name or value changes, not the description or the approval flag', async () => {
    const created = await entry('TOKEN', null);
    const described = await storage.updateVaultEntry(created.id, { description: 'New text' });
    const gated = await storage.updateVaultEntry(created.id, { approvalRequired: true });
    const renamed = await storage.updateVaultEntry(created.id, { name: 'TOKEN_2' });
    const replaced = await storage.replaceVaultEntryValue(created.id, 'ciphertext-2');

    expect([created, described, gated, renamed, replaced].map((row) => row.revision)).toEqual([
      1, 1, 1, 2, 3,
    ]);
    expect([created, gated, renamed].map((row) => row.approvalRequired)).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      sqlite.prepare('SELECT value_ciphertext FROM vault_entries WHERE id = ?').get(created.id),
    ).toEqual({ value_ciphertext: 'ciphertext-2' });
  });

  it('refuses grants outside the rules of the project', async () => {
    const own = await entry('OWN_KEY', 'A');
    const global = await entry('GLOBAL_KEY', null);

    await expect(
      storage.setVaultEntryProjectGrants(own.id, 'B', { mode: 'all' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'VAULT_GRANT_OTHER_PROJECT' },
    });
    // `tester` is a family of project B only.
    await expect(
      storage.setVaultEntryProjectGrants(global.id, 'A', {
        mode: 'families',
        familySlugs: ['coder', 'tester'],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'VAULT_GRANT_UNKNOWN_FAMILY', familySlugs: ['tester'] },
    });
    await expect(
      storage.setVaultEntryProjectGrants(global.id, 'missing', { mode: 'all' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await storage.listVaultEntryGrants(global.id)).toEqual([]);
  });

  it('replaces the grants of one project and marks families no profile has any more', async () => {
    const global = await entry('GLOBAL_KEY', null);
    await storage.setVaultEntryProjectGrants(global.id, 'B', { mode: 'all' });
    await storage.setVaultEntryProjectGrants(global.id, 'A', { mode: 'all' });
    await storage.setVaultEntryProjectGrants(global.id, 'A', {
      mode: 'families',
      familySlugs: ['CODER', 'reviewer', 'coder'],
    });
    sqlite
      .prepare("UPDATE agent_profiles SET family_slug = 'renamed' WHERE family_slug = 'reviewer'")
      .run();

    expect(await storage.listVaultEntryGrants(global.id)).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
      { projectId: 'A', familySlug: 'reviewer', familyMatched: false },
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);
    // The entry may keep the slug it holds; another entry may not take it.
    const families = { mode: 'families' as const, familySlugs: ['reviewer', 'coder'] };
    await storage.setVaultEntryProjectGrants(global.id, 'A', families);
    const other = await entry('OTHER_KEY', null);
    await expect(storage.setVaultEntryProjectGrants(other.id, 'A', families)).rejects.toMatchObject(
      {
        details: { code: 'VAULT_GRANT_UNKNOWN_FAMILY', familySlugs: ['reviewer'] },
      },
    );

    await storage.setVaultEntryProjectGrants(global.id, 'A', { mode: 'none' });
    expect(await storage.listVaultEntryGrants(global.id)).toEqual([
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);
  });

  it('matches a profile slug with spaces around it, as the UI and launch do', async () => {
    // A template import stores the slug as the template gives it.
    profile('B', '  ops ');
    const global = await entry('OPS_KEY', null);
    await storage.setVaultEntryProjectGrants(global.id, 'B', {
      mode: 'families',
      familySlugs: ['ops'],
    });

    expect(await storage.listVaultEntryGrants(global.id)).toEqual([
      { projectId: 'B', familySlug: 'ops', familyMatched: true },
    ]);
    expect((await storage.readVaultPushSnapshot(['B'])).grants).toEqual([
      { entryId: global.id, projectId: 'B', familySlug: 'ops' },
    ]);
    expect(names(await storage.resolveVaultGrantsForAgent('B', '  ops '))).toEqual([
      'OPS_KEY:global',
    ]);
  });

  it('saves the listed entries of one project in one transaction', async () => {
    const [cleared, added, untouched] = await Promise.all(
      ['CLEARED', 'ADDED', 'UNTOUCHED'].map((name) => entry(name, null)),
    );
    const ownB = await entry('B_ONLY', 'B');
    await storage.setVaultEntryProjectGrants(cleared.id, 'A', { mode: 'all' });
    await storage.setVaultEntryProjectGrants(untouched.id, 'A', { mode: 'all' });

    const saved = await storage.setVaultProjectGrants('A', [
      { entryId: cleared.id, mode: 'none' },
      { entryId: added.id, mode: 'families', familySlugs: ['coder'] },
    ]);
    const expected = [
      { entryId: added.id, projectId: 'A', familySlug: 'coder', familyMatched: true },
      { entryId: untouched.id, projectId: 'A', familySlug: null, familyMatched: true },
    ].sort((a, b) => a.entryId.localeCompare(b.entryId));
    expect(saved).toEqual(expected);

    await expect(
      storage.setVaultProjectGrants('A', [
        { entryId: cleared.id, mode: 'all' },
        { entryId: ownB.id, mode: 'all' },
      ]),
    ).rejects.toMatchObject({ details: { code: 'VAULT_GRANT_OTHER_PROJECT' } });
    expect(await storage.listVaultGrants({ projectId: 'A' })).toEqual(expected);
    expect(await storage.listVaultGrants()).toHaveLength(3);
  });

  it('resolves entries per project and family, project entries over global ones', async () => {
    const allGlobal = await entry('ALL_GLOBAL', null);
    const coderGlobal = await entry('CODER_GLOBAL', null);
    const shadowed = await entry('SHARED', null, { kind: 'file' });
    await entry('SHARED', 'A');
    await entry('B_ONLY', 'B');
    await storage.setVaultEntryProjectGrants(allGlobal.id, 'A', { mode: 'all' });
    await storage.setVaultEntryProjectGrants(coderGlobal.id, 'A', {
      mode: 'families',
      familySlugs: ['coder'],
    });
    await storage.setVaultEntryProjectGrants(shadowed.id, 'A', { mode: 'all' });

    const cases: Array<[string, string | null, string[]]> = [
      ['A', 'Coder', ['ALL_GLOBAL:global', 'CODER_GLOBAL:global', 'SHARED:project']],
      ['A', 'reviewer', ['ALL_GLOBAL:global', 'SHARED:project']],
      ['A', null, ['ALL_GLOBAL:global', 'SHARED:project']],
      ['B', 'coder', ['B_ONLY:project']],
    ];
    for (const [projectId, familySlug, expected] of cases) {
      expect(names(await storage.resolveVaultGrantsForAgent(projectId, familySlug))).toEqual(
        expected,
      );
    }
    const [resolved] = await storage.resolveVaultGrantsForAgent('A', null);
    expect(resolved).toEqual({
      id: allGlobal.id,
      name: 'ALL_GLOBAL',
      kind: 'secret',
      description: 'ALL_GLOBAL description',
      revision: 1,
      owner: 'global',
      approvalRequired: false,
    });
  });

  it('decides Vault access from the project and the profile family', async () => {
    await storage.setVaultFamilyAccess('B', { mode: 'none' });
    await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: [' Coder '] });

    const cases: Array<[string, string, string | null, string]> = [
      ['project without access rows', 'B', 'tester', 'not_enabled'],
      ['family not listed', 'A', 'reviewer', 'denied'],
      ['profile without a family under family rows', 'A', null, 'denied'],
      ['listed family, any case and spaces', 'A', ' CODER', 'granted'],
    ];
    for (const [label, projectId, familySlug, decision] of cases) {
      expect([label, await storage.getVaultAccessDecision(projectId, familySlug)]).toEqual([
        label,
        decision,
      ]);
    }
    await storage.setVaultFamilyAccess('A', { mode: 'all' });
    for (const familySlug of ['reviewer', null]) {
      expect(await storage.getVaultAccessDecision('A', familySlug)).toBe('granted');
    }
  });

  it('pushes the access rows of the pushed projects only, and an access change alone changes the revision', async () => {
    await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['coder'] });
    await storage.setVaultFamilyAccess('B', { mode: 'all' });
    const before = await storage.readVaultPushSnapshot(['A']);
    expect(before.access).toEqual([{ projectId: 'A', familySlug: 'coder' }]);

    await storage.setVaultFamilyAccess('A', { mode: 'all' });
    const after = await storage.readVaultPushSnapshot(['A']);
    expect(after.access).toEqual([{ projectId: 'A', familySlug: null }]);
    expect(vaultSnapshotRevision(after)).not.toBe(vaultSnapshotRevision(before));
  });

  it('changes the push revision, not the entry revision, when only the approval flag changes', async () => {
    const own = await entry('OWN_KEY', 'A');
    const before = await storage.readVaultPushSnapshot(['A']);

    await storage.updateVaultEntry(own.id, { approvalRequired: true });
    const after = await storage.readVaultPushSnapshot(['A']);

    expect(after.entries).toEqual([
      expect.objectContaining({ id: own.id, revision: 1, approvalRequired: true }),
    ]);
    expect(vaultSnapshotRevision(after)).not.toBe(vaultSnapshotRevision(before));
  });

  it('keeps family approvals apart from grants: normalized, idempotent, removable, cascaded', async () => {
    const own = await entry('OWN_KEY', 'A', { projects: [coders] });
    const global = await entry('GLOBAL_KEY', null, { projects: [all('A'), all('B')] });

    await storage.addVaultUseFamilyApproval(own.id, 'A', ' Coder ');
    expect(await storage.addVaultUseFamilyApproval(own.id, 'A', 'coder')).toEqual([
      { entryId: own.id, projectId: 'A', familySlug: 'coder', createdAt: expect.any(String) },
    ]);
    // An all-agents grant replaces the family grant rows; the approval stays.
    await storage.addVaultEntryGrant(own.id, 'A', null);
    expect(await storage.listVaultUseFamilyApprovals({ entryId: own.id })).toHaveLength(1);

    await expect(storage.addVaultUseFamilyApproval(own.id, 'A', '  ')).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'VAULT_APPROVAL_FAMILY_INVALID' },
    });
    await expect(storage.addVaultUseFamilyApproval(own.id, 'B', 'tester')).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'VAULT_GRANT_OTHER_PROJECT' },
    });

    expect(await storage.removeVaultUseFamilyApproval(own.id, 'A', 'CODER')).toEqual([]);
    await storage.addVaultUseFamilyApproval(own.id, 'A', 'coder');
    await storage.addVaultUseFamilyApproval(global.id, 'A', 'reviewer');
    await storage.addVaultUseFamilyApproval(global.id, 'B', 'tester');
    await storage.deleteVaultEntry(own.id);
    await storage.deleteProject('A');
    expect(await storage.listVaultUseFamilyApprovals()).toEqual([
      expect.objectContaining({ entryId: global.id, projectId: 'B', familySlug: 'tester' }),
    ]);
  });

  it('pushes family approvals of pushed entries and projects whose family a profile has', async () => {
    const own = await entry('OWN_KEY', 'A');
    const unpushed = await entry('UNGRANTED_KEY', null);
    await storage.addVaultUseFamilyApproval(own.id, 'A', 'coder');
    await storage.addVaultUseFamilyApproval(own.id, 'A', 'gone');
    await storage.addVaultUseFamilyApproval(unpushed.id, 'A', 'coder');
    const before = await storage.readVaultPushSnapshot(['A']);

    expect(before.approvals).toEqual([{ entryId: own.id, projectId: 'A', familySlug: 'coder' }]);
    expect((await storage.readVaultPushSnapshot(['B'])).approvals).toEqual([]);

    profile('A', 'Gone');
    const after = await storage.readVaultPushSnapshot(['A']);
    expect(after.approvals.map((row) => row.familySlug)).toEqual(['coder', 'gone']);
    expect(vaultSnapshotRevision(after)).not.toBe(vaultSnapshotRevision(before));
  });

  it('stores the approval flag and family approvals of a pushed snapshot and reads them back', async () => {
    const own = await entry('OWN_KEY', 'A');
    await storage.updateVaultEntry(own.id, { approvalRequired: true });
    await storage.addVaultUseFamilyApproval(own.id, 'A', 'coder');
    const pushed = await storage.readVaultPushSnapshot(['A']);
    sqlite.prepare('DELETE FROM vault_entries').run();

    await storage.replaceVaultSnapshot(pushed);

    expect(await storage.readVaultSnapshot()).toEqual(pushed);
    await storage.replaceVaultSnapshot({ ...pushed, approvals: [] });
    expect(await storage.listVaultUseFamilyApprovals()).toEqual([]);
  });

  it('resolves no grant outside the Vault access of the project', async () => {
    const global = await entry('GLOBAL_KEY', null, { projects: [all('A'), all('B')] });
    await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['coder'] });
    await storage.setVaultFamilyAccess('B', { mode: 'none' });

    expect(names(await storage.resolveVaultGrantsForAgent('A', 'coder'))).toEqual([
      'GLOBAL_KEY:global',
    ]);
    expect(await storage.resolveVaultGrantsForAgent('A', 'reviewer')).toEqual([]);
    expect(await storage.resolveVaultGrantsForAgent('A', null)).toEqual([]);
    expect(await storage.resolveVaultGrantsForAgent('B', 'tester')).toEqual([]);
    // Grants stay stored while access is missing.
    expect(await storage.listVaultEntryGrants(global.id)).toHaveLength(2);
  });

  it('stores access slugs normalized and keeps a held slug whose profile is gone', async () => {
    expect(
      await storage.setVaultFamilyAccess('A', {
        mode: 'families',
        familySlugs: ['REVIEWER', ' coder', 'reviewer'],
      }),
    ).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
      { projectId: 'A', familySlug: 'reviewer', familyMatched: true },
    ]);
    await expect(
      storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['tester'] }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'VAULT_ACCESS_UNKNOWN_FAMILY', familySlugs: ['tester'] },
    });
    sqlite.prepare("DELETE FROM agent_profiles WHERE family_slug = 'reviewer'").run();

    await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['reviewer'] });
    expect(await storage.listVaultFamilyAccess({ projectId: 'A' })).toEqual([
      { projectId: 'A', familySlug: 'reviewer', familyMatched: false },
    ]);
    expect(await storage.listVaultFamilyAccess()).toEqual([
      { projectId: 'A', familySlug: 'reviewer', familyMatched: false },
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);
  });

  it('deletes the entries and grants of a deleted project', async () => {
    const global = await entry('GLOBAL_KEY', null);
    await entry('OWN_KEY', 'A');
    await storage.setVaultEntryProjectGrants(global.id, 'A', { mode: 'all' });
    await storage.setVaultEntryProjectGrants(global.id, 'B', { mode: 'all' });

    await storage.deleteProject('A');

    expect((await storage.listVaultEntries()).map((row) => row.name)).toEqual(['GLOBAL_KEY']);
    expect(await storage.listVaultEntryGrants(global.id)).toEqual([
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM vault_entry_grants').get()).toEqual({
      count: 1,
    });
    expect(await storage.listVaultFamilyAccess()).toEqual([
      { projectId: 'B', familySlug: null, familyMatched: true },
    ]);
  });
});
