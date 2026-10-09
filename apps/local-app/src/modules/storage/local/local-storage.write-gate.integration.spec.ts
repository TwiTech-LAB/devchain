// Real SQLite and the storage facade are the cheapest reliable layer for row
// hops, bulk ownership, rejected writes, fan-out and outer transaction joins.
import { randomUUID } from 'node:crypto';
import { NotFoundError, ProjectFrozenError } from '../../../common/errors/error-types';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import type { ExistingProjectsEnablement } from '../interfaces/storage.interface';
import type { EnvScopesMap } from '../models/domain.models';
import { ProjectWriteGate } from '../write-gate/project-write-gate';
import { ProjectWriteLookup } from '../write-gate/storage-write-scope';
import type { ProjectWriteEntity } from '../write-gate/storage-write-scope';
import { LocalStorageService } from './local-storage.service';

const frozenAt = '2026-09-22T10:00:00.000Z';

describe('LocalStorageService project write admission', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let storage: LocalStorageService;
  let gate: ProjectWriteGate;
  let writable: Awaited<ReturnType<typeof seed>>;
  let blocked: Awaited<ReturnType<typeof seed>>;

  async function seed(name: string) {
    const project = await storage.createProject({
      name,
      rootPath: `/tmp/${name}`,
      description: null,
      isTemplate: false,
    });
    const status = (await storage.listStatuses(project.id)).items[0];
    const epic = await storage.createEpic({
      projectId: project.id,
      title: name,
      description: null,
      statusId: status.id,
      data: null,
      tags: [],
    });
    const profile = await storage.createAgentProfile({ projectId: project.id, name });
    const provider = await storage.createProvider({ name: `provider-${name}` });
    const config = await storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: 'default',
      options: null,
      env: null,
    });
    const agent = await storage.createAgent({
      projectId: project.id,
      profileId: profile.id,
      providerConfigId: config.id,
      name,
    });
    const record = await storage.createRecord({
      epicId: epic.id,
      type: 'note',
      data: {},
      tags: [],
    });
    const comment = await storage.createEpicComment({
      epicId: epic.id,
      authorName: 'User',
      content: 'hello',
    });
    const prompt = await storage.createPrompt({
      projectId: project.id,
      title: name,
      content: 'hello',
      tags: [],
    });
    const tag = await storage.createTag({ projectId: project.id, name });
    const guest = await storage.createGuest({
      projectId: project.id,
      name: `guest-${name}`,
      description: null,
      tmuxSessionId: `guest-${name}`,
      lastSeenAt: frozenAt,
    });
    const watcher = await storage.createWatcher({
      projectId: project.id,
      name,
      description: null,
      enabled: false,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 1000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'error' },
      cooldownMs: 0,
      cooldownMode: 'time',
      eventName: 'custom.event',
    });
    const subscriber = await storage.createSubscriber({
      projectId: project.id,
      name,
      description: null,
      enabled: false,
      eventName: 'custom.event',
      eventFilter: null,
      actionType: 'send_agent_message',
      actionInputs: {},
      delayMs: 0,
      cooldownMs: 0,
      retryOnError: false,
      groupName: null,
      position: 0,
      priority: 0,
    });
    const review = await storage.createReview({
      projectId: project.id,
      epicId: epic.id,
      title: name,
      description: null,
      status: 'draft',
      mode: 'commit',
      baseRef: 'main',
      headRef: 'feature',
      baseSha: null,
      headSha: null,
      createdBy: 'user',
      createdByAgentId: null,
    });
    const reviewComment = await storage.createReviewComment({
      reviewId: review.id,
      filePath: null,
      parentId: null,
      lineStart: null,
      lineEnd: null,
      side: null,
      content: 'hello',
      commentType: 'comment',
      status: 'open',
      authorType: 'user',
      authorAgentId: null,
    });
    const schedule = await storage.createScheduledEpic({
      projectId: project.id,
      name,
      cronExpression: '0 0 * * *',
      timezone: 'UTC',
      enabled: false,
      titleTemplate: name,
      descriptionTemplate: null,
      templateStatusId: null,
      templateParentEpicId: null,
      templateAgentId: null,
      templateTags: [],
      allowOverlap: false,
      missedRunPolicy: 'skip',
    });
    const run = await storage.createScheduledEpicRun({
      scheduleId: schedule.id,
      plannedFor: frozenAt,
      source: 'scheduler',
      status: 'pending',
    });
    const sessionId = randomUUID();
    database.sqlite
      .prepare(
        'INSERT INTO sessions (id, agent_id, epic_id, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sessionId, agent.id, epic.id, 'stopped', frozenAt, frozenAt, frozenAt);
    return {
      project,
      status,
      epic,
      profile,
      provider,
      config,
      agent,
      record,
      comment,
      prompt,
      tag,
      guest,
      watcher,
      subscriber,
      review,
      reviewComment,
      schedule,
      run,
      sessionId,
    };
  }

  beforeEach(async () => {
    database = createTestDatabase();
    gate = new ProjectWriteGate();
    storage = new LocalStorageService(database.db, undefined, undefined, gate);
    gate.bindStorage(storage);
    await gate.onModuleInit();
    writable = await seed('Writable');
    blocked = await seed('Blocked');
    await storage.setEpicRelation({
      epicId: writable.epic.id,
      relatedEpicId: blocked.epic.id,
      type: 'blocks',
    });
    gate.markFrozen(blocked.project.id, frozenAt);
  });

  afterEach(() => database.sqlite.close());

  function snapshot(): unknown[] {
    return [
      'projects',
      'epics',
      'epic_relations',
      'records',
      'record_tags',
      'tags',
      'statuses',
      'agent_profiles',
      'profile_provider_configs',
      'agents',
      'epic_comments',
      'prompts',
      'guests',
      'terminal_watchers',
      'automation_subscribers',
      'reviews',
      'review_comments',
      'review_comment_targets',
      'scheduled_epics',
      'scheduled_epic_runs',
      'sessions',
    ].map((table) => database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }

  it.each<[ProjectWriteEntity, (row: Awaited<ReturnType<typeof seed>>) => string]>([
    ['epic', (s) => s.epic.id],
    ['agent', (s) => s.agent.id],
    ['prompt', (s) => s.prompt.id],
    ['tag', (s) => s.tag.id],
    ['profile', (s) => s.profile.id],
    ['guest', (s) => s.guest.id],
    ['status', (s) => s.status.id],
    ['watcher', (s) => s.watcher.id],
    ['subscriber', (s) => s.subscriber.id],
    ['review', (s) => s.review.id],
    ['schedule', (s) => s.schedule.id],
    ['record', (s) => s.record.id],
    ['epicComment', (s) => s.comment.id],
    ['reviewComment', (s) => s.reviewComment.id],
    ['scheduledRun', (s) => s.run.run.id],
    ['profileConfig', (s) => s.config.id],
  ])('resolves the %s owner through synchronous storage columns', (entity, id) => {
    const lookup = new ProjectWriteLookup(database.sqlite);

    expect(lookup.projectIds(entity, id(blocked))).toEqual([blocked.project.id]);
    expect(lookup.projectIds(entity, randomUUID())).toEqual([null]);
  });

  it.each([
    ['project argument', () => storage.deleteProject(blocked.project.id)],
    [
      'nested epic project field',
      () =>
        storage.createEpicWithExternalTaskLink({
          epic: {
            projectId: blocked.project.id,
            title: 'External epic',
            description: null,
            statusId: blocked.status.id,
            data: null,
            tags: [],
          },
          externalTaskLink: {
            connectionId: null,
            provider: 'clickup',
            remoteScopeKey: 'scope',
            remoteTaskId: 'task',
            sourceSnapshot: {},
          },
        }),
    ],
    [
      'object project field',
      () =>
        storage.createGuest({
          projectId: blocked.project.id,
          name: 'New guest',
          description: null,
          tmuxSessionId: 'new-guest',
          lastSeenAt: frozenAt,
        }),
    ],
    [
      'epic field hop',
      () =>
        storage.createRecord({
          epicId: blocked.epic.id,
          type: 'note',
          data: {},
          tags: ['new-tag'],
        }),
    ],
    [
      'record hop',
      () =>
        storage.updateRecord(
          blocked.record.id,
          { data: { changed: true } },
          blocked.record.version,
        ),
    ],
    ['epic comment hop', () => storage.deleteEpicComment(blocked.comment.id)],
    ['review comment hop', () => storage.deleteReviewComment(blocked.reviewComment.id)],
    ['scheduled run hop', () => storage.claimScheduledEpicRun(blocked.run.run.id)],
    [
      'profile config hop',
      () => storage.updateProfileProviderConfig(blocked.config.id, { name: 'Changed' }),
    ],
    [
      'createIfMissing profile hop',
      () =>
        storage.createIfMissing({
          profileId: blocked.profile.id,
          providerId: blocked.provider.id,
          name: 'New',
        }),
    ],
    ['both status IDs', () => storage.updateEpicsStatus(writable.status.id, blocked.status.id)],
    [
      'every agent in an array',
      () => storage.parkSessionsFromAgents([writable.agent.id, blocked.agent.id]),
    ],
    [
      'review comment target agents',
      () =>
        storage.addReviewCommentTargets(writable.reviewComment.id, [
          writable.agent.id,
          blocked.agent.id,
        ]),
    ],
    [
      'every reordered config',
      () =>
        storage.reorderProfileProviderConfigs(writable.profile.id, [
          writable.config.id,
          blocked.config.id,
        ]),
    ],
    [
      'deleted session owners',
      () => storage.applySessionPlan([], [writable.sessionId, blocked.sessionId]),
    ],
    [
      'reassigned session owners',
      () =>
        storage.applySessionPlan(
          [{ sessionId: blocked.sessionId, newAgentId: writable.agent.id }],
          [],
        ),
    ],
    [
      'new session agents',
      () =>
        storage.applySessionPlan(
          [{ sessionId: writable.sessionId, newAgentId: blocked.agent.id }],
          [],
        ),
    ],
    [
      'destination project',
      () =>
        storage.updatePrompt(
          writable.prompt.id,
          { projectId: blocked.project.id },
          writable.prompt.version,
        ),
    ],
  ] as const)('refuses %s as a rejected promise before any mutation', async (_name, write) => {
    const before = snapshot();
    const promise = write();

    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toMatchObject({
      code: 'PROJECT_FROZEN',
      statusCode: 423,
      details: { projectId: blocked.project.id },
    });
    expect(snapshot()).toEqual(before);
  });

  it.each([false, true])(
    'checks both relation projects in either argument order (reverse=%s)',
    async (reverse) => {
      const before = snapshot();
      const [epicId, relatedEpicId] = reverse
        ? [blocked.epic.id, writable.epic.id]
        : [writable.epic.id, blocked.epic.id];

      await expect(
        storage.setEpicRelation({ epicId, relatedEpicId, type: 'related' }),
      ).rejects.toThrow(ProjectFrozenError);
      await expect(storage.deleteEpicRelation(epicId, relatedEpicId)).rejects.toThrow(
        ProjectFrozenError,
      );

      expect(snapshot()).toEqual(before);
    },
  );

  it('checks every session owner, including its cross-project epic', async () => {
    database.sqlite
      .prepare('UPDATE sessions SET epic_id = ? WHERE id = ?')
      .run(blocked.epic.id, writable.sessionId);
    const before = snapshot();

    await expect(storage.applySessionPlan([], [writable.sessionId])).rejects.toThrow(
      ProjectFrozenError,
    );

    expect(snapshot()).toEqual(before);
  });

  it('passes missing rows through to the delegate NotFound error', async () => {
    await expect(storage.updatePrompt(randomUUID(), { title: 'Missing' }, 1)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('permits nullable project rows while a project is blocked', async () => {
    const prompt = await storage.createPrompt({
      projectId: null,
      title: 'Global',
      content: 'hello',
      tags: [],
    });
    const profile = await storage.createAgentProfile({ projectId: null, name: 'Global' });
    const tag = await storage.createTag({ projectId: null, name: 'Global' });

    expect((await storage.getPrompt(prompt.id)).projectId).toBeNull();
    expect((await storage.getAgentProfile(profile.id)).projectId).toBeNull();
    expect((await storage.getTag(tag.id)).projectId).toBeNull();
  });

  it('joins a gated write to the outer transaction so rollback removes it', async () => {
    const before = snapshot();

    await expect(
      storage.runInTransaction(async () => {
        await storage.createEpicWithinTransaction({
          projectId: writable.project.id,
          title: 'Rolled back',
          description: null,
          statusId: writable.status.id,
          data: null,
          tags: [],
        });
        throw new Error('Rollback outer owner');
      }),
    ).rejects.toThrow('Rollback outer owner');

    expect(snapshot()).toEqual(before);
  });

  function createSource(kind: 'community' | 'local', choice: ExistingProjectsEnablement) {
    return kind === 'community'
      ? storage.createCommunitySkillSource(
          { name: 'gate-source', repoOwner: 'owner', repoName: 'repo', branch: 'main' },
          { existingProjects: choice },
        )
      : storage.createLocalSkillSource(
          { name: 'gate-source', folderPath: '/tmp/gate-source' },
          { existingProjects: choice },
        );
  }

  it.each(['community', 'local'] as const)(
    '%s source fan-out skips blocked projects in none/all mode',
    async (kind) => {
      for (const mode of ['none', 'all'] as const) {
        const source = await createSource(kind, { mode });
        expect(await storage.getSourceProjectEnabled(blocked.project.id, source.name)).toBeNull();
        expect(await storage.getSourceProjectEnabled(writable.project.id, source.name)).toBe(
          mode === 'all',
        );
        if (kind === 'community') await storage.deleteCommunitySkillSource(source.id);
        else await storage.deleteLocalSkillSource(source.id);
      }
    },
  );

  it.each(['community', 'local'] as const)(
    'rejects %s source creation selecting a blocked project without any rows',
    async (kind) => {
      await expect(
        createSource(kind, {
          mode: 'selected',
          projectIds: [writable.project.id, blocked.project.id],
        }),
      ).rejects.toThrow(ProjectFrozenError);

      expect(database.sqlite.prepare('SELECT * FROM community_skill_sources').all()).toEqual([]);
      expect(database.sqlite.prepare('SELECT * FROM local_skill_sources').all()).toEqual([]);
      expect(database.sqlite.prepare('SELECT * FROM source_project_enabled').all()).toEqual([]);
    },
  );

  it.each(['community', 'local'] as const)(
    '%s source deletion preserves blocked project switches',
    async (kind) => {
      const source = await createSource(kind, { mode: 'all' });
      await storage.setSourceProjectEnabled(blocked.project.id, source.name, false);
      const before = database.sqlite
        .prepare('SELECT * FROM source_project_enabled WHERE project_id = ?')
        .all(blocked.project.id);

      if (kind === 'community') await storage.deleteCommunitySkillSource(source.id);
      else await storage.deleteLocalSkillSource(source.id);

      expect(
        database.sqlite
          .prepare('SELECT * FROM source_project_enabled WHERE project_id = ?')
          .all(blocked.project.id),
      ).toEqual(before);
      expect(await storage.getSourceProjectEnabled(writable.project.id, source.name)).toBeNull();
      expect(
        database.sqlite
          .prepare(
            `SELECT * FROM ${kind === 'community' ? 'community_skill_sources' : 'local_skill_sources'}`,
          )
          .all(),
      ).toEqual([]);
    },
  );

  it.each(['add', 'remove', 'prune'] as const)(
    'refuses to %s blocked provider env scope membership before provider or scope writes',
    async (operation) => {
      const providerId = writable.provider.id;
      if (operation !== 'add')
        database.sqlite
          .prepare(
            'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(providerId, 'TOKEN', blocked.project.id, frozenAt);
      const beforeProvider = await storage.getProvider(providerId);
      const beforeScopes = database.sqlite.prepare('SELECT * FROM provider_env_scopes').all();
      const scopes: EnvScopesMap | undefined =
        operation === 'prune'
          ? undefined
          : operation === 'add'
            ? { TOKEN: [blocked.project.id] }
            : {};
      const keys = operation === 'prune' ? [] : ['TOKEN'];

      await expect(
        storage.updateProviderWithScopes(
          providerId,
          { name: 'Changed', env: { TOKEN: 'new' } },
          scopes,
          keys,
        ),
      ).rejects.toThrow(ProjectFrozenError);

      expect(await storage.getProvider(providerId)).toEqual(beforeProvider);
      expect(database.sqlite.prepare('SELECT * FROM provider_env_scopes').all()).toEqual(
        beforeScopes,
      );
    },
  );

  it('preserves unchanged blocked provider scope rows while filtering non-current keys', async () => {
    const providerId = writable.provider.id;
    database.sqlite
      .prepare(
        'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(providerId, 'TOKEN', blocked.project.id, frozenAt);
    const before = database.sqlite.prepare('SELECT * FROM provider_env_scopes').all();

    const provider = await storage.updateProviderWithScopes(
      providerId,
      { name: 'Allowed global change' },
      { TOKEN: [blocked.project.id], IGNORED: [blocked.project.id] },
      ['TOKEN'],
    );

    expect(provider.name).toBe('Allowed global change');
    expect(database.sqlite.prepare('SELECT * FROM provider_env_scopes').all()).toEqual(before);
  });
});
