import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { createMcpToolBindingRegistryFixture } from '../mcp/services/testing/mcp-tool-binding-registry.fixture';
import { SessionContextResolver } from '../mcp/services/utils/session-context-resolver';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE, type StorageService } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService } from './vault-access.service';
import { VaultDiscoveryService } from './vault-discovery.service';
import { VAULT_SESSION_OVERLAY } from './vault-session-overlay';
import { VaultSessionValueStore } from './vault-session-values';
import { vaultListInstructions } from './vault-instructions';
import { VaultEntriesService } from './vault-entries.service';
import { VAULT_OPTIONS, VaultKeyService } from './vault-key.service';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from './vault-keystore';
import { VaultVmCacheService } from './vault-vm-cache.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CANARIES = ['canary-token-a', 'canary-shadow', 'canary-late', 'canary-changed-2'];

describe('Vault discovery', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let vault: VaultKeyService;
  let sessionValues: VaultSessionValueStore;
  let entries: VaultEntriesService;
  let discovery: VaultDiscoveryService;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-discovery-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    const insert = (sql: string) => sqlite.prepare(sql).run();
    insert(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
            VALUES ('A', 'Project A', '/tmp/A', 'T', 'T')`);
    insert(`INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
            VALUES ('p-coder', 'A', 'Coder', 'coder', 'T', 'T'),
                   ('p-reviewer', 'A', 'Reviewer', 'reviewer', 'T', 'T')`);
    insert(`INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
            VALUES ('prov', 'claude', 0, 'T', 'T')`);
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'Coder', 0, 'T', 'T'),
                   ('c-reviewer', 'p-reviewer', 'prov', 'Reviewer', 0, 'T', 'T')`);
    insert(`INSERT INTO agents
              (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
            VALUES ('a-coder', 'A', 'p-coder', 'c-coder', 'Coder', 'T', 'T'),
                   ('a-reviewer', 'A', 'p-reviewer', 'c-reviewer', 'Reviewer', 'T', 'T')`);
    insert(`INSERT INTO sessions (id, agent_id, status, provider_session_id, started_at, created_at, updated_at)
            VALUES ('${SESSION_ID}', 'a-coder', 'running', 'provider-1', 'T', 'T', 'T'),
                   ('${OTHER_SESSION_ID}', 'a-reviewer', 'running', NULL, 'T', 'T', 'T')`);

    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    const module = await Test.createTestingModule({
      providers: [
        VaultKeyService,
        VaultEntriesService,
        VaultAccessService,
        VaultDiscoveryService,
        VaultSessionValueStore,
        { provide: VAULT_SESSION_OVERLAY, useExisting: VaultSessionValueStore },
        SessionRowStore,
        { provide: VaultVmCacheService, useValue: { isClaimedHost: () => false } },
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: STORAGE_SERVICE, useValue: new LocalStorageService(database.db) },
        {
          provide: VAULT_KEYSTORE,
          useValue: {
            isAvailable: () => false,
            read: unavailable,
            write: unavailable,
            remove: unavailable,
          },
        },
        { provide: VAULT_OPTIONS, useValue: { fileKeyDirectory: join(root, 'vault') } },
        {
          provide: ProviderAdapterFactory,
          useValue: { getSupportedProviders: () => [], getAdapter: () => ({}) },
        },
      ],
    }).compile();
    storage = module.get(STORAGE_SERVICE);
    vault = module.get(VaultKeyService);
    entries = module.get(VaultEntriesService);
    discovery = module.get(VaultDiscoveryService);
    sessionValues = module.get(VaultSessionValueStore);
    await vault.setup('file');
    await storage.setVaultFamilyAccess('A', { mode: 'all' });

    const own = (name: string, value: string) =>
      entries.createEntry({
        projects: [{ projectId: 'A', mode: 'all' }],
        name,
        kind: 'secret',
        description: name,
        value,
      });
    const global = async (name: string, value: string, families: string[]) => {
      const entry = await entries.createEntry({
        projects: [],
        name,
        kind: 'secret',
        description: `${name} description`,
        value,
      });
      await entries.updateEntry(entry.id, {
        projects: [{ projectId: 'A', mode: 'families', familySlugs: families }],
      });
      return entry;
    };
    await own('TOKEN_A', CANARIES[0]);
    await global('SHADOWED_KEY', CANARIES[1], ['coder']);
    const changed = await own('CHANGED_KEY', 'canary-changed-1');
    await global('REVIEWER_ONLY', 'canary-reviewer', ['reviewer']);
    await global('LATE_KEY', CANARIES[2], ['coder']);
    await entries.replaceValue(changed.id, CANARIES[3]);
  });

  let resolveSpy: jest.SpyInstance | undefined;
  afterEach(() => resolveSpy?.mockRestore());

  afterAll(() => {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  function agentContext(sessionId: string, agentId: string) {
    return {
      success: true as const,
      data: {
        type: 'agent' as const,
        session: { id: sessionId, agentId, status: 'running', startedAt: 'T' },
        agent: { id: agentId, name: agentId, projectId: 'A' },
        project: { id: 'A', name: 'Project A', rootPath: '/tmp/A' },
      },
    };
  }

  async function callTool(sessionId: string, agentId: string) {
    resolveSpy = jest
      .spyOn(SessionContextResolver.prototype, 'resolve')
      .mockResolvedValue(agentContext(sessionId, agentId));
    const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService, {
      vaultDiscoveryService: discovery,
    });
    return registry.resolve('devchain_vault_list')!.invoke({ sessionId: sessionId.slice(0, 8) });
  }

  it("lists the caller agent's entries with their status, the approval flag and no value", async () => {
    sqlite
      .prepare("UPDATE vault_entries SET approval_required = 1 WHERE name = 'CHANGED_KEY'")
      .run();
    const result = await callTool(SESSION_ID, 'a-coder');
    sqlite
      .prepare("UPDATE vault_entries SET approval_required = 0 WHERE name = 'CHANGED_KEY'")
      .run();

    expect(result).toEqual({
      success: true,
      data: {
        entries: expect.arrayContaining([
          {
            name: 'TOKEN_A',
            kind: 'secret',
            description: 'TOKEN_A',
            status: 'available',
            approvalRequired: false,
          },
          {
            name: 'SHADOWED_KEY',
            kind: 'secret',
            description: 'SHADOWED_KEY description',
            status: 'available',
            approvalRequired: false,
          },
          {
            name: 'LATE_KEY',
            kind: 'secret',
            description: 'LATE_KEY description',
            status: 'available',
            approvalRequired: false,
          },
          {
            // A gated entry stays `available`: approval is a flag, not a status.
            name: 'CHANGED_KEY',
            kind: 'secret',
            description: 'CHANGED_KEY',
            status: 'available',
            approvalRequired: true,
          },
        ]),
        instructions: vaultListInstructions(),
      },
    });
    const { instructions } = result.data as { instructions: string };
    expect(instructions.split('\n')[0]).toContain('Never print a Vault value');
    expect(instructions).toContain('devchain vault exec --only');
    expect(instructions).toContain('devchain_vault_request');
    const names = (result.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toHaveLength(4);
    expect(names).not.toContain('REVIEWER_ONLY');
    const serialized = JSON.stringify(result);
    for (const canary of [...CANARIES, 'canary-reviewer', 'canary-changed-1']) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('refuses the tool without Vault access, naming why', async () => {
    try {
      await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['reviewer'] });
      expect(await callTool(SESSION_ID, 'a-coder')).toMatchObject({
        success: false,
        error: { code: 'VAULT_ACCESS_DENIED' },
      });
      await storage.setVaultFamilyAccess('A', { mode: 'none' });
      expect(await callTool(SESSION_ID, 'a-coder')).toMatchObject({
        success: false,
        error: { code: 'VAULT_NOT_ENABLED' },
      });
    } finally {
      await storage.setVaultFamilyAccess('A', { mode: 'all' });
    }
  });

  it('refuses a guest session with AGENT_CONTEXT_REQUIRED', async () => {
    resolveSpy = jest.spyOn(SessionContextResolver.prototype, 'resolve').mockResolvedValue({
      success: true,
      data: {
        type: 'guest',
        session: { id: SESSION_ID, status: 'running', startedAt: 'T' },
        project: { id: 'A', name: 'Project A', rootPath: '/tmp/A' },
      },
    } as never);
    const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService, {
      vaultDiscoveryService: discovery,
    });

    expect(
      await registry.resolve('devchain_vault_list')!.invoke({ sessionId: SESSION_ID.slice(0, 8) }),
    ).toMatchObject({ success: false, error: { code: 'AGENT_CONTEXT_REQUIRED' } });
  });

  it('lists a session-only value while its session runs, and drops it when the session stops', async () => {
    sessionValues.set(SESSION_ID, {
      name: 'SESSION_ONLY',
      kind: 'file',
      description: 'Given for this session',
      value: Buffer.from('canary-session-only'),
    });
    const listed = async () =>
      ((await callTool(SESSION_ID, 'a-coder')).data as { entries: Array<{ name: string }> })
        .entries;

    expect(await listed()).toContainEqual({
      name: 'SESSION_ONLY',
      kind: 'file',
      description: 'Given for this session',
      status: 'available',
      approvalRequired: false,
    });
    expect(JSON.stringify(await callTool(SESSION_ID, 'a-coder'))).not.toContain(
      'canary-session-only',
    );
    expect(
      (await discovery.listForSession(OTHER_SESSION_ID, 'a-coder')).map((e) => e.name),
    ).not.toContain('SESSION_ONLY');

    sessionValues.onSessionStopped({ sessionId: SESSION_ID } as never);
    expect((await listed()).map((entry) => entry.name)).not.toContain('SESSION_ONLY');
  });

  it('reports vault_locked for every entry while the Vault is not unlocked', async () => {
    const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
    try {
      const listed = await discovery.listForSession(SESSION_ID, 'a-coder');
      expect(listed.map((entry) => entry.status)).toEqual(listed.map(() => 'vault_locked'));
      expect(listed.length).toBeGreaterThan(0);
    } finally {
      state.mockRestore();
    }
  });
});
