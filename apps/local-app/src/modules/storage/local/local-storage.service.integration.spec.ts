import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
  ConflictError,
} from '../../../common/errors/error-types';
import type { Project, Provider, AgentProfile, Agent, Status } from '../models/domain.models';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('LocalStorageService', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // --- Seed helpers ---

  async function seedProject(name = 'Test Project'): Promise<Project> {
    return service.createProject({
      name,
      rootPath: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}`,
      description: null,
    });
  }

  async function seedProvider(name = 'test-provider'): Promise<Provider> {
    return service.createProvider({ name });
  }

  async function seedProfile(projectId: string, name = 'Test Profile'): Promise<AgentProfile> {
    return service.createAgentProfile({ projectId, name });
  }

  async function seedFullAgent(
    projectId: string,
    agentName = 'Agent-1',
  ): Promise<{ agent: Agent; profile: AgentProfile; provider: Provider; configId: string }> {
    const provider = await seedProvider(`provider-${agentName}`);
    const profile = await seedProfile(projectId, `profile-${agentName}`);
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${agentName}`,
    });
    const agent = await service.createAgent({
      projectId,
      profileId: profile.id,
      name: agentName,
      providerConfigId: config.id,
    });
    return { agent, profile, provider, configId: config.id };
  }

  function getStatuses(projectId: string): Promise<Status[]> {
    return service.listStatuses(projectId).then((r) => r.items);
  }

  function makeWatcherInput(
    projectId: string,
    overrides: Partial<import('../models/domain.models').CreateWatcher> = {},
  ): import('../models/domain.models').CreateWatcher {
    return {
      projectId,
      name: 'Test Watcher',
      description: null,
      enabled: true,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 1000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'error' },
      cooldownMs: 5000,
      cooldownMode: 'time',
      eventName: 'watcher.match',
      ...overrides,
    };
  }

  function makeSubscriberInput(
    projectId: string,
    overrides: Partial<import('../models/domain.models').CreateSubscriber> = {},
  ): import('../models/domain.models').CreateSubscriber {
    return {
      projectId,
      name: 'Test Subscriber',
      description: null,
      enabled: true,
      eventName: 'epic.updated',
      eventFilter: null,
      actionType: 'send_message',
      actionInputs: {},
      delayMs: 0,
      cooldownMs: 0,
      retryOnError: false,
      groupName: null,
      position: 0,
      priority: 0,
      ...overrides,
    };
  }

  // ==========================================
  // Projects
  // ==========================================

  describe('Projects', () => {
    it('creates a project with 5 default statuses', async () => {
      const project = await seedProject();

      expect(project.id).toBeDefined();
      expect(project.name).toBe('Test Project');
      expect(project.rootPath).toBe('/tmp/test-project');

      const statuses = await getStatuses(project.id);
      expect(statuses).toHaveLength(5);
      expect(statuses.map((s) => s.label).sort()).toEqual(
        ['Blocked', 'Done', 'In Progress', 'Proposed', 'Review'].sort(),
      );
    });

    it('gets a project by id', async () => {
      const created = await seedProject();

      const fetched = await service.getProject(created.id);

      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe('Test Project');
    });

    it('throws NotFoundError for missing project', async () => {
      await expect(service.getProject('nonexistent-id')).rejects.toThrow(NotFoundError);
    });

    it('lists projects with pagination', async () => {
      await seedProject('Alpha');
      await seedProject('Beta');
      await seedProject('Gamma');

      const page1 = await service.listProjects({ limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(3);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      const page2 = await service.listProjects({ limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(1);
    });

    it('updates a project', async () => {
      const project = await seedProject();

      const updated = await service.updateProject(project.id, { name: 'Updated Name' });

      expect(updated.name).toBe('Updated Name');
      const fetched = await service.getProject(project.id);
      expect(fetched.name).toBe('Updated Name');
    });

    it('deletes a project', async () => {
      const project = await seedProject();

      await service.deleteProject(project.id);

      await expect(service.getProject(project.id)).rejects.toThrow(NotFoundError);
    });

    it('maps isTemplate boolean correctly', async () => {
      const project = await seedProject();
      const fetched = await service.getProject(project.id);
      expect(fetched.isTemplate).toBe(false);
    });
  });

  // ==========================================
  // Statuses
  // ==========================================

  describe('Statuses', () => {
    it('throws NotFoundError for missing status', async () => {
      await expect(service.getStatus('nonexistent-id')).rejects.toThrow(NotFoundError);
    });

    it('finds status by name case-insensitively', async () => {
      const project = await seedProject();
      const statuses = await getStatuses(project.id);
      const newStatus = statuses.find((s) => s.label === 'Proposed')!;

      const found = await service.findStatusByName(project.id, 'proposed');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(newStatus.id);
    });

    it('returns null when status name does not match', async () => {
      const project = await seedProject();

      const found = await service.findStatusByName(project.id, 'Nonexistent');
      expect(found).toBeNull();
    });
  });

  // ==========================================
  // Epics
  // ==========================================

  describe('Epics', () => {
    let project: Project;
    let defaultStatusId: string;

    beforeEach(async () => {
      project = await seedProject();
      const statuses = await getStatuses(project.id);
      defaultStatusId = statuses.find((s) => s.label === 'Proposed')!.id;
    });

    it('creates an epic with version 1 and tags', async () => {
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Test Epic',
        description: 'A test epic',
        statusId: defaultStatusId,
        tags: ['feature', 'urgent'],
      });

      expect(epic.version).toBe(1);
      expect(epic.title).toBe('Test Epic');
      expect(epic.tags.sort()).toEqual(['feature', 'urgent']);
    });

    it('updates epic and increments version', async () => {
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Original',
        statusId: defaultStatusId,
      });

      const updated = await service.updateEpic(epic.id, { title: 'Updated Title' }, 1);

      expect(updated.title).toBe('Updated Title');
      expect(updated.version).toBe(2);
    });

    it('throws OptimisticLockError on version mismatch', async () => {
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Test',
        statusId: defaultStatusId,
      });

      await expect(service.updateEpic(epic.id, { title: 'Conflict' }, 99)).rejects.toThrow(
        OptimisticLockError,
      );
    });

    it('throws NotFoundError for missing epic', async () => {
      await expect(service.getEpic('nonexistent-id')).rejects.toThrow(NotFoundError);
    });

    it('lists project epics with filters', async () => {
      const statuses = await getStatuses(project.id);
      const inProgressId = statuses.find((s) => s.label === 'In Progress')!.id;

      await service.createEpic({
        projectId: project.id,
        title: 'Active Epic',
        statusId: inProgressId,
      });
      await service.createEpic({
        projectId: project.id,
        title: 'New Epic',
        statusId: defaultStatusId,
      });

      const result = await service.listProjectEpics(project.id, {
        statusId: inProgressId,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Active Epic');
    });

    it('lists assigned epics for an agent', async () => {
      const { agent } = await seedFullAgent(project.id);

      await service.createEpic({
        projectId: project.id,
        title: 'Assigned Epic',
        statusId: defaultStatusId,
        agentId: agent.id,
      });
      await service.createEpic({
        projectId: project.id,
        title: 'Unassigned Epic',
        statusId: defaultStatusId,
      });

      const result = await service.listAssignedEpics(project.id, {
        agentName: agent.name,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Assigned Epic');
    });

    it('throws ValidationError when agentName is blank', async () => {
      await expect(service.listAssignedEpics(project.id, { agentName: '' })).rejects.toThrow(
        ValidationError,
      );
    });

    it('propagates NotFoundError when agent does not exist', async () => {
      await expect(service.listAssignedEpics(project.id, { agentName: 'Ghost' })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('creates epic for project using default status and agent resolution', async () => {
      const { agent } = await seedFullAgent(project.id);

      const epic = await service.createEpicForProject(project.id, {
        title: 'Auto-status Epic',
        agentName: agent.name,
      });

      expect(epic.title).toBe('Auto-status Epic');
      expect(epic.statusId).toBeDefined();
      expect(epic.agentId).toBe(agent.id);
    });
  });

  // ==========================================
  // Epic Comments
  // ==========================================

  describe('Epic Comments', () => {
    it('creates and lists comments ordered by creation time', async () => {
      const project = await seedProject();
      const statuses = await getStatuses(project.id);
      const statusId = statuses[0].id;
      const { agent } = await seedFullAgent(project.id);

      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Commented Epic',
        statusId,
      });

      const comment1 = await service.createEpicComment({
        epicId: epic.id,
        content: 'First comment',
        authorName: agent.name,
      });
      await service.createEpicComment({
        epicId: epic.id,
        content: 'Second comment',
        authorName: agent.name,
      });

      expect(comment1.id).toBeDefined();
      expect(comment1.content).toBe('First comment');

      const result = await service.listEpicComments(epic.id);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].content).toBe('First comment');
      expect(result.items[1].content).toBe('Second comment');
      expect(result.total).toBe(2);
    });
  });

  // ==========================================
  // Epic ID Prefix Resolution
  // ==========================================

  describe('Epic ID Prefix', () => {
    it('resolves epics by id prefix', async () => {
      const project = await seedProject();
      const statuses = await getStatuses(project.id);
      const statusId = statuses[0].id;

      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Prefix Test',
        statusId,
      });

      const prefix = epic.id.slice(0, 8);
      const results = await service.getEpicsByIdPrefix(project.id, prefix);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((e) => e.id === epic.id)).toBe(true);
    });

    it('handles % and _ characters literally in prefix', async () => {
      const project = await seedProject();

      const results = await service.getEpicsByIdPrefix(project.id, 'abc%def_');
      expect(results).toEqual([]);
    });
  });

  // ==========================================
  // Prompts
  // ==========================================

  describe('Prompts', () => {
    it('throws OptimisticLockError on version conflict during update', async () => {
      const project = await seedProject();
      const prompt = await service.createPrompt({
        projectId: project.id,
        title: 'Test Prompt',
        content: 'Hello',
      });

      await expect(service.updatePrompt(prompt.id, { title: 'Updated' }, 99)).rejects.toThrow(
        OptimisticLockError,
      );
    });

    it('returns configured initial session prompt', async () => {
      const project = await seedProject();
      const prompt = await service.createPrompt({
        projectId: project.id,
        title: 'Init Prompt',
        content: 'Welcome',
      });

      const { randomUUID } = await import('crypto');
      const now = new Date().toISOString();
      sqlite
        .prepare(
          'INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), 'initialSessionPromptId', prompt.id, now, now);

      const result = await service.getInitialSessionPrompt(project.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(prompt.id);
    });
  });

  // ==========================================
  // Records
  // ==========================================

  describe('Records', () => {
    it('creates a record with version 1', async () => {
      const project = await seedProject();
      const statuses = await getStatuses(project.id);
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Record Epic',
        statusId: statuses[0].id,
      });

      const record = await service.createRecord({
        epicId: epic.id,
        type: 'note',
        data: { title: 'Test Record' },
        tags: [],
      });

      expect(record.version).toBe(1);
      expect(record.type).toBe('note');
      expect(record.epicId).toBe(epic.id);
    });

    it('throws OptimisticLockError on version conflict during update', async () => {
      const project = await seedProject();
      const statuses = await getStatuses(project.id);
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Record Epic',
        statusId: statuses[0].id,
      });
      const record = await service.createRecord({
        epicId: epic.id,
        type: 'note',
        data: {},
        tags: [],
      });

      await expect(
        service.updateRecord(record.id, { data: { updated: true } }, 99),
      ).rejects.toThrow(OptimisticLockError);
    });
  });

  // ==========================================
  // Documents
  // ==========================================

  describe('Documents', () => {
    it('creates a document with generated slug and sanitized tags', async () => {
      const project = await seedProject();

      const doc = await service.createDocument({
        projectId: project.id,
        title: 'Test Document',
        contentMd: '# Hello',
        tags: ['tag-one', 'TAG-ONE', 'tag-two'],
      });

      expect(doc.id).toBeDefined();
      expect(doc.slug).toBeDefined();
      expect(doc.title).toBe('Test Document');
      expect(doc.tags.map((t) => t.toLowerCase()).sort()).toContain('tag-one');
      expect(doc.tags.map((t) => t.toLowerCase()).sort()).toContain('tag-two');
    });

    it('updates document with optimistic locking', async () => {
      const project = await seedProject();
      const doc = await service.createDocument({
        projectId: project.id,
        title: 'Original',
        contentMd: '# Original',
      });

      const updated = await service.updateDocument(doc.id, {
        title: 'Updated Title',
        version: doc.version,
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.version).toBe(doc.version + 1);
    });

    it('rejects document update on version mismatch', async () => {
      const project = await seedProject();
      const doc = await service.createDocument({
        projectId: project.id,
        title: 'Doc',
        contentMd: 'Content',
      });

      await expect(
        service.updateDocument(doc.id, { title: 'Bad Update', version: 99 }),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('filters documents by tags and paginates', async () => {
      const project = await seedProject();
      await service.createDocument({
        projectId: project.id,
        title: 'Tagged Doc',
        contentMd: 'content',
        tags: ['important'],
      });
      await service.createDocument({
        projectId: project.id,
        title: 'Other Doc',
        contentMd: 'content',
        tags: ['misc'],
      });

      const result = await service.listDocuments({
        projectId: project.id,
        tags: ['important'],
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Tagged Doc');
    });

    it('throws ValidationError when neither id nor slug provided', async () => {
      await expect(service.getDocument({})).rejects.toThrow(ValidationError);
    });

    it('requires projectId when querying by slug', async () => {
      await expect(service.getDocument({ slug: 'test' })).rejects.toThrow(ValidationError);
    });
  });

  // ==========================================
  // Tags
  // ==========================================

  describe('Tags', () => {
    it('creates a tag', async () => {
      const project = await seedProject();

      const tag = await service.createTag({ name: 'feature', projectId: project.id });

      expect(tag.id).toBeDefined();
      expect(tag.name).toBe('feature');
      expect(tag.projectId).toBe(project.id);
    });

    it('throws NotFoundError for missing tag', async () => {
      await expect(service.getTag('nonexistent-id')).rejects.toThrow(NotFoundError);
    });
  });

  // ==========================================
  // Agent Profiles
  // ==========================================

  describe('Agent Profiles', () => {
    it('creates profile with default fields', async () => {
      const project = await seedProject();

      const profile = await service.createAgentProfile({
        projectId: project.id,
        name: 'Coder Profile',
      });

      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('Coder Profile');
      expect(profile.projectId).toBe(project.id);
    });

    it('creates profile with familySlug', async () => {
      const project = await seedProject();

      const profile = await service.createAgentProfile({
        projectId: project.id,
        name: 'Family Profile',
        familySlug: 'coder',
      });

      expect(profile.familySlug).toBe('coder');
    });

    it('creates profile with null familySlug when not provided', async () => {
      const project = await seedProject();

      const profile = await service.createAgentProfile({
        projectId: project.id,
        name: 'No Family',
      });

      expect(profile.familySlug).toBeNull();
    });

    it('throws NotFoundError for missing profile', async () => {
      await expect(service.getAgentProfile('nonexistent-id')).rejects.toThrow(NotFoundError);
    });
  });

  // ==========================================
  // Agents
  // ==========================================

  describe('Agents', () => {
    let project: Project;

    beforeEach(async () => {
      project = await seedProject();
    });

    it('throws NotFoundError for missing agent', async () => {
      await expect(service.getAgent('nonexistent-id')).rejects.toThrow(NotFoundError);
    });

    it('validates profile belongs to the same project on create', async () => {
      const otherProject = await seedProject('Other');
      const provider = await seedProvider();
      const profile = await seedProfile(otherProject.id, 'Wrong Project Profile');
      const config = await service.createProfileProviderConfig({
        profileId: profile.id,
        providerId: provider.id,
        name: 'config',
      });

      await expect(
        service.createAgent({
          projectId: project.id,
          profileId: profile.id,
          name: 'Bad Agent',
          providerConfigId: config.id,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates providerConfigId belongs to the profile on create', async () => {
      const provider = await seedProvider();
      const profileA = await seedProfile(project.id, 'Profile A');
      const profileB = await seedProfile(project.id, 'Profile B');
      const configB = await service.createProfileProviderConfig({
        profileId: profileB.id,
        providerId: provider.id,
        name: 'config-b',
      });

      await expect(
        service.createAgent({
          projectId: project.id,
          profileId: profileA.id,
          name: 'Mismatched Agent',
          providerConfigId: configB.id,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates providerConfigId on update when config changes', async () => {
      const { agent } = await seedFullAgent(project.id, 'Agent-X');
      const profileB = await seedProfile(project.id, 'Other Profile');
      const provider2 = await seedProvider('other-provider');
      const configB = await service.createProfileProviderConfig({
        profileId: profileB.id,
        providerId: provider2.id,
        name: 'config-other',
      });

      await expect(service.updateAgent(agent.id, { providerConfigId: configB.id })).rejects.toThrow(
        ValidationError,
      );
    });

    it('preserves modelOverride when providerConfigId changes', async () => {
      const provider = await seedProvider();
      const profile = await seedProfile(project.id);
      const config1 = await service.createProfileProviderConfig({
        profileId: profile.id,
        providerId: provider.id,
        name: 'config-1',
      });
      const config2 = await service.createProfileProviderConfig({
        profileId: profile.id,
        providerId: provider.id,
        name: 'config-2',
      });
      const agent = await service.createAgent({
        projectId: project.id,
        profileId: profile.id,
        name: 'Override Agent',
        providerConfigId: config1.id,
        modelOverride: 'custom-model',
      });

      const updated = await service.updateAgent(agent.id, {
        providerConfigId: config2.id,
        modelOverride: 'should-be-preserved',
      });

      expect(updated.modelOverride).toBe('should-be-preserved');
    });

    it('respects explicit modelOverride=null', async () => {
      const provider = await seedProvider();
      const profile = await seedProfile(project.id);
      const config1 = await service.createProfileProviderConfig({
        profileId: profile.id,
        providerId: provider.id,
        name: 'config-1',
      });
      const config2 = await service.createProfileProviderConfig({
        profileId: profile.id,
        providerId: provider.id,
        name: 'config-2',
      });
      const agent = await service.createAgent({
        projectId: project.id,
        profileId: profile.id,
        name: 'Null Override Agent',
        providerConfigId: config1.id,
        modelOverride: 'old-model',
      });

      const updated = await service.updateAgent(agent.id, {
        providerConfigId: config2.id,
        modelOverride: null,
      });

      expect(updated.modelOverride).toBeNull();
    });

    it('throws ConflictError when deleting agent with running sessions', async () => {
      const { agent } = await seedFullAgent(project.id);

      const { sessions } = await import('../db/schema');
      const now = new Date().toISOString();
      await db.insert(sessions).values({
        id: 'session-1',
        agentId: agent.id,
        tmuxSessionId: 'tmux-1',
        status: 'running',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await expect(service.deleteAgent(agent.id)).rejects.toThrow(ConflictError);
    });

    it('deletes agent and auto-deletes completed sessions', async () => {
      const { agent } = await seedFullAgent(project.id);

      const { sessions } = await import('../db/schema');
      const now = new Date().toISOString();
      await db.insert(sessions).values({
        id: 'session-done',
        agentId: agent.id,
        tmuxSessionId: 'tmux-done',
        status: 'stopped',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await service.deleteAgent(agent.id);

      await expect(service.getAgent(agent.id)).rejects.toThrow(NotFoundError);
    });
  });

  // ==========================================
  // Providers
  // ==========================================

  describe('Providers', () => {
    it('creates a provider with binPath', async () => {
      const provider = await service.createProvider({
        name: 'claude',
        binPath: '/usr/bin/claude',
      });

      expect(provider.id).toBeDefined();
      expect(provider.name).toBe('claude');
      expect(provider.binPath).toBe('/usr/bin/claude');
      expect(provider.mcpConfigured).toBe(false);
    });

    it('creates a provider without binPath', async () => {
      const provider = await service.createProvider({ name: 'codex' });

      expect(provider.binPath).toBeNull();
    });

    it('gets a provider by id', async () => {
      const created = await service.createProvider({ name: 'gemini' });

      const fetched = await service.getProvider(created.id);
      expect(fetched.name).toBe('gemini');
    });

    it('throws NotFoundError for missing provider', async () => {
      await expect(service.getProvider('nonexistent-id')).rejects.toThrow(NotFoundError);
    });

    it('lists providers with pagination', async () => {
      await service.createProvider({ name: 'p1' });
      await service.createProvider({ name: 'p2' });
      await service.createProvider({ name: 'p3' });

      const result = await service.listProviders({ limit: 2, offset: 0 });
      expect(result.items).toHaveLength(2);
    });

    it('returns empty array for listProvidersByIds with no ids', async () => {
      const result = await service.listProvidersByIds([]);
      expect(result).toEqual([]);
    });

    it('updates and returns the provider', async () => {
      const provider = await service.createProvider({ name: 'update-me' });

      const updated = await service.updateProvider(provider.id, { name: 'updated-name' });

      expect(updated.name).toBe('updated-name');
    });

    it('deletes a provider', async () => {
      const provider = await service.createProvider({ name: 'delete-me' });

      await service.deleteProvider(provider.id);

      await expect(service.getProvider(provider.id)).rejects.toThrow(NotFoundError);
    });

    it('trims model names in createProviderModel', async () => {
      const provider = await service.createProvider({ name: 'model-host' });

      const model = await service.createProviderModel({
        providerId: provider.id,
        name: '  gpt-4  ',
      });

      expect(model.name).toBe('gpt-4');
    });

    it('bulk creates models and skips case-insensitive duplicates', async () => {
      const provider = await service.createProvider({ name: 'bulk-host' });

      const result = await service.bulkCreateProviderModels(provider.id, [
        'model-a',
        'MODEL-A',
        'model-b',
      ]);

      expect(result.added.sort()).toEqual(['model-a', 'model-b']);
      expect(result.existing).toHaveLength(1);
    });

    it('rejects empty model names', async () => {
      const provider = await service.createProvider({ name: 'empty-model' });

      await expect(service.bulkCreateProviderModels(provider.id, ['  ', ''])).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // ==========================================
  // Provider MCP Metadata
  // ==========================================

  describe('Provider MCP Metadata', () => {
    it('reads and updates metadata', async () => {
      const provider = await service.createProvider({ name: 'mcp-provider' });

      const initial = await service.getProviderMcpMetadata(provider.id);
      expect(initial.mcpConfigured).toBe(false);
      expect(initial.mcpEndpoint).toBeNull();

      await service.updateProviderMcpMetadata(provider.id, {
        mcpConfigured: true,
        mcpEndpoint: 'http://localhost:3000/mcp',
      });

      const updated = await service.getProviderMcpMetadata(provider.id);
      expect(updated.mcpConfigured).toBe(true);
      expect(updated.mcpEndpoint).toBe('http://localhost:3000/mcp');
    });
  });

  // ==========================================
  // Watchers
  // ==========================================

  describe('Watchers', () => {
    let project: Project;

    beforeEach(async () => {
      project = await seedProject();
    });

    it('creates a watcher with UUID and timestamps', async () => {
      const watcher = await service.createWatcher(
        makeWatcherInput(project.id, { name: 'Build Watcher' }),
      );

      expect(watcher.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(watcher.name).toBe('Build Watcher');
      expect(watcher.createdAt).toBeDefined();
    });

    it('lists watchers for a project', async () => {
      await service.createWatcher(makeWatcherInput(project.id, { name: 'W1' }));

      const result = await service.listWatchers(project.id);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('W1');
    });

    it('returns empty array when no watchers exist', async () => {
      const result = await service.listWatchers(project.id);
      expect(result).toEqual([]);
    });

    it('gets a watcher by id', async () => {
      const created = await service.createWatcher(
        makeWatcherInput(project.id, { name: 'Fetch Me' }),
      );

      const fetched = await service.getWatcher(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('Fetch Me');
    });

    it('returns null for missing watcher', async () => {
      const result = await service.getWatcher('nonexistent-id');
      expect(result).toBeNull();
    });

    it('updates a watcher', async () => {
      const watcher = await service.createWatcher(makeWatcherInput(project.id, { name: 'Before' }));

      const updated = await service.updateWatcher(watcher.id, { name: 'After' });
      expect(updated.name).toBe('After');
    });

    it('updates idleAfterSeconds', async () => {
      const watcher = await service.createWatcher(makeWatcherInput(project.id));

      const updated = await service.updateWatcher(watcher.id, { idleAfterSeconds: 300 });
      expect(updated.idleAfterSeconds).toBe(300);
    });

    it('throws NotFoundError when updating nonexistent watcher', async () => {
      await expect(service.updateWatcher('nonexistent-id', { name: 'Nope' })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('deletes a watcher', async () => {
      const watcher = await service.createWatcher(
        makeWatcherInput(project.id, { name: 'Delete Me' }),
      );

      await service.deleteWatcher(watcher.id);

      const fetched = await service.getWatcher(watcher.id);
      expect(fetched).toBeNull();
    });

    it('lists all enabled watchers across projects', async () => {
      const project2 = await seedProject('Project 2');

      await service.createWatcher(makeWatcherInput(project.id, { name: 'Enabled1' }));
      await service.createWatcher(makeWatcherInput(project2.id, { name: 'Enabled2' }));
      await service.createWatcher(
        makeWatcherInput(project.id, { name: 'Disabled', enabled: false }),
      );

      const enabled = await service.listEnabledWatchers();
      expect(enabled).toHaveLength(2);
      expect(enabled.map((w) => w.name).sort()).toEqual(['Enabled1', 'Enabled2']);
    });
  });

  // ==========================================
  // Subscribers
  // ==========================================

  describe('Subscribers', () => {
    let project: Project;

    beforeEach(async () => {
      project = await seedProject();
    });

    it('creates a subscriber with UUID and JSON fields', async () => {
      const inputs = { msg: { source: 'custom' as const, customValue: 'Epic changed!' } };
      const sub = await service.createSubscriber(
        makeSubscriberInput(project.id, { name: 'Test Sub', actionInputs: inputs }),
      );

      expect(sub.id).toBeDefined();
      expect(sub.name).toBe('Test Sub');
      expect(sub.actionInputs).toEqual(inputs);
    });

    it('lists subscribers for a project', async () => {
      await service.createSubscriber(makeSubscriberInput(project.id, { name: 'Sub1' }));

      const result = await service.listSubscribers(project.id);
      expect(result).toHaveLength(1);
    });

    it('returns empty array when no subscribers exist', async () => {
      const result = await service.listSubscribers(project.id);
      expect(result).toEqual([]);
    });

    it('gets a subscriber by id', async () => {
      const created = await service.createSubscriber(
        makeSubscriberInput(project.id, { name: 'Fetch Sub' }),
      );

      const fetched = await service.getSubscriber(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('Fetch Sub');
    });

    it('returns null for missing subscriber', async () => {
      const result = await service.getSubscriber('nonexistent-id');
      expect(result).toBeNull();
    });

    it('updates a subscriber', async () => {
      const sub = await service.createSubscriber(
        makeSubscriberInput(project.id, { name: 'Before' }),
      );

      const updated = await service.updateSubscriber(sub.id, { name: 'After' });
      expect(updated.name).toBe('After');
    });

    it('throws NotFoundError when updating nonexistent subscriber', async () => {
      await expect(service.updateSubscriber('nonexistent-id', { name: 'Nope' })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('deletes a subscriber', async () => {
      const sub = await service.createSubscriber(
        makeSubscriberInput(project.id, { name: 'Delete Me' }),
      );

      await service.deleteSubscriber(sub.id);

      const fetched = await service.getSubscriber(sub.id);
      expect(fetched).toBeNull();
    });

    it('finds enabled subscribers matching event name', async () => {
      await service.createSubscriber(
        makeSubscriberInput(project.id, {
          name: 'Matching',
          eventName: 'epic.created',
        }),
      );
      await service.createSubscriber(
        makeSubscriberInput(project.id, {
          name: 'Disabled',
          eventName: 'epic.created',
          enabled: false,
        }),
      );
      await service.createSubscriber(
        makeSubscriberInput(project.id, {
          name: 'Other Event',
          eventName: 'epic.deleted',
        }),
      );

      const result = await service.findSubscribersByEventName(project.id, 'epic.created');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Matching');
    });

    it('handles JSON fields round-trip correctly', async () => {
      const inputs = { nested: { source: 'custom' as const, customValue: 'value' } };
      const filter = { field: 'status', operator: 'equals' as const, value: 'active' };
      const sub = await service.createSubscriber(
        makeSubscriberInput(project.id, {
          name: 'JSON Sub',
          actionInputs: inputs,
          eventFilter: filter,
        }),
      );

      const fetched = await service.getSubscriber(sub.id);
      expect(fetched!.actionInputs).toEqual(inputs);
      expect(fetched!.eventFilter).toEqual(filter);
    });
  });
});
