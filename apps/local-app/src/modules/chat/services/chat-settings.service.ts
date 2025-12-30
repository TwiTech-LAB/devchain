import { Inject, Injectable } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { createLogger } from '../../../common/logging/logger';
import { ValidationError } from '../../../common/errors/error-types';
import {
  DEFAULT_INVITE_TEMPLATE,
  TEMPLATE_SIZE_LIMIT,
  findUnknownTokens,
} from './invite-template.util';

const logger = createLogger('ChatSettingsService');

interface TemplateStore {
  projects: Record<string, string>;
}

function isTemplateStore(value: unknown): value is TemplateStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (!record.projects || typeof record.projects !== 'object' || Array.isArray(record.projects)) {
    return false;
  }

  return true;
}

@Injectable()
export class ChatSettingsService {
  private readonly key = 'chat.invite_template';
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sqlite = (this.db as any).session?.client ?? (this.db as unknown as Database.Database);
  }

  async getInviteTemplate(projectId: string): Promise<string> {
    const store = this.loadTemplateStore();
    const template = store.projects[projectId];

    if (typeof template === 'string' && template.trim().length > 0) {
      return template;
    }

    return DEFAULT_INVITE_TEMPLATE;
  }

  async getStoredInviteTemplate(projectId: string): Promise<string> {
    const store = this.loadTemplateStore();
    const template = store.projects[projectId];
    return typeof template === 'string' ? template : '';
  }

  async updateInviteTemplate(projectId: string, template: string): Promise<string> {
    const normalized = template.trim();

    if (normalized.length > TEMPLATE_SIZE_LIMIT) {
      throw new ValidationError(
        `Template exceeds the maximum allowed length of ${TEMPLATE_SIZE_LIMIT} characters.`,
        {
          projectId,
          templateLength: normalized.length,
          maxLength: TEMPLATE_SIZE_LIMIT,
        },
      );
    }

    const unknownTokens = findUnknownTokens(normalized);
    if (unknownTokens.length > 0) {
      throw new ValidationError(
        `Unknown template tokens: ${unknownTokens.map((token) => `{{ ${token} }}`).join(', ')}`,
        {
          projectId,
          unknownTokens,
        },
      );
    }

    const store = this.loadTemplateStore();

    if (normalized.length === 0) {
      delete store.projects[projectId];
    } else {
      store.projects[projectId] = normalized;
    }

    this.persistTemplateStore(store);

    logger.info(
      { projectId, removed: normalized.length === 0 },
      'Updated chat invite template for project',
    );

    return normalized.length > 0 ? normalized : DEFAULT_INVITE_TEMPLATE;
  }

  private loadTemplateStore(): TemplateStore {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(this.key) as
      | { value: string }
      | undefined;

    if (!row || !row.value) {
      return { projects: {} };
    }

    try {
      const parsed = JSON.parse(row.value);
      if (isTemplateStore(parsed)) {
        return {
          projects: parsed.projects ?? {},
        };
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to parse chat invite template store; resetting');
    }

    return { projects: {} };
  }

  private persistTemplateStore(store: TemplateStore): void {
    const now = new Date().toISOString();

    if (Object.keys(store.projects).length === 0) {
      this.sqlite.prepare('DELETE FROM settings WHERE key = ?').run(this.key);
      return;
    }

    const stmt = this.sqlite.prepare(`
      INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    stmt.run(randomUUID(), this.key, JSON.stringify(store), now, now);
  }
}
