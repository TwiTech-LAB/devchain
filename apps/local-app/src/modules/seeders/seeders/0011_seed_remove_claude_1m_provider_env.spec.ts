import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { createStorageDelegateContext } from '../../storage/local/delegates/base-storage.delegate';
import { ProviderStorageDelegate } from '../../storage/local/delegates/provider.delegate';
import type { Provider } from '../../storage/models/domain.models';
import type { SeederContext } from '../types/seeder.types';
import { runSeedRemoveClaude1mProviderEnv } from './0011_seed_remove_claude_1m_provider_env';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const TARGET_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const DISABLE_KEY = 'CLAUDE_CODE_DISABLE_1M_CONTEXT';
const TS = '2026-07-26T00:00:00.000Z';

describe('0011_seed_remove_claude_1m_provider_env', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let delegate: ProviderStorageDelegate;
  let storage: StorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');

    delegate = new ProviderStorageDelegate(createStorageDelegateContext(db), {
      updateProvider: async (id, data) => delegate.updateProvider(id, data),
    });
    storage = {
      listProviders: (options) => delegate.listProviders(options),
      listEnvScopesByProviderIds: (providerIds) => delegate.listEnvScopesByProviderIds(providerIds),
      updateProviderWithScopes: async (id, data, envScopes, currentEnvKeys) =>
        delegate.updateProviderWithScopes(id, data, envScopes, currentEnvKeys),
    } as unknown as StorageService;
  });

  afterEach(() => {
    sqlite.close();
  });

  function createContext(storageOverride: StorageService = storage): SeederContext {
    return {
      storage: storageOverride,
      watchersService: {} as SeederContext['watchersService'],
      providerEffortSeeding: {} as SeederContext['providerEffortSeeding'],
      db,
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  function insertProvider(name: string, env: Record<string, string> | null): Provider {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO providers
         (id, name, mcp_configured, auto_compact_threshold, env, created_at, updated_at)
         VALUES (?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(id, name, env ? JSON.stringify(env) : null, TS, TS);

    return {
      id,
      name,
      binPath: null,
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      autoCompactThreshold: null,
      env,
      createdAt: TS,
      updatedAt: TS,
    };
  }

  function insertProject(name: string): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name, `/tmp/${id}`, TS, TS);
    return id;
  }

  function insertScope(providerId: string, envKey: string, projectId: string): void {
    sqlite
      .prepare(
        `INSERT INTO provider_env_scopes
         (provider_id, env_key, project_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(providerId, envKey, projectId, TS);
  }

  function readEnv(providerId: string): Record<string, string> | null {
    const row = sqlite.prepare('SELECT env FROM providers WHERE id = ?').get(providerId) as {
      env: string | null;
    };
    return row.env ? (JSON.parse(row.env) as Record<string, string>) : null;
  }

  function readScopes(providerId: string): Array<{ env_key: string; project_id: string }> {
    return sqlite
      .prepare(
        `SELECT env_key, project_id
         FROM provider_env_scopes
         WHERE provider_id = ?
         ORDER BY env_key, project_id`,
      )
      .all(providerId) as Array<{ env_key: string; project_id: string }>;
  }

  it('removes only the exact Claude window and its scopes while preserving unrelated state', async () => {
    const project1 = insertProject('one');
    const project2 = insertProject('two');
    const claude = insertProvider('Claude', {
      [TARGET_KEY]: '1000000',
      [DISABLE_KEY]: '1',
      OTHER_KEY: 'keep',
    });
    const codex = insertProvider('codex', { [TARGET_KEY]: '1000000' });

    insertScope(claude.id, TARGET_KEY, project1);
    insertScope(claude.id, TARGET_KEY, project2);
    insertScope(claude.id, DISABLE_KEY, project2);
    insertScope(claude.id, 'OTHER_KEY', project1);
    insertScope(codex.id, TARGET_KEY, project1);

    await runSeedRemoveClaude1mProviderEnv(createContext());

    expect(readEnv(claude.id)).toEqual({
      [DISABLE_KEY]: '1',
      OTHER_KEY: 'keep',
    });
    expect(readScopes(claude.id)).toEqual([
      { env_key: DISABLE_KEY, project_id: project2 },
      { env_key: 'OTHER_KEY', project_id: project1 },
    ]);
    expect(readEnv(codex.id)).toEqual({ [TARGET_KEY]: '1000000' });
    expect(readScopes(codex.id)).toEqual([{ env_key: TARGET_KEY, project_id: project1 }]);
  });

  it('normalizes an emptied Claude env to null', async () => {
    const project = insertProject('one');
    const claude = insertProvider('claude', { [TARGET_KEY]: '1000000' });
    insertScope(claude.id, TARGET_KEY, project);

    await runSeedRemoveClaude1mProviderEnv(createContext());

    expect(readEnv(claude.id)).toBeNull();
    expect(readScopes(claude.id)).toEqual([]);
  });

  it('leaves non-exact Claude window values and their scopes unchanged', async () => {
    const project = insertProject('one');
    const claude = insertProvider('claude', { [TARGET_KEY]: '1000000 ' });
    insertScope(claude.id, TARGET_KEY, project);

    await runSeedRemoveClaude1mProviderEnv(createContext());

    expect(readEnv(claude.id)).toEqual({ [TARGET_KEY]: '1000000 ' });
    expect(readScopes(claude.id)).toEqual([{ env_key: TARGET_KEY, project_id: project }]);
  });

  it('rolls back env and scope mutations when scope replacement fails', async () => {
    const project = insertProject('one');
    const claude = insertProvider('claude', {
      [TARGET_KEY]: '1000000',
      OTHER_KEY: 'keep',
    });
    insertScope(claude.id, TARGET_KEY, project);
    insertScope(claude.id, 'OTHER_KEY', project);
    const failingStorage = {
      ...storage,
      updateProviderWithScopes: async (
        id: string,
        data: Parameters<StorageService['updateProviderWithScopes']>[1],
      ) =>
        new TransactionRunner(sqlite).runImmediate(() => {
          sqlite
            .prepare('UPDATE providers SET env = ? WHERE id = ?')
            .run(data.env ? JSON.stringify(data.env) : null, id);
          sqlite
            .prepare('DELETE FROM provider_env_scopes WHERE provider_id = ? AND env_key = ?')
            .run(id, TARGET_KEY);
          throw new Error('injected scope failure');
        }),
    } as StorageService;

    await expect(runSeedRemoveClaude1mProviderEnv(createContext(failingStorage))).rejects.toThrow(
      'injected scope failure',
    );

    expect(readEnv(claude.id)).toEqual({
      [TARGET_KEY]: '1000000',
      OTHER_KEY: 'keep',
    });
    expect(readScopes(claude.id)).toEqual([
      { env_key: TARGET_KEY, project_id: project },
      { env_key: 'OTHER_KEY', project_id: project },
    ]);
  });
});
