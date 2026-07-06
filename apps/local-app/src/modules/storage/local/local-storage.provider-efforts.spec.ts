import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import { LocalStorageService } from './local-storage.service';

// Backend integration (real :memory: SQLite). Per docs/testing.md, delegate
// behavior is proven cheapest at this layer — mocks cannot catch the
// "schema change silently drops columns" bug class.
describe('LocalStorageService - provider efforts integration', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    const db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });

    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  const createProvider = async (name: string) =>
    service.createProvider({
      name,
      binPath: `/usr/local/bin/${name}`,
    });

  it('createProviderEffort creates an effort with id and timestamps', async () => {
    const provider = await createProvider('provider-create-effort');

    const created = await service.createProviderEffort({
      providerId: provider.id,
      name: '  high  ',
    });

    expect(created.id).toBeTruthy();
    expect(created.providerId).toBe(provider.id);
    expect(created.name).toBe('high');
    expect(created.position).toBe(0);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
  });

  it('createProviderEffort rejects empty/whitespace-only names', async () => {
    const provider = await createProvider('provider-empty-effort');

    await expect(
      service.createProviderEffort({
        providerId: provider.id,
        name: '   ',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('listProviderEffortsByProvider returns efforts ordered by position then id', async () => {
    const provider = await createProvider('provider-order-efforts');

    await service.createProviderEffort({ providerId: provider.id, name: 'effort-c', position: 2 });
    await service.createProviderEffort({ providerId: provider.id, name: 'effort-a', position: 0 });
    await service.createProviderEffort({ providerId: provider.id, name: 'effort-b', position: 1 });

    const efforts = await service.listProviderEffortsByProvider(provider.id);
    expect(efforts.map((effort) => effort.name)).toEqual(['effort-a', 'effort-b', 'effort-c']);
  });

  it('listProviderEffortsByProviderIds returns efforts for multiple providers', async () => {
    const providerA = await createProvider('provider-batch-effort-a');
    const providerB = await createProvider('provider-batch-effort-b');

    await service.createProviderEffort({ providerId: providerA.id, name: 'a-1', position: 1 });
    await service.createProviderEffort({ providerId: providerA.id, name: 'a-0', position: 0 });
    await service.createProviderEffort({ providerId: providerB.id, name: 'b-0', position: 0 });
    await service.createProviderEffort({ providerId: providerB.id, name: 'b-1', position: 1 });

    const efforts = await service.listProviderEffortsByProviderIds([providerB.id, providerA.id]);

    expect(efforts).toHaveLength(4);
    const namesByProvider = efforts.reduce<Record<string, string[]>>((acc, effort) => {
      acc[effort.providerId] = acc[effort.providerId] ?? [];
      acc[effort.providerId].push(effort.name);
      return acc;
    }, {});

    expect(namesByProvider[providerA.id]).toEqual(['a-0', 'a-1']);
    expect(namesByProvider[providerB.id]).toEqual(['b-0', 'b-1']);
  });

  it('listProviderEffortsByProviderIds returns empty for empty input', async () => {
    await expect(service.listProviderEffortsByProviderIds([])).resolves.toEqual([]);
  });

  it('deleteProviderEffort removes an existing effort', async () => {
    const provider = await createProvider('provider-delete-effort');
    const effort = await service.createProviderEffort({
      providerId: provider.id,
      name: 'delete-me',
    });

    await service.deleteProviderEffort(effort.id);

    await expect(service.listProviderEffortsByProvider(provider.id)).resolves.toEqual([]);
  });

  it('bulkCreateProviderEfforts adds new efforts and skips case-insensitive duplicates', async () => {
    const provider = await createProvider('provider-bulk-efforts');
    await service.createProviderEffort({ providerId: provider.id, name: 'high' });

    const result = await service.bulkCreateProviderEfforts(provider.id, [
      'high',
      ' medium ',
      'MEDIUM',
      'high',
    ]);

    expect(result).toEqual({
      added: ['medium'],
      existing: ['high', 'medium'],
    });
    await expect(service.listProviderEffortsByProvider(provider.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'high' }),
        expect.objectContaining({ name: 'medium' }),
      ]),
    );
  });

  it('bulkCreateProviderEfforts auto-increments positions for added efforts', async () => {
    const provider = await createProvider('provider-bulk-positions');
    await service.createProviderEffort({ providerId: provider.id, name: 'low', position: 0 });
    await service.createProviderEffort({ providerId: provider.id, name: 'medium', position: 1 });

    await service.bulkCreateProviderEfforts(provider.id, ['high', 'xhigh']);

    const efforts = await service.listProviderEffortsByProvider(provider.id);
    const positionsByName = Object.fromEntries(efforts.map((e) => [e.name, e.position]));
    expect(positionsByName['low']).toBe(0);
    expect(positionsByName['medium']).toBe(1);
    expect(positionsByName['high']).toBe(2);
    expect(positionsByName['xhigh']).toBe(3);
  });

  it('bulkCreateProviderEfforts returns empty added/existing for empty input', async () => {
    const provider = await createProvider('provider-bulk-empty');
    await expect(service.bulkCreateProviderEfforts(provider.id, [])).resolves.toEqual({
      added: [],
      existing: [],
    });
  });

  it('deleting a provider cascades and deletes its provider efforts', async () => {
    const provider = await createProvider('provider-cascade-efforts');
    await service.createProviderEffort({ providerId: provider.id, name: 'low' });
    await service.createProviderEffort({ providerId: provider.id, name: 'high' });

    await service.deleteProvider(provider.id);

    const rows = sqlite
      .prepare('SELECT COUNT(*) as count FROM provider_efforts WHERE provider_id = ?')
      .get(provider.id) as { count: number };
    expect(rows.count).toBe(0);
  });

  it('maps case-insensitive duplicate effort names to ConflictError', async () => {
    const provider = await createProvider('provider-unique-efforts');
    await service.createProviderEffort({ providerId: provider.id, name: 'high' });

    await expect(
      service.createProviderEffort({
        providerId: provider.id,
        name: 'HIGH',
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.createProviderEffort({
        providerId: provider.id,
        name: 'HIGH',
      }),
    ).rejects.toThrow('already exists for this provider');
  });
});
