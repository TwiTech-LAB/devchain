import type Database from 'better-sqlite3';
import type { HostVaultPush, HostVaultStatus } from '@devchain/shared';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteProjectBinding } from '../../storage/models/domain.models';
import { VAULT_ENTRY_DOMAIN, VAULT_ENTRY_VALUE_FIELD } from '../../vault/vault-entries.service';
import { VaultKeyService } from '../../vault/vault-key.service';
import { VaultKeystoreUnavailableError, type VaultKeystore } from '../../vault/vault-keystore';
import { VaultPushBuilder } from '../../vault/vault-push.builder';
import { vaultSnapshotRevision } from '../../vault/vault-snapshot-revision';
import type { RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteHealthState } from '../ports/remote-health.port';
import { RemoteVaultPushService } from './remote-vault-push.service';

jest.mock('../../../common/logging/logger', () => {
  const child = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => child, logger: child };
});

const NO_KEYSTORE: VaultKeystore = {
  isAvailable: () => false,
  read: () => Promise.reject(new VaultKeystoreUnavailableError()),
  write: () => Promise.reject(new VaultKeystoreUnavailableError()),
  remove: () => Promise.reject(new VaultKeystoreUnavailableError()),
};

const binding = (
  projectId: string,
  remoteId: string,
  state: RemoteProjectBinding['state'] = 'remote',
): RemoteProjectBinding => ({
  projectId,
  remoteId,
  state,
  hostCursor: null,
  syncError: null,
  syncFailedAt: null,
  createdAt: 'T',
  updatedAt: 'T',
});

const decoded = (body: HostVaultPush) =>
  Object.fromEntries(
    body.values.map((value) => [
      body.entries.find((entry) => entry.id === value.entryId)!.name,
      Buffer.from(value.valueBase64, 'base64').toString('utf8'),
    ]),
  );

// Backend integration: grant filters, revisions and decryption run on real SQLite and
// the real Vault key service; the host client is the network boundary, so it is faked.
describe('RemoteVaultPushService', () => {
  let root: string;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let vault: VaultKeyService;
  let bindings: RemoteProjectBinding[];
  let pushed: HostVaultPush[];
  let service: RemoteVaultPushService;
  let health: (remoteId: string) => RemoteHealthState;

  const make = (
    key: VaultKeyService,
    putVault = async (_remoteId: string, body: HostVaultPush) => {
      pushed.push(body);
    },
  ) => {
    const push = new RemoteVaultPushService(
      { listRemoteProjectBindings: async () => bindings },
      new VaultPushBuilder(storage, key),
      { putVault } as unknown as RemoteHostClient,
    );
    push.useHealth((remoteId) => health(remoteId));
    return push;
  };

  async function entry(
    name: string,
    value: string,
    projectId: string | null,
    families?: string[],
  ): Promise<string> {
    const id = randomUUID();
    await storage.createVaultEntry({
      id,
      projects: projectId ? [{ projectId, mode: 'all' }] : [],
      name,
      kind: 'secret',
      description: `${name} description`,
      valueCiphertext: vault.encrypt(VAULT_ENTRY_DOMAIN, id, VAULT_ENTRY_VALUE_FIELD, value),
    });
    if (families) {
      await storage.setVaultEntryProjectGrants(id, 'A', {
        mode: 'families',
        familySlugs: families,
      });
    }
    return id;
  }

  async function status(cacheReady = true): Promise<HostVaultStatus> {
    const plan = await new VaultPushBuilder(storage, vault).plan(['A']);
    return { appliedRevision: plan.revision, cacheReady, cacheUnavailable: null };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-push-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(database.db);
    vault = new VaultKeyService(storage, NO_KEYSTORE, {
      unlockTimeoutMs: 1000,
      fileKeyDirectory: join(root, 'vault'),
    });
    await vault.onModuleInit();
    await vault.setup('recovery');
    for (const id of ['A', 'B', 'C']) {
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')`,
        )
        .run(id, `Project ${id}`, `/tmp/${id}`);
    }
    for (const slug of ['coder', 'ghost']) {
      sqlite
        .prepare(
          `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
           VALUES (?, 'A', ?, ?, 'T', 'T')`,
        )
        .run(`profile-${slug}`, `profile-${slug}`, slug);
    }
    bindings = [binding('A', 'vm-1'), binding('B', 'vm-1', 'detaching'), binding('C', 'vm-2')];
    pushed = [];
    health = () =>
      ({ online: true, versionMatches: true, apiKeyRejected: false }) as RemoteHealthState;
    service = make(vault);
  });

  afterEach(() => {
    vault.onModuleDestroy();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("sends only the entries granted to the VM's projects, with grants whose family has a profile there", async () => {
    const own = await entry('OWN_A', 'own-a', 'A');
    const coder = await entry('CODER_ONLY', 'coder-value', null, ['coder', 'ghost']);
    await entry('GHOST_ONLY', 'ghost-value', null, ['ghost']);
    await entry('ONLY_C', 'c-value', 'C');
    const leaving = await entry('LEAVING_B', 'b-value', null);
    await storage.setVaultEntryProjectGrants(leaving, 'B', { mode: 'all' });
    await storage.deleteAgentProfile('profile-ghost');

    await service.pushNow('vm-1');

    expect(pushed).toHaveLength(1);
    const [body] = pushed;
    expect(decoded(body)).toEqual({ OWN_A: 'own-a', CODER_ONLY: 'coder-value' });
    expect(body.grants).toEqual(
      expect.arrayContaining([
        { entryId: own, projectId: 'A', familySlug: null },
        { entryId: coder, projectId: 'A', familySlug: 'coder' },
      ]),
    );
    expect(body.grants).toHaveLength(2);
    expect(body.revision).toBe(vaultSnapshotRevision(body));
  });

  it.each<[string, boolean, (current: HostVaultStatus) => HostVaultStatus | undefined]>([
    ['the VM holds the current revision with a ready cache', false, (s) => s],
    [
      'the VM cache is not ready at the current revision',
      true,
      (s) => ({ ...s, cacheReady: false }),
    ],
    ['the VM holds another revision', true, (s) => ({ ...s, appliedRevision: 'b'.repeat(64) })],
    [
      'the VM has no memory-only runtime directory',
      false,
      (s) => ({
        ...s,
        appliedRevision: 'b'.repeat(64),
        cacheUnavailable: 'runtime_directory_missing',
      }),
    ],
    ['the VM reports no Vault status (older build)', false, () => undefined],
  ])('on a poll where %s, pushes: %s', async (_name, expected, report) => {
    await entry('OWN_A', 'own-a', 'A');

    await service.pushIfChanged('vm-1', report(await status()));

    expect(pushed.length > 0).toBe(expected);
  });

  it('brings a value change, a revoked grant and a delete to the VM at the next poll', async () => {
    const changed = await entry('CHANGED', 'old', 'A');
    const revoked = await entry('REVOKED', 'revoked', null, ['coder']);
    const deleted = await entry('DELETED', 'deleted', 'A');
    const before = await status();

    await storage.replaceVaultEntryValue(
      changed,
      vault.encrypt(VAULT_ENTRY_DOMAIN, changed, VAULT_ENTRY_VALUE_FIELD, 'new'),
    );
    await storage.setVaultEntryProjectGrants(revoked, 'A', { mode: 'none' });
    await storage.deleteVaultEntry(deleted);
    await service.pushIfChanged('vm-1', before);

    expect(pushed.map(decoded)).toEqual([{ CHANGED: 'new' }]);
  });

  it('runs a confirmed push after the poll push in flight, and lets a poll push join it', async () => {
    await entry('OWN_A', 'own-a', 'A');
    const replies: Array<(error?: Error) => void> = [];
    const confirmedService = make(vault, async (_remoteId, body) => {
      pushed.push(body);
      await new Promise<void>((resolve, reject) =>
        replies.push((error) => (error ? reject(error) : resolve())),
      );
    });
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const poll = confirmedService.pushIfChanged('vm-1', await status(false));
    await flush();
    let confirmed: 'pending' | 'done' = 'pending';
    const answer = confirmedService.pushConfirmed('vm-1').then(() => (confirmed = 'done'));
    await flush();
    expect(pushed).toHaveLength(1);

    replies[0]();
    await poll;
    await flush();
    expect(pushed).toHaveLength(2);
    // A poll push during the confirmed one joins it instead of sending beside it.
    const joined = confirmedService.pushIfChanged('vm-1', await status(false));
    await flush();
    expect([pushed.length, confirmed]).toEqual([2, 'pending']);

    replies[1]();
    await Promise.all([answer, joined]);
    expect([pushed.length, confirmed]).toEqual([2, 'done']);
  });

  it('rejects a confirmed push the VM refused', async () => {
    await entry('OWN_A', 'own-a', 'A');
    const refusing = make(vault, async () => {
      throw new Error('VM refused the revision');
    });
    await expect(refusing.pushConfirmed('vm-1')).rejects.toThrow('VM refused the revision');
  });

  it('reports a stopping service, never a locked Vault, on a confirmed push', async () => {
    await entry('OWN_A', 'own-a', 'A');
    const stopping = make(vault);
    stopping.onModuleDestroy();

    await expect(stopping.pushConfirmed('vm-1')).rejects.toMatchObject({
      details: { state: 'stopping' },
    });
    expect(pushed).toEqual([]);
  });

  it('sends nothing, not even an empty set, while the home Vault is locked', async () => {
    await entry('OWN_A', 'own-a', 'A');
    const locked = new VaultKeyService(storage, NO_KEYSTORE, {
      fileKeyDirectory: join(root, 'vault'),
    });
    await locked.onModuleInit();
    expect(locked.getState()).toBe('locked');

    await make(locked).pushNow('vm-1');
    await make(locked).pushIfChanged('vm-1', { ...(await status()), cacheReady: false });
    // A confirmed push fails loudly instead: the caller's answer depends on it.
    await expect(make(locked).pushConfirmed('vm-1')).rejects.toMatchObject({
      code: 'vault_unavailable',
    });
    // An empty set needs no data key, but it would still clear the VM's cache.
    bindings = [];
    await make(locked).pushNow('vm-1');

    expect(pushed).toEqual([]);
    locked.onModuleDestroy();
  });

  it.each<[string, Partial<RemoteHealthState>]>([
    ['runs another version', { versionMatches: false }],
    ['is offline', { online: false }],
  ])('sends nothing at Disconnect to a VM that %s', async (_name, state) => {
    await entry('OWN_A', 'own-a', 'A');
    health = () =>
      ({
        online: true,
        versionMatches: true,
        apiKeyRejected: false,
        ...state,
      }) as RemoteHealthState;

    await service.onBindingChanged({
      projectId: 'A',
      remoteId: 'vm-1',
      state: 'deleted',
      hostCursor: null,
      syncError: null,
    });

    expect(pushed).toEqual([]);
  });

  it('sends an empty set when Disconnect removes the last project of the VM', async () => {
    await entry('OWN_A', 'own-a', 'A');
    bindings = bindings.filter((row) => row.projectId !== 'A');

    await service.onBindingChanged({
      projectId: 'A',
      remoteId: 'vm-1',
      state: 'deleted',
      hostCursor: null,
      syncError: null,
    });

    expect(pushed).toEqual([
      {
        revision: vaultSnapshotRevision({ entries: [], grants: [], access: [], approvals: [] }),
        entries: [],
        grants: [],
        access: [],
        approvals: [],
        values: [],
      },
    ]);
  });
});
