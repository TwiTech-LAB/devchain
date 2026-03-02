import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - provider models integration', () => {
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

  it('createProviderModel creates a model with id and timestamps', async () => {
    const provider = await createProvider('provider-create-model');

    const created = await service.createProviderModel({
      providerId: provider.id,
      name: '  openai/gpt-4.1  ',
    });

    expect(created.id).toBeTruthy();
    expect(created.providerId).toBe(provider.id);
    expect(created.name).toBe('openai/gpt-4.1');
    expect(created.position).toBe(0);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
  });

  it('createProviderModel rejects empty/whitespace-only names', async () => {
    const provider = await createProvider('provider-empty-model');

    await expect(
      service.createProviderModel({
        providerId: provider.id,
        name: '   ',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('listProviderModelsByProvider returns models ordered by position', async () => {
    const provider = await createProvider('provider-order-models');

    await service.createProviderModel({ providerId: provider.id, name: 'model-c', position: 2 });
    await service.createProviderModel({ providerId: provider.id, name: 'model-a', position: 0 });
    await service.createProviderModel({ providerId: provider.id, name: 'model-b', position: 1 });

    const models = await service.listProviderModelsByProvider(provider.id);
    expect(models.map((model) => model.name)).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('listProviderModelsByProviderIds returns models for multiple providers', async () => {
    const providerA = await createProvider('provider-batch-a');
    const providerB = await createProvider('provider-batch-b');

    await service.createProviderModel({ providerId: providerA.id, name: 'a-1', position: 1 });
    await service.createProviderModel({ providerId: providerA.id, name: 'a-0', position: 0 });
    await service.createProviderModel({ providerId: providerB.id, name: 'b-0', position: 0 });
    await service.createProviderModel({ providerId: providerB.id, name: 'b-1', position: 1 });

    const models = await service.listProviderModelsByProviderIds([providerB.id, providerA.id]);

    expect(models).toHaveLength(4);
    const namesByProvider = models.reduce<Record<string, string[]>>((acc, model) => {
      acc[model.providerId] = acc[model.providerId] ?? [];
      acc[model.providerId].push(model.name);
      return acc;
    }, {});

    expect(namesByProvider[providerA.id]).toEqual(['a-0', 'a-1']);
    expect(namesByProvider[providerB.id]).toEqual(['b-0', 'b-1']);
  });

  it('deleteProviderModel removes an existing model', async () => {
    const provider = await createProvider('provider-delete-model');
    const model = await service.createProviderModel({
      providerId: provider.id,
      name: 'delete-me',
    });

    await service.deleteProviderModel(model.id);

    await expect(service.listProviderModelsByProvider(provider.id)).resolves.toEqual([]);
  });

  it('bulkCreateProviderModels adds new models and skips case-insensitive duplicates', async () => {
    const provider = await createProvider('provider-bulk-models');
    await service.createProviderModel({ providerId: provider.id, name: 'gpt-4.1' });

    const result = await service.bulkCreateProviderModels(provider.id, [
      'gpt-4.1',
      ' claude-sonnet-4 ',
      'CLAUDE-SONNET-4',
      'gpt-4.1',
    ]);

    expect(result).toEqual({
      added: ['claude-sonnet-4'],
      existing: ['gpt-4.1', 'claude-sonnet-4'],
    });
    await expect(service.listProviderModelsByProvider(provider.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'gpt-4.1' }),
        expect.objectContaining({ name: 'claude-sonnet-4' }),
      ]),
    );
  });

  it('deleting a provider cascades and deletes its provider models', async () => {
    const provider = await createProvider('provider-cascade-models');
    await service.createProviderModel({ providerId: provider.id, name: 'model-a' });
    await service.createProviderModel({ providerId: provider.id, name: 'model-b' });

    await service.deleteProvider(provider.id);

    const rows = sqlite
      .prepare('SELECT COUNT(*) as count FROM provider_models WHERE provider_id = ?')
      .get(provider.id) as { count: number };
    expect(rows.count).toBe(0);
  });

  it('maps case-insensitive duplicate model names to ConflictError', async () => {
    const provider = await createProvider('provider-unique-models');
    await service.createProviderModel({ providerId: provider.id, name: 'openai/gpt-4.1' });

    await expect(
      service.createProviderModel({
        providerId: provider.id,
        name: 'OPENAI/GPT-4.1',
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.createProviderModel({
        providerId: provider.id,
        name: 'OPENAI/GPT-4.1',
      }),
    ).rejects.toThrow('already exists for this provider');
  });
});
