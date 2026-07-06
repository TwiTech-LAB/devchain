import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';

// Backend integration (real :memory: SQLite). Proves the agent effort_override
// and config model/effort columns survive create/get/list/update through the
// delegates. This is the only layer that catches the "schema change silently
// drops columns" bug class called out in the task spec.
describe('LocalStorageService - effort overrides and config defaults mapper round-trip', () => {
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

  // Builds: project → provider → agent profile → profile provider config.
  // Returns the ids needed to create agents and exercise config round-trips.
  const setupChain = async () => {
    const project = await service.createProject({
      name: 'round-trip-project',
      description: null,
      rootPath: '/tmp/round-trip-project',
      isTemplate: false,
    });
    const provider = await service.createProvider({
      name: 'claude-rt',
      binPath: '/usr/local/bin/claude',
    });
    const profile = await service.createAgentProfile({
      projectId: project.id,
      name: 'rt-profile',
    });
    return { projectId: project.id, providerId: provider.id, profileId: profile.id };
  };

  const createConfig = (chain: { profileId: string; providerId: string }, name: string) =>
    service.createProfileProviderConfig({
      profileId: chain.profileId,
      providerId: chain.providerId,
      name,
      options: null,
      env: null,
    });

  describe('agent effort_override round-trip', () => {
    it('createAgent persists effortOverride and getAgent reads it back', async () => {
      const chain = await setupChain();
      const config = await createConfig(chain, 'cfg-effort-create');

      const created = await service.createAgent({
        projectId: chain.projectId,
        profileId: chain.profileId,
        providerConfigId: config.id,
        name: 'agent-effort-create',
        effortOverride: 'high',
      });

      expect(created.effortOverride).toBe('high');

      const fetched = await service.getAgent(created.id);
      expect(fetched.effortOverride).toBe('high');
    });

    it('createAgent defaults effortOverride to null when omitted', async () => {
      const chain = await setupChain();
      const config = await createConfig(chain, 'cfg-effort-null');

      const created = await service.createAgent({
        projectId: chain.projectId,
        profileId: chain.profileId,
        providerConfigId: config.id,
        name: 'agent-effort-null',
      });

      expect(created.effortOverride).toBeNull();

      const fetched = await service.getAgent(created.id);
      expect(fetched.effortOverride).toBeNull();
    });

    it('listAgents surfaces effortOverride for each agent', async () => {
      const chain = await setupChain();
      const configA = await createConfig(chain, 'cfg-list-a');
      const configB = await createConfig(chain, 'cfg-list-b');

      await service.createAgent({
        projectId: chain.projectId,
        profileId: chain.profileId,
        providerConfigId: configA.id,
        name: 'agent-list-a',
        effortOverride: 'medium',
      });
      await service.createAgent({
        projectId: chain.projectId,
        profileId: chain.profileId,
        providerConfigId: configB.id,
        name: 'agent-list-b',
      });

      const result = await service.listAgents(chain.projectId);
      const byName = Object.fromEntries(result.items.map((a) => [a.name, a.effortOverride]));
      expect(byName['agent-list-a']).toBe('medium');
      expect(byName['agent-list-b']).toBeNull();
    });

    it('updateAgent changes effortOverride and the change is readable', async () => {
      const chain = await setupChain();
      const config = await createConfig(chain, 'cfg-effort-update');

      const created = await service.createAgent({
        projectId: chain.projectId,
        profileId: chain.profileId,
        providerConfigId: config.id,
        name: 'agent-effort-update',
        effortOverride: 'low',
      });

      const updated = await service.updateAgent(created.id, { effortOverride: 'xhigh' });
      expect(updated.effortOverride).toBe('xhigh');

      const refetched = await service.getAgent(created.id);
      expect(refetched.effortOverride).toBe('xhigh');
    });

    it('updateAgent can clear effortOverride back to null', async () => {
      const chain = await setupChain();
      const config = await createConfig(chain, 'cfg-effort-clear');

      const created = await service.createAgent({
        projectId: chain.projectId,
        profileId: chain.profileId,
        providerConfigId: config.id,
        name: 'agent-effort-clear',
        effortOverride: 'high',
      });

      const updated = await service.updateAgent(created.id, { effortOverride: null });
      expect(updated.effortOverride).toBeNull();
    });
  });

  describe('profile provider config model/effort round-trip', () => {
    it('createProfileProviderConfig persists model/effort and get reads them back', async () => {
      const chain = await setupChain();

      const created = await service.createProfileProviderConfig({
        profileId: chain.profileId,
        providerId: chain.providerId,
        name: 'cfg-defaults-create',
        options: null,
        env: null,
        model: 'claude-sonnet-4',
        effort: 'high',
      });

      expect(created.model).toBe('claude-sonnet-4');
      expect(created.effort).toBe('high');

      const fetched = await service.getProfileProviderConfig(created.id);
      expect(fetched.model).toBe('claude-sonnet-4');
      expect(fetched.effort).toBe('high');
    });

    it('createProfileProviderConfig defaults model/effort to null when omitted', async () => {
      const chain = await setupChain();

      const created = await createConfig(chain, 'cfg-defaults-null');

      expect(created.model).toBeNull();
      expect(created.effort).toBeNull();

      const fetched = await service.getProfileProviderConfig(created.id);
      expect(fetched.model).toBeNull();
      expect(fetched.effort).toBeNull();
    });

    it('listProfileProviderConfigsByProfile surfaces model/effort', async () => {
      const chain = await setupChain();

      await service.createProfileProviderConfig({
        profileId: chain.profileId,
        providerId: chain.providerId,
        name: 'cfg-list-defaults',
        options: null,
        env: null,
        model: 'gpt-4o',
        effort: 'medium',
      });
      await createConfig(chain, 'cfg-list-plain');

      const configs = await service.listProfileProviderConfigsByProfile(chain.profileId);
      const byName = Object.fromEntries(
        configs.map((c) => [c.name, { model: c.model, effort: c.effort }]),
      );
      expect(byName['cfg-list-defaults']).toEqual({ model: 'gpt-4o', effort: 'medium' });
      expect(byName['cfg-list-plain']).toEqual({ model: null, effort: null });
    });

    it('updateProfileProviderConfig changes model/effort and the change is readable', async () => {
      const chain = await setupChain();
      const config = await createConfig(chain, 'cfg-defaults-update');

      await service.updateProfileProviderConfig(config.id, {
        model: 'opus',
        effort: 'max',
      });

      const fetched = await service.getProfileProviderConfig(config.id);
      expect(fetched.model).toBe('opus');
      expect(fetched.effort).toBe('max');
    });

    it('updateProfileProviderConfig can clear model/effort back to null', async () => {
      const chain = await setupChain();
      const config = await service.createProfileProviderConfig({
        profileId: chain.profileId,
        providerId: chain.providerId,
        name: 'cfg-defaults-clear',
        options: null,
        env: null,
        model: 'sonnet',
        effort: 'high',
      });

      await service.updateProfileProviderConfig(config.id, { model: null, effort: null });

      const fetched = await service.getProfileProviderConfig(config.id);
      expect(fetched.model).toBeNull();
      expect(fetched.effort).toBeNull();
    });
  });
});
