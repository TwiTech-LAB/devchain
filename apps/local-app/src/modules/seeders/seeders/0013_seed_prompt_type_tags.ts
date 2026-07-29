import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { isPromptTypeTag, PROMPT_TYPE, PROMPT_TYPE_TAG } from '../../../common/prompt-type';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0013_seed_prompt_type_tags';
const SEEDER_VERSION = 1;
const SYSTEM_TAG = PROMPT_TYPE_TAG[PROMPT_TYPE.System];
const SKIPPED_ORPHAN_PROMPT_ID_LOG_LIMIT = 20;

interface PromptTagRow {
  promptId: string;
  projectId: string | null;
  tagName: string | null;
}

interface ProjectIdRow {
  id: string;
}

function findReusableSystemTag(sqlite: Database.Database, projectId: string | null): string | null {
  if (projectId !== null) {
    const projectTag = sqlite
      .prepare(
        `SELECT id
         FROM tags
         WHERE project_id = ? AND name = ?
         ORDER BY id
         LIMIT 1`,
      )
      .get(projectId, SYSTEM_TAG) as { id: string } | undefined;
    if (projectTag) {
      return projectTag.id;
    }
  }

  const globalTag = sqlite
    .prepare(
      `SELECT id
       FROM tags
       WHERE project_id IS NULL AND name = ?
       ORDER BY id
       LIMIT 1`,
    )
    .get(SYSTEM_TAG) as { id: string } | undefined;
  return globalTag?.id ?? null;
}

export async function runSeedPromptTypeTags(ctx: SeederContext): Promise<void> {
  const sqlite = getRawSqliteClient(ctx.db);
  const result = new TransactionRunner(sqlite).runImmediate(() => {
    const validProjectIds = new Set(
      (sqlite.prepare('SELECT id FROM projects').all() as ProjectIdRow[]).map((row) => row.id),
    );
    const rows = sqlite
      .prepare(
        `SELECT p.id AS promptId, p.project_id AS projectId, t.name AS tagName
         FROM prompts p
         LEFT JOIN prompt_tags pt ON pt.prompt_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
         ORDER BY p.id`,
      )
      .all() as PromptTagRow[];

    const prompts = new Map<string, { projectId: string | null; tags: string[] }>();
    for (const row of rows) {
      const prompt = prompts.get(row.promptId) ?? { projectId: row.projectId, tags: [] };
      if (row.tagName !== null) {
        prompt.tags.push(row.tagName);
      }
      prompts.set(row.promptId, prompt);
    }

    const now = new Date().toISOString();
    let taggedPrompts = 0;
    let createdTags = 0;
    let skippedOrphanPrompts = 0;
    const skippedOrphanPromptIds: string[] = [];

    for (const [promptId, prompt] of prompts) {
      if (prompt.tags.some(isPromptTypeTag)) {
        continue;
      }
      if (prompt.projectId !== null && !validProjectIds.has(prompt.projectId)) {
        skippedOrphanPrompts += 1;
        if (skippedOrphanPromptIds.length < SKIPPED_ORPHAN_PROMPT_ID_LOG_LIMIT) {
          skippedOrphanPromptIds.push(promptId);
        }
        continue;
      }

      let tagId = findReusableSystemTag(sqlite, prompt.projectId);
      if (tagId === null) {
        tagId = randomUUID();
        sqlite
          .prepare(
            `INSERT INTO tags (id, project_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(tagId, prompt.projectId, SYSTEM_TAG, now, now);
        createdTags += 1;
      }

      const assignmentExists = sqlite
        .prepare(
          `SELECT 1
           FROM prompt_tags
           WHERE prompt_id = ? AND tag_id = ?
           LIMIT 1`,
        )
        .get(promptId, tagId);
      if (!assignmentExists) {
        sqlite
          .prepare(
            `INSERT INTO prompt_tags (prompt_id, tag_id, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(promptId, tagId, now);
        taggedPrompts += 1;
      }
    }

    return {
      scannedPrompts: prompts.size,
      taggedPrompts,
      createdTags,
      skippedOrphanPrompts,
      skippedOrphanPromptIds,
    };
  });

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      ...result,
    },
    'Backfilled untyped prompts as System',
  );
}

export const seedPromptTypeTagsSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedPromptTypeTags,
};
