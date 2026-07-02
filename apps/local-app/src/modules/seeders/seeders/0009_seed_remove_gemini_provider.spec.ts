import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../types/seeder.types';
import {
  runSeedRemoveGeminiProvider,
  seedRemoveGeminiProviderSeeder,
} from './0009_seed_remove_gemini_provider';

const TS = '2024-01-01T00:00:00.000Z';

describe('0009_seed_remove_gemini_provider', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // FK-accurate minimal schema for the providers ← configs ← agents chain,
    // plus sessions (RESTRICT child of agents) and provider_models (CASCADE
    // child of providers, to prove the cascade fires). foreign_keys = ON so the
    // seeder's deletion ORDER is genuinely exercised.
    sqlite.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE projects (id TEXT PRIMARY KEY);

      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE provider_models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE
      );

      CREATE TABLE profile_provider_configs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
        provider_config_id TEXT NOT NULL REFERENCES profile_provider_configs(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
    `);
    db = drizzle(sqlite);

    // Shared fixtures: one project + profile used by all providers' agents.
    sqlite.prepare('INSERT INTO projects (id) VALUES (?)').run('proj-1');
    sqlite
      .prepare('INSERT INTO agent_profiles (id, project_id) VALUES (?, ?)')
      .run('prof-1', 'proj-1');
  });

  afterEach(() => {
    sqlite.close();
  });

  function createContext(logger?: Partial<Record<'info' | 'debug', jest.Mock>>): SeederContext {
    return {
      storage: {} as StorageService,
      watchersService: {} as WatchersService,
      db,
      logger: {
        info: logger?.info ?? jest.fn(),
        debug: logger?.debug ?? jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  function insertProvider(id: string, name: string): void {
    sqlite.prepare('INSERT INTO providers (id, name) VALUES (?, ?)').run(id, name);
  }

  function insertConfig(id: string, providerId: string, position: number): void {
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs
         (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES (?, 'prof-1', ?, ?, ?, ?, ?)`,
      )
      .run(id, providerId, `cfg-${id}`, position, TS, TS);
  }

  function insertAgent(id: string, configId: string): void {
    sqlite
      .prepare(
        `INSERT INTO agents
         (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, 'proj-1', 'prof-1', ?, ?, ?, ?)`,
      )
      .run(id, configId, `agent-${id}`, TS, TS);
  }

  function insertSession(id: string, agentId: string, status: string): void {
    sqlite
      .prepare('INSERT INTO sessions (id, agent_id, status, started_at) VALUES (?, ?, ?, ?)')
      .run(id, agentId, status, TS);
  }

  function count(table: string): number {
    return (sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  function fkViolations(): unknown[] {
    return sqlite.prepare('PRAGMA foreign_key_check').all();
  }

  it('is a no-op on a DB with no gemini rows (logs skip, leaves other providers intact)', async () => {
    insertProvider('p-claude', 'claude');
    insertProvider('pm-1', 'codex'); // second non-gemini provider
    insertConfig('c-claude', 'p-claude', 0);
    insertAgent('a-claude', 'c-claude');
    insertSession('s-claude', 'a-claude', 'stopped');
    const debug = jest.fn();
    const info = jest.fn();

    await runSeedRemoveGeminiProvider(createContext({ info, debug }));

    expect(count('providers')).toBe(2);
    expect(count('profile_provider_configs')).toBe(1);
    expect(count('agents')).toBe(1);
    expect(count('sessions')).toBe(1);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ seederName: '0009_seed_remove_gemini_provider' }),
      'No gemini provider rows; skipping',
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('removes a gemini provider with config + agent + sessions, leaving other providers untouched', async () => {
    // Control: a claude provider with its own agent + session must survive.
    insertProvider('p-claude', 'claude');
    insertConfig('c-claude', 'p-claude', 0);
    insertAgent('a-claude', 'c-claude');
    insertSession('s-claude', 'a-claude', 'running');

    // Target: gemini provider + cascade dependents (incl. a 'running' session,
    // which must be force-deleted since the provider no longer exists).
    insertProvider('p-gem', 'gemini');
    sqlite
      .prepare('INSERT INTO provider_models (id, provider_id) VALUES (?, ?)')
      .run('pm-gem', 'p-gem');
    insertConfig('c-gem', 'p-gem', 1);
    insertAgent('a-gem', 'c-gem');
    insertSession('s-gem-1', 'a-gem', 'running');
    insertSession('s-gem-2', 'a-gem', 'stopped');
    const info = jest.fn();

    await runSeedRemoveGeminiProvider(createContext({ info }));

    // Gemini side fully removed...
    expect(
      sqlite.prepare("SELECT count(*) AS c FROM providers WHERE name = 'gemini'").get(),
    ).toEqual({ c: 0 });
    expect(count('provider_models')).toBe(0); // CASCADE from providers fired
    expect(sqlite.prepare('SELECT id FROM agents').all()).toEqual([{ id: 'a-claude' }]);
    expect(sqlite.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's-claude' }]);
    expect(sqlite.prepare('SELECT id FROM profile_provider_configs').all()).toEqual([
      { id: 'c-claude' },
    ]);
    // ...control provider intact, and DB has no dangling FK references.
    expect(count('providers')).toBe(1);
    expect(fkViolations()).toEqual([]);

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0009_seed_remove_gemini_provider',
        providersMatched: 1,
        sessionsDeleted: 2,
        agentsDeleted: 1,
        configsDeleted: 1,
        providersDeleted: 1,
      }),
      'Removed stranded gemini provider records',
    );
  });

  it('removes multiple gemini provider rows (case-insensitive) with their dependents', async () => {
    // Two distinct provider rows both resolving to gemini (UNIQUE name is
    // case-sensitive in SQLite, so 'gemini' and 'Gemini' coexist). Both match
    // `lower(name) = 'gemini'`.
    insertProvider('p-gem-1', 'gemini');
    insertProvider('p-gem-2', 'Gemini');
    insertConfig('c-gem-1', 'p-gem-1', 0);
    insertConfig('c-gem-2', 'p-gem-2', 1);
    insertAgent('a-gem-1', 'c-gem-1');
    insertAgent('a-gem-2', 'c-gem-2');
    insertSession('s-gem-1', 'a-gem-1', 'stopped');
    insertSession('s-gem-2', 'a-gem-2', 'stopped');
    const info = jest.fn();

    await runSeedRemoveGeminiProvider(createContext({ info }));

    expect(count('providers')).toBe(0);
    expect(count('profile_provider_configs')).toBe(0);
    expect(count('agents')).toBe(0);
    expect(count('sessions')).toBe(0);
    expect(fkViolations()).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        providersMatched: 2,
        sessionsDeleted: 2,
        agentsDeleted: 2,
        configsDeleted: 2,
        providersDeleted: 2,
      }),
      'Removed stranded gemini provider records',
    );
  });

  it('is idempotent — a second run after cleanup is a no-op', async () => {
    insertProvider('p-gem', 'gemini');
    insertConfig('c-gem', 'p-gem', 0);
    insertAgent('a-gem', 'c-gem');
    insertSession('s-gem', 'a-gem', 'stopped');
    const debug = jest.fn();
    const info = jest.fn();

    await runSeedRemoveGeminiProvider(createContext({ info, debug }));
    await runSeedRemoveGeminiProvider(createContext({ info, debug }));

    expect(count('providers')).toBe(0);
    // First run logged the cleanup; second run logged the skip.
    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ seederName: '0009_seed_remove_gemini_provider' }),
      'No gemini provider rows; skipping',
    );
  });

  it('exports seeder metadata and run function', () => {
    expect(seedRemoveGeminiProviderSeeder).toMatchObject({
      name: '0009_seed_remove_gemini_provider',
      version: 1,
      run: runSeedRemoveGeminiProvider,
    });
  });
});
