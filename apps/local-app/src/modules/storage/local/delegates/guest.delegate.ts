import type { CreateGuest, Guest } from '../../models/domain.models';
import { ConflictError, NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('GuestStorageDelegate');

export class GuestStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async createGuest(data: CreateGuest): Promise<Guest> {
    const { randomUUID } = await import('crypto');
    const { guests } = await import('../../db/schema');
    const { eq, and, sql } = await import('drizzle-orm');

    const now = new Date().toISOString();

    // Check for existing guest with same name in project (case-insensitive)
    const existingByName = await this.db
      .select()
      .from(guests)
      .where(
        and(
          eq(guests.projectId, data.projectId),
          sql`${guests.name} = ${data.name} COLLATE NOCASE`,
        ),
      )
      .limit(1);

    if (existingByName.length > 0) {
      throw new ConflictError(`Guest with name "${data.name}" already exists in project`, {
        projectId: data.projectId,
        name: data.name,
      });
    }

    // Check for existing guest with same tmux session
    const existingByTmux = await this.db
      .select()
      .from(guests)
      .where(eq(guests.tmuxSessionId, data.tmuxSessionId))
      .limit(1);

    if (existingByTmux.length > 0) {
      throw new ConflictError(`Guest with tmux session "${data.tmuxSessionId}" already exists`, {
        tmuxSessionId: data.tmuxSessionId,
      });
    }

    const guest: Guest = {
      id: randomUUID(),
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      tmuxSessionId: data.tmuxSessionId,
      lastSeenAt: data.lastSeenAt,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(guests).values(guest);

    logger.info({ guestId: guest.id, projectId: data.projectId, name: data.name }, 'Created guest');

    return guest;
  }

  async getGuest(id: string): Promise<Guest> {
    const { guests } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db.select().from(guests).where(eq(guests.id, id)).limit(1);

    if (rows.length === 0) {
      throw new NotFoundError('Guest', id);
    }

    return rows[0] as Guest;
  }

  async getGuestByName(projectId: string, name: string): Promise<Guest | null> {
    const { guests } = await import('../../db/schema');
    const { eq, and, sql } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(guests)
      .where(and(eq(guests.projectId, projectId), sql`${guests.name} = ${name} COLLATE NOCASE`))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as Guest;
  }

  async getGuestByTmuxSessionId(tmuxSessionId: string): Promise<Guest | null> {
    const { guests } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(guests)
      .where(eq(guests.tmuxSessionId, tmuxSessionId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as Guest;
  }

  async getGuestsByIdPrefix(prefix: string): Promise<Guest[]> {
    const { guests } = await import('../../db/schema');
    const { like } = await import('drizzle-orm');

    // Use SQL LIKE for efficient prefix matching (uses index)
    const rows = await this.db
      .select()
      .from(guests)
      .where(like(guests.id, `${prefix}%`));

    return rows as Guest[];
  }

  async listGuests(projectId: string): Promise<Guest[]> {
    const { guests } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(guests)
      .where(eq(guests.projectId, projectId))
      .orderBy(asc(guests.name));

    return rows as Guest[];
  }

  async listAllGuests(): Promise<Guest[]> {
    const { guests } = await import('../../db/schema');
    const { asc } = await import('drizzle-orm');

    const rows = await this.db.select().from(guests).orderBy(asc(guests.createdAt));

    return rows as Guest[];
  }

  async deleteGuest(id: string): Promise<void> {
    const { guests } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Verify guest exists
    await this.getGuest(id);

    await this.db.delete(guests).where(eq(guests.id, id));

    logger.info({ guestId: id }, 'Deleted guest');
  }

  async updateGuestLastSeen(id: string, lastSeenAt: string): Promise<Guest> {
    const { guests } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Verify guest exists
    const existing = await this.getGuest(id);

    const now = new Date().toISOString();

    await this.db
      .update(guests)
      .set({
        lastSeenAt,
        updatedAt: now,
      })
      .where(eq(guests.id, id));

    return {
      ...existing,
      lastSeenAt,
      updatedAt: now,
    };
  }
}
