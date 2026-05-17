import Database from 'better-sqlite3';
import { EventEmitter2 } from 'eventemitter2';
import { CoreSettingsDelegate } from './core-settings.delegate';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../../../../common/constants/terminal';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function createDelegate(db: Database.Database): CoreSettingsDelegate {
  const eventEmitter = new EventEmitter2();
  return new CoreSettingsDelegate({ sqlite: db, eventEmitter: eventEmitter as any });
}

function upsert(db: Database.Database, key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run('test-id', key, value, now, now);
}

describe('CoreSettingsDelegate', () => {
  let db: Database.Database;
  let delegate: CoreSettingsDelegate;

  beforeEach(() => {
    db = createTestDb();
    delegate = createDelegate(db);
  });
  afterEach(() => db.close());

  describe('Invariant: scrollback clamping', () => {
    it('clamps scrollback below MIN to MIN', async () => {
      const result = await delegate.updateSettings({
        terminal: { scrollbackLines: 1 },
      });
      expect(result.terminal?.scrollbackLines).toBe(MIN_TERMINAL_SCROLLBACK);
    });

    it('clamps scrollback above MAX to MAX', async () => {
      const result = await delegate.updateSettings({
        terminal: { scrollbackLines: 999999 },
      });
      expect(result.terminal?.scrollbackLines).toBe(MAX_TERMINAL_SCROLLBACK);
    });

    it('preserves scrollback within valid range', async () => {
      const result = await delegate.updateSettings({
        terminal: { scrollbackLines: 5000 },
      });
      expect(result.terminal?.scrollbackLines).toBe(5000);
    });

    it('clamps stored scrollback on read via getSettings', () => {
      upsert(db, 'terminal.scrollback.lines', String(-100));
      const result = delegate.getSettings();
      expect(result.terminal?.scrollbackLines).toBe(MIN_TERMINAL_SCROLLBACK);
    });

    it('defaults scrollback to DEFAULT when no row exists', () => {
      const result = delegate.getSettings();
      expect(result.terminal?.scrollbackLines).toBe(DEFAULT_TERMINAL_SCROLLBACK);
    });

    it('getScrollbackLines clamps and returns number', async () => {
      await delegate.updateSettings({ terminal: { scrollbackLines: 500 } });
      expect(delegate.getScrollbackLines()).toBe(500);
    });

    it('getScrollbackLines returns DEFAULT when no row exists', () => {
      expect(delegate.getScrollbackLines()).toBe(DEFAULT_TERMINAL_SCROLLBACK);
    });

    it('getScrollbackLines clamps out-of-range stored value', () => {
      upsert(db, 'terminal.scrollback.lines', String(999999));
      expect(delegate.getScrollbackLines()).toBe(MAX_TERMINAL_SCROLLBACK);
    });
  });

  describe('Invariant: terminal seed max bytes clamping', () => {
    it('clamps below MIN to MIN', async () => {
      const result = await delegate.updateSettings({
        terminal: { seedingMaxBytes: 0 },
      });
      expect(result.terminal?.seedingMaxBytes).toBe(64 * 1024);
    });

    it('clamps above MAX to MAX', async () => {
      const result = await delegate.updateSettings({
        terminal: { seedingMaxBytes: 999999999 },
      });
      expect(result.terminal?.seedingMaxBytes).toBe(4 * 1024 * 1024);
    });

    it('preserves within valid range', async () => {
      const result = await delegate.updateSettings({
        terminal: { seedingMaxBytes: 512 * 1024 },
      });
      expect(result.terminal?.seedingMaxBytes).toBe(512 * 1024);
    });

    it('defaults to 1MB when no row exists', () => {
      const result = delegate.getSettings();
      expect(result.terminal?.seedingMaxBytes).toBe(1024 * 1024);
    });

    it('clamps stored invalid value on read', () => {
      upsert(db, 'terminal.seeding.maxBytes', String(-50));
      const result = delegate.getSettings();
      expect(result.terminal?.seedingMaxBytes).toBe(64 * 1024);
    });
  });

  describe('Invariant: terminal inputMode validation', () => {
    it('accepts valid inputMode "tty"', async () => {
      const result = await delegate.updateSettings({
        terminal: { inputMode: 'tty' },
      });
      expect(result.terminal?.inputMode).toBe('tty');
    });

    it('accepts valid inputMode "form"', async () => {
      const result = await delegate.updateSettings({
        terminal: { inputMode: 'form' },
      });
      expect(result.terminal?.inputMode).toBe('form');
    });

    it('defaults to "tty" when no row exists', () => {
      const result = delegate.getSettings();
      expect(result.terminal?.inputMode).toBe('tty');
    });

    it('defaults to "tty" for invalid stored value', () => {
      upsert(db, 'terminal.inputMode', JSON.stringify('invalid'));
      const result = delegate.getSettings();
      expect(result.terminal?.inputMode).toBe('tty');
    });
  });

  describe('Invariant: activity idle timeout defaults and clamping', () => {
    it('stores and retrieves idleTimeoutMs', async () => {
      const result = await delegate.updateSettings({
        activity: { idleTimeoutMs: 5000 },
      });
      expect(result.activity?.idleTimeoutMs).toBe(5000);
    });

    it('clamps idleTimeoutMs below 1000 to 1000', async () => {
      const result = await delegate.updateSettings({
        activity: { idleTimeoutMs: 0 },
      });
      expect(result.activity?.idleTimeoutMs).toBe(1000);
    });

    it('clamps idleTimeoutMs above 24h to 24h', async () => {
      const result = await delegate.updateSettings({
        activity: { idleTimeoutMs: 100000000 },
      });
      expect(result.activity?.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
    });

    it('does not set activity when no row exists', () => {
      const result = delegate.getSettings();
      expect(result.activity).toBeUndefined();
    });

    it('defaults to 30000 for non-finite stored value', () => {
      upsert(db, 'activity.idleTimeoutMs', 'not-a-number');
      const result = delegate.getSettings();
      expect(result.activity?.idleTimeoutMs).toBe(30000);
    });

    it('defaults to 30000 for zero stored value', () => {
      upsert(db, 'activity.idleTimeoutMs', '0');
      const result = delegate.getSettings();
      expect(result.activity?.idleTimeoutMs).toBe(30000);
    });
  });

  describe('Invariant: binary path validation', () => {
    it('rejects claude binary path that does not exist', async () => {
      await expect(
        delegate.updateSettings({ claudeBinaryPath: '/nonexistent/binary' }),
      ).rejects.toThrow('Binary not');
    });

    it('rejects codex binary path that does not exist', async () => {
      await expect(
        delegate.updateSettings({ codexBinaryPath: '/nonexistent/binary' }),
      ).rejects.toThrow('Binary not');
    });

    it('allows empty string binary path without validation', async () => {
      const result = await delegate.updateSettings({ claudeBinaryPath: '' });
      expect(result.claudeBinaryPath).toBe('');
    });

    it('allows undefined binary path without validation', async () => {
      const result = await delegate.updateSettings({});
      expect(result.claudeBinaryPath).toBeUndefined();
    });
  });

  describe('Invariant: decodeStringSetting', () => {
    it('decodes JSON-wrapped string', () => {
      upsert(db, 'registry.url', JSON.stringify('https://example.com'));
      const value = delegate.getSetting('registry.url');
      expect(value).toBe('https://example.com');
    });

    it('returns raw string for non-JSON values', () => {
      upsert(db, 'registry.url', 'https://raw.example.com');
      const value = delegate.getSetting('registry.url');
      expect(value).toBe('https://raw.example.com');
    });

    it('returns empty string for empty value', () => {
      upsert(db, 'registry.url', '');
      const value = delegate.getSetting('registry.url');
      expect(value).toBe('');
    });

    it('returns empty string for whitespace-only value', () => {
      upsert(db, 'registry.url', '   ');
      const value = delegate.getSetting('registry.url');
      expect(value).toBe('');
    });

    it('returns undefined for missing key', () => {
      const value = delegate.getSetting('nonexistent.key');
      expect(value).toBeUndefined();
    });
  });

  describe('Invariant: normalizeSkillSourcesMap', () => {
    it('normalizes keys to lowercase and trims whitespace', () => {
      const result = delegate.normalizeSkillSourcesMap({
        '  GitHub  ': true,
        NPM: false,
      });
      expect(result).toEqual({ github: true, npm: false });
    });

    it('filters out non-boolean values', () => {
      const result = delegate.normalizeSkillSourcesMap({
        valid: true,
        invalid: 'yes' as unknown as boolean,
        alsoInvalid: 1 as unknown as boolean,
      });
      expect(result).toEqual({ valid: true });
    });

    it('filters out empty/whitespace-only keys', () => {
      const result = delegate.normalizeSkillSourcesMap({
        '': true,
        '   ': true,
        valid: false,
      });
      expect(result).toEqual({ valid: false });
    });

    it('returns empty object for empty input', () => {
      expect(delegate.normalizeSkillSourcesMap({})).toEqual({});
    });
  });

  describe('Invariant: extractPromptId', () => {
    it('extracts promptId from simple string value', () => {
      upsert(db, 'initialSessionPromptId', JSON.stringify('prompt-123'));
      const result = delegate.getSettings();
      expect(result.initialSessionPromptId).toBe('prompt-123');
    });

    it('extracts promptId from nested object with initialSessionPromptId key', () => {
      upsert(
        db,
        'initialSessionPromptId',
        JSON.stringify({ initialSessionPromptId: 'prompt-from-nested' }),
      );
      const result = delegate.getSettings();
      expect(result.initialSessionPromptId).toBe('prompt-from-nested');
    });

    it('extracts promptId from nested object with value key', () => {
      upsert(db, 'initialSessionPromptId', JSON.stringify({ value: 'prompt-from-value' }));
      const result = delegate.getSettings();
      expect(result.initialSessionPromptId).toBe('prompt-from-value');
    });

    it('returns null for empty string', () => {
      upsert(db, 'initialSessionPromptId', '""');
      const result = delegate.getSettings();
      expect(result.initialSessionPromptId).toBeNull();
    });

    it('returns null for missing key', () => {
      const result = delegate.getSettings();
      expect(result.initialSessionPromptId).toBeUndefined();
    });
  });

  describe('Invariant: settings.terminal.changed event emission', () => {
    it('emits settings.terminal.changed when scrollbackLines updated', async () => {
      const eventEmitter = new EventEmitter2();
      const localDelegate = new CoreSettingsDelegate({
        sqlite: db,
        eventEmitter: eventEmitter as any,
      });

      let emittedPayload: any = null;
      eventEmitter.on('settings.terminal.changed', (payload: any) => {
        emittedPayload = payload;
      });

      await localDelegate.updateSettings({ terminal: { scrollbackLines: 5000 } });

      expect(emittedPayload).toEqual({ scrollbackLines: 5000 });
    });

    it('emits clamped scrollback value', async () => {
      const eventEmitter = new EventEmitter2();
      const localDelegate = new CoreSettingsDelegate({
        sqlite: db,
        eventEmitter: eventEmitter as any,
      });

      let emittedPayload: any = null;
      eventEmitter.on('settings.terminal.changed', (payload: any) => {
        emittedPayload = payload;
      });

      await localDelegate.updateSettings({ terminal: { scrollbackLines: 999999 } });

      expect(emittedPayload).toEqual({ scrollbackLines: MAX_TERMINAL_SCROLLBACK });
    });

    it('does not emit event when scrollbackLines not in update', async () => {
      const eventEmitter = new EventEmitter2();
      const localDelegate = new CoreSettingsDelegate({
        sqlite: db,
        eventEmitter: eventEmitter as any,
      });

      let emitted = false;
      eventEmitter.on('settings.terminal.changed', () => {
        emitted = true;
      });

      await localDelegate.updateSettings({ dbPath: '/some/path' });

      expect(emitted).toBe(false);
    });
  });

  describe('Invariant: updateSettings transaction atomicity', () => {
    it('rolls back all writes on failure', async () => {
      upsert(db, 'terminal.scrollback.lines', String(DEFAULT_TERMINAL_SCROLLBACK));

      const originalPrepare = db.prepare.bind(db);
      let callCount = 0;
      const spy = jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO settings')) {
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args: unknown[]) => {
            callCount++;
            if (callCount >= 2) {
              throw new Error('Simulated write failure');
            }
            return originalRun(...args);
          };
        }
        return stmt;
      });

      await expect(
        delegate.updateSettings({ dbPath: '/some/path', claudeBinaryPath: '' }),
      ).rejects.toThrow('Simulated write failure');

      spy.mockRestore();

      const settings = delegate.getSettings();
      expect(settings.dbPath).toBeUndefined();
    });
  });

  describe('Invariant: initialSessionPromptIds per-project storage', () => {
    it('stores per-project prompt ID via projectId', async () => {
      const result = await delegate.updateSettings({
        initialSessionPromptId: 'prompt-A',
        projectId: 'proj-1',
      });

      expect(result.initialSessionPromptIds).toBeDefined();
      expect(result.initialSessionPromptIds?.['proj-1']).toBe('prompt-A');
    });

    it('clears per-project prompt ID with null', async () => {
      await delegate.updateSettings({
        initialSessionPromptId: 'prompt-A',
        projectId: 'proj-1',
      });

      const result = await delegate.updateSettings({
        initialSessionPromptId: null,
        projectId: 'proj-1',
      });

      expect(result.initialSessionPromptIds?.['proj-1']).toBeNull();
    });
  });

  describe('Invariant: events template storage', () => {
    it('stores and retrieves epic assigned template', async () => {
      const result = await delegate.updateSettings({
        events: { epicAssigned: { template: 'Assigned: {{epic}}' } },
      });
      expect(result.events?.epicAssigned?.template).toBe('Assigned: {{epic}}');
    });

    it('stores empty string when template is null', async () => {
      const result = await delegate.updateSettings({
        events: { epicAssigned: { template: null } },
      });
      expect(result.events?.epicAssigned?.template).toBe('');
    });
  });

  describe('getSettings returns defaults for empty DB', () => {
    it('returns terminal defaults when no settings stored', () => {
      const result = delegate.getSettings();
      expect(result.terminal?.scrollbackLines).toBe(DEFAULT_TERMINAL_SCROLLBACK);
      expect(result.terminal?.seedingMaxBytes).toBe(1024 * 1024);
      expect(result.terminal?.inputMode).toBe('tty');
    });
  });
});
