import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { ConflictError, OptimisticLockError } from '../../../common/errors/error-types';
import type {
  Epic,
  EpicRecord,
  Project,
  Prompt,
  Review,
  ReviewComment,
  ScheduledEpic,
} from '../models/domain.models';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

type VersionedEntity = Epic | Prompt | EpicRecord | Review | ReviewComment | ScheduledEpic;

interface VersionedMutationCase {
  name: string;
  table: string;
  versionColumn: 'version' | 'config_version';
  seed: () => Promise<VersionedEntity>;
  update: (entity: VersionedEntity, value: string) => Promise<VersionedEntity>;
  load: (id: string) => Promise<VersionedEntity>;
  versionOf: (entity: VersionedEntity) => number;
  valueOf: (entity: VersionedEntity) => string;
  expectConflict: (reason: unknown, id: string, expectedVersion: number) => void;
}

interface RelationRollbackCase {
  name: string;
  relationTable: string;
  relationIdColumn: string;
  seed: () => Promise<VersionedEntity>;
  update: (entity: VersionedEntity) => Promise<VersionedEntity>;
  load: (id: string) => Promise<VersionedEntity>;
  scalarSnapshot: (entity: VersionedEntity) => unknown;
  tagsOf: (entity: VersionedEntity) => string[];
}

describe('LocalStorageService versioned mutations (integration)', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: LocalStorageService;
  let project: Project;
  let statusId: string;
  let capturedSql: string[];

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    capturedSql = [];
    db = drizzle(sqlite, {
      logger: {
        logQuery(query: string): void {
          capturedSql.push(query);
        },
      },
    });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
    project = await service.createProject({
      name: 'Versioned mutations',
      rootPath: '/tmp/versioned-mutations',
      description: null,
    });
    statusId = (await service.listStatuses(project.id)).items[0]!.id;
    capturedSql = [];
  });

  afterEach(() => {
    sqlite.close();
  });

  function versionOf(entity: VersionedEntity): number {
    return 'configVersion' in entity ? entity.configVersion : entity.version;
  }

  function expectOptimisticConflict(reason: unknown, id: string, expectedVersion: number): void {
    expect(reason).toBeInstanceOf(OptimisticLockError);
    expect(reason).toMatchObject({
      code: 'optimistic_lock_error',
      details: { expectedVersion, actualVersion: expectedVersion + 1 },
    });
    expect((reason as Error).message).toContain(id);
  }

  function expectScheduledEpicConflict(reason: unknown, id: string, expectedVersion: number): void {
    expect(reason).toBeInstanceOf(ConflictError);
    expect(reason).toMatchObject({
      code: 'conflict',
      message: `ScheduledEpic version conflict: expected ${expectedVersion}, current ${expectedVersion + 1}`,
      details: { id, expectedVersion, currentVersion: expectedVersion + 1 },
    });
  }

  async function seedEpic(overrides: Partial<Epic> = {}): Promise<Epic> {
    return service.createEpic({
      projectId: project.id,
      title: 'Original epic',
      description: null,
      statusId,
      tags: ['existing'],
      ...overrides,
    });
  }

  async function seedPrompt(): Promise<Prompt> {
    return service.createPrompt({
      projectId: project.id,
      title: 'Original prompt',
      content: 'Prompt content',
      tags: ['existing'],
    });
  }

  async function seedRecord(): Promise<EpicRecord> {
    const epic = await seedEpic({ title: 'Record owner', tags: [] });
    return service.createRecord({
      epicId: epic.id,
      type: 'note',
      data: { title: 'Original record' },
      tags: ['existing'],
    });
  }

  async function seedReview(): Promise<Review> {
    return service.createReview({
      projectId: project.id,
      epicId: null,
      title: 'Original review',
      description: null,
      status: 'draft',
      mode: 'commit',
      baseRef: 'main',
      headRef: 'feature/versioned-mutations',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      createdBy: 'user',
      createdByAgentId: null,
    });
  }

  async function seedReviewComment(): Promise<ReviewComment> {
    const review = await seedReview();
    return service.createReviewComment({
      reviewId: review.id,
      filePath: null,
      parentId: null,
      lineStart: null,
      lineEnd: null,
      side: null,
      content: 'Original comment',
      commentType: 'comment',
      status: 'open',
      authorType: 'user',
      authorAgentId: null,
    });
  }

  async function seedScheduledEpic(): Promise<ScheduledEpic> {
    return service.createScheduledEpic({
      projectId: project.id,
      name: 'Original schedule',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      titleTemplate: 'Daily {{date}}',
      descriptionTemplate: null,
      templateStatusId: null,
      templateParentEpicId: null,
      templateAgentId: null,
      templateTags: [],
      allowOverlap: false,
      missedRunPolicy: 'skip',
      nextRunAt: '2026-08-13T09:00:00.000Z',
    });
  }

  function versionedMutationCases(): VersionedMutationCase[] {
    return [
      {
        name: 'Epic',
        table: 'epics',
        versionColumn: 'version',
        seed: seedEpic,
        update: (entity, value) =>
          service.updateEpic(entity.id, { title: value }, versionOf(entity)),
        load: (id) => service.getEpic(id),
        versionOf,
        valueOf: (entity) => (entity as Epic).title,
        expectConflict: expectOptimisticConflict,
      },
      {
        name: 'Prompt',
        table: 'prompts',
        versionColumn: 'version',
        seed: seedPrompt,
        update: (entity, value) =>
          service.updatePrompt(entity.id, { title: value }, versionOf(entity)),
        load: (id) => service.getPrompt(id),
        versionOf,
        valueOf: (entity) => (entity as Prompt).title,
        expectConflict: expectOptimisticConflict,
      },
      {
        name: 'Record',
        table: 'records',
        versionColumn: 'version',
        seed: seedRecord,
        update: (entity, value) =>
          service.updateRecord(entity.id, { data: { winner: value } }, versionOf(entity)),
        load: (id) => service.getRecord(id),
        versionOf,
        valueOf: (entity) => {
          const storedData: unknown = (entity as EpicRecord).data;
          const data =
            typeof storedData === 'string'
              ? (JSON.parse(storedData) as Record<string, unknown>)
              : (storedData as Record<string, unknown>);
          return String(data.winner);
        },
        expectConflict: expectOptimisticConflict,
      },
      {
        name: 'Review',
        table: 'reviews',
        versionColumn: 'version',
        seed: seedReview,
        update: (entity, value) =>
          service.updateReview(entity.id, { title: value }, versionOf(entity)),
        load: (id) => service.getReview(id),
        versionOf,
        valueOf: (entity) => (entity as Review).title,
        expectConflict: expectOptimisticConflict,
      },
      {
        name: 'ReviewComment',
        table: 'review_comments',
        versionColumn: 'version',
        seed: seedReviewComment,
        update: (entity, value) =>
          service.updateReviewComment(entity.id, { content: value }, versionOf(entity)),
        load: (id) => service.getReviewComment(id),
        versionOf,
        valueOf: (entity) => (entity as ReviewComment).content,
        expectConflict: expectOptimisticConflict,
      },
      {
        name: 'ScheduledEpic',
        table: 'scheduled_epics',
        versionColumn: 'config_version',
        seed: seedScheduledEpic,
        update: (entity, value) =>
          service.updateScheduledEpic(entity.id, { name: value }, versionOf(entity)),
        load: (id) => service.getScheduledEpic(id),
        versionOf,
        valueOf: (entity) => (entity as ScheduledEpic).name,
        expectConflict: expectScheduledEpicConflict,
      },
    ];
  }

  function normalizeSql(statement: string): string {
    return statement.replace(/["`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  it.each(versionedMutationCases())(
    '$name admits one same-version winner, returns the public conflict, and emits compare-and-swap SQL',
    async (mutationCase) => {
      const entity = await mutationCase.seed();
      const expectedVersion = mutationCase.versionOf(entity);
      capturedSql = [];

      const results = await Promise.allSettled([
        mutationCase.update(entity, `${mutationCase.name} contender A`),
        mutationCase.update(entity, `${mutationCase.name} contender B`),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<VersionedEntity> =>
          result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      mutationCase.expectConflict(rejected[0]!.reason, entity.id, expectedVersion);

      const persisted = await mutationCase.load(entity.id);
      expect(mutationCase.versionOf(fulfilled[0]!.value)).toBe(expectedVersion + 1);
      expect(mutationCase.versionOf(persisted)).toBe(expectedVersion + 1);
      const winnerValue = mutationCase.valueOf(fulfilled[0]!.value);
      expect(winnerValue).toMatch(new RegExp(`^${mutationCase.name} contender [AB]$`));
      expect(mutationCase.valueOf(persisted)).toBe(winnerValue);

      const normalizedUpdate = capturedSql
        .map(normalizeSql)
        .find((statement) => statement.startsWith(`update ${mutationCase.table} set `));
      expect(normalizedUpdate).toBeDefined();
      expect(normalizedUpdate).toContain(
        `where (${mutationCase.table}.id = ? and ${mutationCase.table}.${mutationCase.versionColumn} = ?)`,
      );
    },
  );

  it('checks ReviewComment version before no-op classification and preserves true no-op timestamps', async () => {
    const comment = await seedReviewComment();
    const noOp = await service.updateReviewComment(
      comment.id,
      { content: comment.content },
      comment.version,
    );

    expect(noOp).toMatchObject({
      version: comment.version,
      updatedAt: comment.updatedAt,
      editedAt: comment.editedAt,
    });

    const changed = await service.updateReviewComment(
      comment.id,
      { status: 'resolved' },
      comment.version,
    );
    await expect(
      service.updateReviewComment(comment.id, { content: comment.content }, comment.version),
    ).rejects.toMatchObject({
      constructor: OptimisticLockError,
      details: { expectedVersion: comment.version, actualVersion: changed.version },
    });
  });

  it('sets ReviewComment edit timestamps and advances once for a content change', async () => {
    const comment = await seedReviewComment();

    const updated = await service.updateReviewComment(
      comment.id,
      { content: 'Edited comment' },
      comment.version,
    );

    expect(updated).toMatchObject({
      content: 'Edited comment',
      version: comment.version + 1,
      editedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  function relationRollbackCases(): RelationRollbackCase[] {
    return [
      {
        name: 'Epic',
        relationTable: 'epic_tags',
        relationIdColumn: 'epic_id',
        seed: seedEpic,
        update: (entity) =>
          service.updateEpic(
            entity.id,
            { title: 'Changed epic', tags: ['replacement'] },
            versionOf(entity),
          ),
        load: (id) => service.getEpic(id),
        scalarSnapshot: (entity) => ({ title: (entity as Epic).title }),
        tagsOf: (entity) => (entity as Epic).tags,
      },
      {
        name: 'Prompt',
        relationTable: 'prompt_tags',
        relationIdColumn: 'prompt_id',
        seed: seedPrompt,
        update: (entity) =>
          service.updatePrompt(
            entity.id,
            { title: 'Changed prompt', tags: ['replacement'] },
            versionOf(entity),
          ),
        load: (id) => service.getPrompt(id),
        scalarSnapshot: (entity) => ({ title: (entity as Prompt).title }),
        tagsOf: (entity) => (entity as Prompt).tags,
      },
      {
        name: 'Record',
        relationTable: 'record_tags',
        relationIdColumn: 'record_id',
        seed: seedRecord,
        update: (entity) =>
          service.updateRecord(
            entity.id,
            { data: { changed: true }, tags: ['replacement'] },
            versionOf(entity),
          ),
        load: (id) => service.getRecord(id),
        scalarSnapshot: (entity) => ({ data: (entity as EpicRecord).data }),
        tagsOf: (entity) => (entity as EpicRecord).tags,
      },
    ];
  }

  it.each(relationRollbackCases())(
    '$name rolls back scalar fields, version, and links when relation replacement fails',
    async (rollbackCase) => {
      const entity = await rollbackCase.seed();
      const storedBefore = await rollbackCase.load(entity.id);
      const originalScalar = rollbackCase.scalarSnapshot(storedBefore);
      const originalTags = [...rollbackCase.tagsOf(storedBefore)].sort();
      sqlite.exec(`
        CREATE TRIGGER fail_${rollbackCase.relationTable}_insert
        BEFORE INSERT ON ${rollbackCase.relationTable}
        WHEN NEW.${rollbackCase.relationIdColumn} = '${entity.id}'
        BEGIN SELECT RAISE(ABORT, 'relation failed'); END
      `);

      await expect(rollbackCase.update(entity)).rejects.toThrow('relation failed');

      const persisted = await rollbackCase.load(entity.id);
      expect(rollbackCase.scalarSnapshot(persisted)).toEqual(originalScalar);
      expect(versionOf(persisted)).toBe(versionOf(storedBefore));
      expect([...rollbackCase.tagsOf(persisted)].sort()).toEqual(originalTags);
    },
  );

  it('uses a savepoint so a caught joined relation failure preserves unrelated outer writes', async () => {
    const epic = await seedEpic();
    sqlite.exec(`
      CREATE TRIGGER fail_joined_epic_tag_insert
      BEFORE INSERT ON epic_tags WHEN NEW.epic_id = '${epic.id}'
      BEGIN SELECT RAISE(ABORT, 'joined relation failed'); END
    `);
    let beforeTagId = '';
    let afterTagId = '';

    await service.runInTransaction(async () => {
      beforeTagId = (await service.createTag({ projectId: project.id, name: 'outer-before' })).id;
      await expect(
        service.updateEpic(
          epic.id,
          { title: 'Failed joined update', tags: ['joined-replacement'] },
          epic.version,
        ),
      ).rejects.toThrow('joined relation failed');
      afterTagId = (await service.createTag({ projectId: project.id, name: 'outer-after' })).id;
    });

    await expect(service.getTag(beforeTagId)).resolves.toMatchObject({ name: 'outer-before' });
    await expect(service.getTag(afterTagId)).resolves.toMatchObject({ name: 'outer-after' });
    expect(await service.getEpic(epic.id)).toMatchObject({
      title: epic.title,
      version: epic.version,
      tags: epic.tags,
    });
  });

  it('rolls back a joined aggregate mutation and relations when the outer transaction fails', async () => {
    const epic = await seedEpic();

    await expect(
      service.runInTransaction(async () => {
        await service.updateEpic(
          epic.id,
          { title: 'Joined update', tags: ['joined-replacement'] },
          epic.version,
        );
        throw new Error('outer failure');
      }),
    ).rejects.toThrow('outer failure');

    expect(await service.getEpic(epic.id)).toMatchObject({
      title: epic.title,
      version: epic.version,
      tags: epic.tags,
    });
  });

  it('persists ScheduledEpic configuration and derived nextRunAt atomically', async () => {
    const schedule = await seedScheduledEpic();

    const updated = await service.updateScheduledEpic(
      schedule.id,
      { cronExpression: '0 10 * * *' },
      schedule.configVersion,
      { derivedRuntimeState: { nextRunAt: '2026-08-13T10:00:00.000Z' } },
    );

    expect(updated).toMatchObject({
      cronExpression: '0 10 * * *',
      nextRunAt: '2026-08-13T10:00:00.000Z',
      configVersion: schedule.configVersion + 1,
    });
  });

  it('maps a zero-row ScheduledEpic compare-and-swap to its public conflict', async () => {
    const schedule = await seedScheduledEpic();
    sqlite.exec(`
      CREATE TRIGGER ignore_scheduled_epic_update
      BEFORE UPDATE ON scheduled_epics WHEN OLD.id = '${schedule.id}'
      BEGIN SELECT RAISE(IGNORE); END
    `);

    await expect(
      service.updateScheduledEpic(schedule.id, { name: 'Ignored' }, schedule.configVersion),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'conflict',
      message: `ScheduledEpic version conflict: expected ${schedule.configVersion}, current ${schedule.configVersion}`,
      details: {
        id: schedule.id,
        expectedVersion: schedule.configVersion,
        currentVersion: schedule.configVersion,
      },
    });
  });
});
