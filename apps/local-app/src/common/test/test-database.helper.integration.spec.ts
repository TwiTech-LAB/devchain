import { readFileSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { pairedDeviceWorkspaceGrants, settings } from '../../modules/storage/db/schema';
import { createTestDatabase } from './test-database.helper';

// Real SQLite is the cheapest layer that verifies serialized schema and connection behavior.
describe('createTestDatabase', () => {
  it('isolates writes from other clones and the cached snapshot', () => {
    const first = createTestDatabase();
    const second = createTestDatabase();
    let third: ReturnType<typeof createTestDatabase> | undefined;
    try {
      first.db
        .insert(settings)
        .values({
          id: 'clone-only',
          key: 'clone-only',
          value: 'first',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        })
        .run();
      expect(
        first.db
          .select({ key: settings.key, value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'clone-only'))
          .all(),
      ).toEqual([{ key: 'clone-only', value: 'first' }]);
      expect(
        second.db
          .select({ key: settings.key, value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'clone-only'))
          .all(),
      ).toEqual([]);
      first.sqlite.close();
      third = createTestDatabase();
      expect(
        third.db
          .select({ key: settings.key, value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'clone-only'))
          .all(),
      ).toEqual([]);
    } finally {
      if (first.sqlite.open) first.sqlite.close();
      second.sqlite.close();
      third?.sqlite.close();
    }
  });

  it('includes the final migrated schema', () => {
    const { sqlite } = createTestDatabase();
    try {
      expect(sqlite.prepare('SELECT tls_certificate FROM remotes').all()).toEqual([]);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({
        count: JSON.parse(
          readFileSync(join(__dirname, '../../../drizzle/meta/_journal.json'), 'utf8'),
        ).entries.length,
      });
    } finally {
      sqlite.close();
    }
  });

  it('enforces foreign keys on each clone', () => {
    const { sqlite, db } = createTestDatabase();
    try {
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(() =>
        db
          .insert(pairedDeviceWorkspaceGrants)
          .values({ deviceKid: 'device', workspaceId: 'missing-workspace' })
          .run(),
      ).toThrow('FOREIGN KEY constraint failed');
    } finally {
      sqlite.close();
    }
  });
});
