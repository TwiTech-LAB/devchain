import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import type { ProviderEffortSeedingService } from '../../providers/services/provider-effort-seeding.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import { DataSeederService, REGISTERED_DATA_SEEDERS } from '../services/data-seeder.service';
import type { SeederContext } from '../types/seeder.types';
import { runSeedPromptTypeTags, seedPromptTypeTagsSeeder } from './0013_seed_prompt_type_tags';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const TS = '2026-07-28T00:00:00.000Z';

describe('0013_seed_prompt_type_tags', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    sqlite.close();
  });

  function createContext(): SeederContext {
    return {
      storage: {} as SeederContext['storage'],
      watchersService: {} as SeederContext['watchersService'],
      providerEffortSeeding: {} as SeederContext['providerEffortSeeding'],
      db,
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
      } as unknown as SeederContext['logger'],
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

  function insertPrompt(
    projectId: string | null,
    title: string,
    content: string,
    version: number,
  ): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO prompts
         (id, project_id, title, content, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, title, content, version, TS, TS);
    return id;
  }

  function insertTag(projectId: string | null, name: string): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO tags (id, project_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, name, TS, TS);
    return id;
  }

  function assignTag(promptId: string, tagId: string): void {
    sqlite
      .prepare(
        `INSERT INTO prompt_tags (prompt_id, tag_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(promptId, tagId, TS);
  }

  function readPromptTags(promptId: string): string[] {
    return (
      sqlite
        .prepare(
          `SELECT t.name
           FROM prompt_tags pt
           INNER JOIN tags t ON t.id = pt.tag_id
           WHERE pt.prompt_id = ?
           ORDER BY t.name`,
        )
        .all(promptId) as Array<{ name: string }>
    ).map((row) => row.name);
  }

  function readPromptState(): Array<{
    id: string;
    content: string;
    version: number;
  }> {
    return sqlite.prepare('SELECT id, content, version FROM prompts ORDER BY id').all() as Array<{
      id: string;
      content: string;
      version: number;
    }>;
  }

  it('backfills only untyped prompts while preserving prompt data and explicit tags', async () => {
    const project1 = insertProject('one');
    const project2 = insertProject('two');
    const project3 = insertProject('three');
    const globalSystemTag = insertTag(null, 'type:system');
    const projectSystemTag = insertTag(project1, 'type:system');
    const unrelatedTag = insertTag(project1, 'ops');
    const customTag = insertTag(project1, 'type:custom');
    const unknownTag = insertTag(project1, 'TYPE:future');
    const spacedSystemTag = insertTag(project1, ' Type : SYSTEM ');

    const globalUntyped = insertPrompt(null, 'global', 'global-content', 4);
    const projectUntyped = insertPrompt(project1, 'project-one', 'one-content', 7);
    const secondProjectUntyped = insertPrompt(project2, 'project-two', 'two-content', 2);
    const thirdProjectUntyped = insertPrompt(project3, 'project-three', 'three-content', 3);
    const explicitCustom = insertPrompt(project1, 'custom', 'custom-content', 5);
    const explicitUnknown = insertPrompt(project1, 'unknown', 'unknown-content', 6);
    const explicitMultiple = insertPrompt(project1, 'multiple', 'multiple-content', 8);
    const explicitSystem = insertPrompt(project1, 'system', 'system-content', 9);

    assignTag(projectUntyped, unrelatedTag);
    assignTag(explicitCustom, customTag);
    assignTag(explicitUnknown, unknownTag);
    assignTag(explicitMultiple, customTag);
    assignTag(explicitMultiple, unknownTag);
    assignTag(explicitSystem, spacedSystemTag);
    const promptStateBefore = readPromptState();

    await runSeedPromptTypeTags(createContext());

    expect(readPromptTags(globalUntyped)).toEqual(['type:system']);
    expect(readPromptTags(projectUntyped)).toEqual(['ops', 'type:system']);
    expect(readPromptTags(secondProjectUntyped)).toEqual(['type:system']);
    expect(readPromptTags(thirdProjectUntyped)).toEqual(['type:system']);
    expect(readPromptTags(explicitCustom)).toEqual(['type:custom']);
    expect(readPromptTags(explicitUnknown)).toEqual(['TYPE:future']);
    expect(readPromptTags(explicitMultiple)).toEqual(['TYPE:future', 'type:custom']);
    expect(readPromptTags(explicitSystem)).toEqual([' Type : SYSTEM ']);
    expect(readPromptState()).toEqual(promptStateBefore);

    const assignedTagIds = sqlite
      .prepare(
        `SELECT pt.prompt_id AS promptId, pt.tag_id AS tagId
         FROM prompt_tags pt
         INNER JOIN tags t ON t.id = pt.tag_id
         WHERE pt.prompt_id IN (?, ?, ?, ?) AND t.name = 'type:system'
         ORDER BY prompt_id`,
      )
      .all(globalUntyped, projectUntyped, secondProjectUntyped, thirdProjectUntyped) as Array<{
      promptId: string;
      tagId: string;
    }>;
    expect(assignedTagIds.find((row) => row.promptId === globalUntyped)?.tagId).toBe(
      globalSystemTag,
    );
    expect(assignedTagIds.find((row) => row.promptId === projectUntyped)?.tagId).toBe(
      projectSystemTag,
    );
    expect(assignedTagIds.find((row) => row.promptId === secondProjectUntyped)?.tagId).toBe(
      globalSystemTag,
    );

    expect(assignedTagIds.find((row) => row.promptId === thirdProjectUntyped)?.tagId).toBe(
      globalSystemTag,
    );

    const assignmentsAfterFirstRun = sqlite
      .prepare('SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id')
      .all();
    const tagsAfterFirstRun = sqlite
      .prepare('SELECT id, project_id, name FROM tags ORDER BY id')
      .all();

    await runSeedPromptTypeTags(createContext());

    expect(
      sqlite.prepare('SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id').all(),
    ).toEqual(assignmentsAfterFirstRun);
    expect(sqlite.prepare('SELECT id, project_id, name FROM tags ORDER BY id').all()).toEqual(
      tagsAfterFirstRun,
    );
  });

  it('skips historical orphan prompts and reports a capped list of their IDs', async () => {
    const project = insertProject('reachable');
    const reachablePrompt = insertPrompt(project, 'reachable', 'reachable-content', 2);
    const deadProjectId = randomUUID();

    sqlite.pragma('foreign_keys = OFF');
    const orphanPromptIds = Array.from({ length: 22 }, (_, index) =>
      insertPrompt(deadProjectId, `orphan-${index}`, `orphan-content-${index}`, index + 1),
    );
    sqlite.pragma('foreign_keys = ON');
    const orphanStateBefore = readPromptState().filter((row) => orphanPromptIds.includes(row.id));
    const ctx = createContext();

    await runSeedPromptTypeTags(ctx);

    expect(readPromptTags(reachablePrompt)).toEqual(['type:system']);
    expect(readPromptState().filter((row) => orphanPromptIds.includes(row.id))).toEqual(
      orphanStateBefore,
    );
    expect(
      sqlite
        .prepare(
          `SELECT prompt_id
           FROM prompt_tags
           WHERE prompt_id IN (${orphanPromptIds.map(() => '?').join(', ')})`,
        )
        .all(...orphanPromptIds),
    ).toEqual([]);
    expect(sqlite.prepare('SELECT id FROM tags WHERE project_id = ?').all(deadProjectId)).toEqual(
      [],
    );
    expect(sqlite.prepare('SELECT id FROM tags WHERE project_id IS NULL').all()).toEqual([]);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        skippedOrphanPrompts: orphanPromptIds.length,
        skippedOrphanPromptIds: [...orphanPromptIds].sort().slice(0, 20),
      }),
      'Backfilled untyped prompts as System',
    );
  });

  it('is data-idempotent and journaled once at version 1', async () => {
    const project = insertProject('one');
    const prompt = insertPrompt(project, 'legacy', 'content', 3);
    const deadProjectId = randomUUID();
    sqlite.pragma('foreign_keys = OFF');
    const orphanPrompt = insertPrompt(deadProjectId, 'orphan', 'orphan-content', 4);
    sqlite.pragma('foreign_keys = ON');
    const service = new DataSeederService(
      {} as StorageService,
      {} as WatchersService,
      {} as ProviderEffortSeedingService,
      db,
      [seedPromptTypeTagsSeeder],
    );

    await service.onModuleInit();
    const assignmentsAfterFirstRun = sqlite
      .prepare('SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id')
      .all();
    const tagsAfterFirstRun = sqlite
      .prepare('SELECT id, project_id, name FROM tags ORDER BY id')
      .all();
    const journalAfterFirstRun = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'seeders.journal'")
      .get() as { value: string };

    await service.onModuleInit();

    expect(readPromptTags(prompt)).toEqual(['type:system']);
    expect(readPromptTags(orphanPrompt)).toEqual([]);
    expect(sqlite.prepare('SELECT id FROM tags WHERE project_id = ?').all(deadProjectId)).toEqual(
      [],
    );
    expect(sqlite.prepare("SELECT project_id FROM tags WHERE name = 'type:system'").get()).toEqual({
      project_id: project,
    });
    expect(
      sqlite.prepare('SELECT prompt_id, tag_id FROM prompt_tags ORDER BY prompt_id, tag_id').all(),
    ).toEqual(assignmentsAfterFirstRun);
    expect(sqlite.prepare('SELECT id, project_id, name FROM tags ORDER BY id').all()).toEqual(
      tagsAfterFirstRun,
    );
    expect(
      sqlite.prepare("SELECT value FROM settings WHERE key = 'seeders.journal'").get(),
    ).toEqual(journalAfterFirstRun);
    expect(JSON.parse(journalAfterFirstRun.value)).toEqual({
      '0013_seed_prompt_type_tags': {
        version: 1,
        executedAt: expect.any(String),
      },
    });
  });

  it('is registered after 0012 with the permanent version-1 journal identity', () => {
    expect(seedPromptTypeTagsSeeder).toMatchObject({
      name: '0013_seed_prompt_type_tags',
      version: 1,
    });
    expect(REGISTERED_DATA_SEEDERS.slice(-2).map((seeder) => seeder.name)).toEqual([
      '0012_seed_claude_launch_settings',
      '0013_seed_prompt_type_tags',
    ]);
  });
});
