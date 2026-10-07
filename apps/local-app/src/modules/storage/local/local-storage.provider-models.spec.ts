import { LocalStorageService } from './local-storage.service';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';

describe('LocalStorageService provider catalog', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  beforeEach(() => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    service = new LocalStorageService(database.db);
  });
  afterEach(() => sqlite.close());
  describe('LocalStorageService - provider models integration', () => {
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

  // Backend integration (real :memory: SQLite). Per docs/testing.md, delegate
  // behavior is proven cheapest at this layer — mocks cannot catch the
  // "schema change silently drops columns" bug class.
  describe('LocalStorageService - provider efforts integration', () => {
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

      await service.createProviderEffort({
        providerId: provider.id,
        name: 'effort-c',
        position: 2,
      });
      await service.createProviderEffort({
        providerId: provider.id,
        name: 'effort-a',
        position: 0,
      });
      await service.createProviderEffort({
        providerId: provider.id,
        name: 'effort-b',
        position: 1,
      });

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

  // Backend integration (real :memory: SQLite). This is the cheapest layer that proves
  // the composite upsert targets, boolean mapping, and delete result contract together.
  describe('LocalStorageService - provider plugin policy integration', () => {
    beforeEach(() => {
      sqlite
        .prepare(
          `INSERT INTO projects
          (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, ?, ?)`,
        )
        .run('project-1', 'Project One', '/tmp/project-one', 'created', 'updated');
    });

    it('upserts one default row and one project override per composite key', async () => {
      const provider = await service.createProvider({ name: 'claude' });

      const initialDefault = await service.upsertProviderPluginDefault({
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: true,
      });
      const updatedDefault = await service.upsertProviderPluginDefault({
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: false,
      });
      await service.upsertProjectProviderPluginOverride({
        projectId: 'project-1',
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: true,
      });
      const updatedOverride = await service.upsertProjectProviderPluginOverride({
        projectId: 'project-1',
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: false,
      });

      expect(updatedDefault).toMatchObject({
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: false,
        createdAt: initialDefault.createdAt,
      });
      expect(updatedOverride).toMatchObject({
        projectId: 'project-1',
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: false,
      });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM provider_plugin_defaults').get(),
      ).toEqual({
        count: 1,
      });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM project_provider_plugin_overrides').get(),
      ).toEqual({ count: 1 });
    });

    it('lists exact case-sensitive plugin IDs and resets rows idempotently', async () => {
      const provider = await service.createProvider({ name: 'codex' });
      await service.upsertProviderPluginDefault({
        providerId: provider.id,
        pluginId: 'Alpha@marketplace',
        enabled: true,
      });
      await service.upsertProviderPluginDefault({
        providerId: provider.id,
        pluginId: 'alpha@marketplace',
        enabled: false,
      });
      await service.upsertProjectProviderPluginOverride({
        projectId: 'project-1',
        providerId: provider.id,
        pluginId: 'stale-plugin@removed-marketplace',
        enabled: true,
      });

      await expect(service.listProviderPluginDefaults(provider.id)).resolves.toEqual([
        expect.objectContaining({ pluginId: 'Alpha@marketplace', enabled: true }),
        expect.objectContaining({ pluginId: 'alpha@marketplace', enabled: false }),
      ]);
      await expect(
        service.deleteProjectProviderPluginOverride(
          'project-1',
          provider.id,
          'stale-plugin@removed-marketplace',
        ),
      ).resolves.toBe(true);
      await expect(
        service.deleteProjectProviderPluginOverride(
          'project-1',
          provider.id,
          'stale-plugin@removed-marketplace',
        ),
      ).resolves.toBe(false);
    });
  });
});
