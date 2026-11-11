/**
 * `devchain_vault_request` from the MCP binding down to storage. Test layer: storage
 * integration through the real tool binding. The classification joins access rows,
 * grants, owner scope and name precedence in a migrated DB, and the handler maps each
 * refusal to its MCP code; only the store's event sink is a stub.
 */
jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../common/test/test-database.helper';
import type { EventsService } from '../events/services/events.service';
import { createMcpToolBindingRegistryFixture } from '../mcp/services/testing/mcp-tool-binding-registry.fixture';
import { SessionContextResolver } from '../mcp/services/utils/session-context-resolver';
import type { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import type { StorageService } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import type { SessionRowStore } from '../storage/sessions/session-row.store';
import type { VaultEntryProjectAccess } from '../storage/models/domain.models';
import { VaultAccessService } from '../vault/vault-access.service';
import { VaultEntriesService } from '../vault/vault-entries.service';
import type { VaultKeyService } from '../vault/vault-key.service';
import type { VaultSessionValue } from '../vault/vault-session-overlay';
import { VaultUseApprovalStore } from '../vault/vault-use-approvals';
import { VaultRequestService } from './vault-request.service';
import { VaultRequestStore } from './vault-request.store';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('devchain_vault_request', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let store: VaultRequestStore;
  let sessionValues: VaultSessionValue[];
  let ids: Record<string, string>;
  let resolveSpy: jest.SpyInstance;

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(database.db);
    const insert = (sql: string) => sqlite.prepare(sql).run();
    insert(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
            VALUES ('A', 'Project A', '/tmp/A', 'T', 'T'), ('B', 'Project B', '/tmp/B', 'T', 'T')`);
    insert(`INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
            VALUES ('p-coder', 'A', 'Coder', ' Coder ', 'T', 'T'),
                   ('p-reviewer', 'A', 'Reviewer', 'reviewer', 'T', 'T')`);
    insert(`INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
            VALUES ('prov', 'claude', 0, 'T', 'T')`);
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'Coder', 0, 'T', 'T')`);
    insert(`INSERT INTO agents
              (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
            VALUES ('a-coder', 'A', 'p-coder', 'c-coder', 'Coder', 'T', 'T')`);

    const entry = async (
      name: string,
      projects: VaultEntryProjectAccess[],
      kind: 'secret' | 'file' = 'secret',
    ) => {
      const id = `${name}-${projects.map((p) => p.projectId).join('') || 'shared'}`;
      await storage.createVaultEntry({
        id,
        projects,
        name,
        kind,
        description: name,
        valueCiphertext: 'sealed',
      });
      return id;
    };
    const reviewers = { projectId: 'A', mode: 'families' as const, familySlugs: ['reviewer'] };
    ids = {
      granted: await entry('GRANTED_KEY', [{ projectId: 'A', mode: 'all' }]),
      sharedDual: await entry('DUAL_KEY', []),
      projectDual: await entry('DUAL_KEY', [reviewers]),
      shared: await entry('SHARED_KEY', [], 'file'),
      otherProject: await entry('B_ONLY', [{ projectId: 'B', mode: 'all' }]),
    };
    await storage.setVaultFamilyAccess('A', { mode: 'all' });

    sessionValues = [];
    const vault = {} as VaultKeyService;
    const access = new VaultAccessService(storage, vault, { valuesFor: () => sessionValues });
    const adapters = {
      getSupportedProviders: () => [],
      getAdapter: () => ({}),
    } as unknown as ProviderAdapterFactory;
    store = new VaultRequestStore({ publish: async () => 'event-id' } as unknown as EventsService);
    const service = new VaultRequestService(
      storage,
      access,
      new VaultEntriesService(storage, vault, adapters, access),
      store,
      // No entry here needs approval, so the session check behind the store never runs.
      new VaultUseApprovalStore({} as SessionRowStore),
    );
    resolveSpy = jest.spyOn(SessionContextResolver.prototype, 'resolve').mockResolvedValue({
      success: true,
      data: {
        type: 'agent',
        session: { id: SESSION_ID, agentId: 'a-coder', status: 'running', startedAt: 'T' },
        agent: { id: 'a-coder', name: 'Coder', projectId: 'A' },
        project: { id: 'A', name: 'Project A', rootPath: '/tmp/A' },
      },
    });
    const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService, {
      vaultRequestService: service,
    });
    const tool = registry.resolve('devchain_vault_request')!;
    // `McpService` parses with the tool schema before it invokes the binding.
    callTool = async (params) => {
      const parsed = tool.paramsSchema!.safeParse({
        sessionId: SESSION_ID.slice(0, 8),
        description: 'Needed to deploy',
        ...params,
      });
      if (!parsed.success) return { success: false, error: { code: 'VALIDATION_ERROR' } };
      return tool.invoke(parsed.data);
    };
  });

  afterEach(() => {
    store.onModuleDestroy();
    resolveSpy.mockRestore();
    sqlite.close();
  });

  let callTool: (params: Record<string, unknown>) => Promise<unknown>;

  it('reports an entry the agent already has, stored or given for this session', async () => {
    expect(await callTool({ name: 'GRANTED_KEY' })).toEqual({
      success: true,
      data: { status: 'available', name: 'GRANTED_KEY' },
    });
    sessionValues = [
      { name: 'SESSION_KEY', kind: 'secret', description: 'Session only', value: Buffer.from('x') },
    ];
    expect(await callTool({ name: 'SESSION_KEY' })).toMatchObject({
      data: { status: 'available' },
    });
    expect(store.listPending()).toEqual([]);
  });

  it("asks for a grant of the project's own entry before a shared one of the same name", async () => {
    const result = await callTool({ name: 'DUAL_KEY', kind: 'file' });

    expect(result).toMatchObject({ success: true, data: { status: 'pending', type: 'grant' } });
    expect(store.listPending()).toEqual([
      expect.objectContaining({
        type: 'grant',
        entryId: ids.projectDual,
        kind: 'secret',
        familySlug: 'coder',
      }),
    ]);
  });

  it('asks for a grant of a shared entry and keeps its kind', async () => {
    await callTool({ name: 'SHARED_KEY' });

    expect(store.listPending()).toEqual([
      expect.objectContaining({ type: 'grant', entryId: ids.shared, kind: 'file' }),
    ]);
  });

  it.each([
    ['an absent name, secret by default', 'NEW_KEY', undefined, 'secret'],
    ['an absent name of the given kind', 'NEW_PEM', 'file', 'file'],
    ['a name only another project owns', 'B_ONLY', undefined, 'secret'],
  ])('asks to create %s', async (_label, name, kind, expectedKind) => {
    const result = await callTool({ name, ...(kind && { kind }) });

    expect(result).toMatchObject({ data: { status: 'pending', type: 'create', name } });
    expect(store.listPending()).toEqual([
      expect.objectContaining({
        type: 'create',
        entryId: null,
        kind: expectedKind,
        description: 'Needed to deploy',
      }),
    ]);
  });

  it('returns the pending request again for the same name', async () => {
    const first = (await callTool({ name: 'NEW_KEY' })) as { data: { requestId: string } };
    const again = await callTool({ name: 'NEW_KEY', description: 'Still needed' });

    expect(again).toMatchObject({
      data: { status: 'already_pending', requestId: first.data.requestId },
    });
    expect(store.listPending()).toHaveLength(1);
  });

  it.each([
    ['a reserved name', { name: 'DEVCHAIN_TOKEN' }, 'VAULT_ENTRY_NAME_RESERVED'],
    ['a name that is not an env var', { name: '1BAD-NAME' }, 'VAULT_ENTRY_NAME_INVALID'],
    ['a value field', { name: 'NEW_KEY', value: 'x' }, 'VALIDATION_ERROR'],
  ])('refuses %s', async (_label, params, code) => {
    const result = await callTool(params);

    expect(result).toMatchObject({ success: false, error: { code } });
    expect(store.listPending()).toEqual([]);
  });

  it('refuses an agent without Vault access', async () => {
    await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['reviewer'] });
    expect(await callTool({ name: 'NEW_KEY' })).toMatchObject({
      error: { code: 'VAULT_ACCESS_DENIED' },
    });
    await storage.setVaultFamilyAccess('A', { mode: 'none' });
    expect(await callTool({ name: 'NEW_KEY' })).toMatchObject({
      error: { code: 'VAULT_NOT_ENABLED' },
    });
    expect(store.listPending()).toEqual([]);
  });
});
