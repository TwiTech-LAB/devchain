import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SettingsService,
  DEFAULT_TERMINAL_SCROLLBACK,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  DEFAULT_TERMINAL_INPUT_MODE,
  DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
  DEFAULT_SKILLS_SYNC_ON_STARTUP,
  DEFAULT_MESSAGING_FOLLOW_NOTE,
  DEFAULT_MESSAGE_POOL_ENABLED,
  DEFAULT_MESSAGE_POOL_DELAY_MS,
  DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
  DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
  DEFAULT_MESSAGE_POOL_SEPARATOR,
} from './settings.service';

// Helper to create mock EventEmitter2
function createMockEventEmitter(): EventEmitter2 & { emit: jest.Mock } {
  return {
    emit: jest.fn(),
  } as unknown as EventEmitter2 & { emit: jest.Mock };
}

describe('SettingsService (terminal settings)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('round-trips false and then true through the exact KV key', async () => {
    // Layer note: the contract under test is KV encode/decode fidelity
    // ('false' must not collapse to the default), which only a real SQLite
    // round-trip can prove; mocking the delegate would test the mock.
    await service.updateSettings({
      terminal: { suppressCtrlCWithSelection: false },
    });

    expect(service.getSetting('terminal.suppressCtrlCWithSelection')).toBe('false');
    expect(service.getSettings().terminal?.suppressCtrlCWithSelection).toBe(false);

    await service.updateSettings({
      terminal: { suppressCtrlCWithSelection: true },
    });

    expect(service.getSetting('terminal.suppressCtrlCWithSelection')).toBe('true');
    expect(service.getSettings().terminal?.suppressCtrlCWithSelection).toBe(true);
  });

  it('keeps a stored false through an unrelated terminal-setting partial update', async () => {
    // Layer note: partial-update preservation is a storage-layer merge
    // property (untouched KV rows must survive sibling writes inside one
    // transaction); asserting it at the service-over-SQLite layer is the
    // cheapest reliable proof without controller overhead.
    await service.updateSettings({
      terminal: { suppressCtrlCWithSelection: false },
    });

    await service.updateSettings({
      terminal: { scrollbackLines: 12000, inputMode: 'form' },
    });

    expect(service.getSetting('terminal.suppressCtrlCWithSelection')).toBe('false');
    expect(service.getSettings().terminal?.suppressCtrlCWithSelection).toBe(false);
    expect(service.getSettings().terminal?.scrollbackLines).toBe(12000);
    expect(service.getSettings().terminal?.inputMode).toBe('form');
  });
});

describe('SettingsService (getScrollbackLines)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns default for invalid (non-numeric) stored value', () => {
    // Manually insert an invalid value
    sqlite.exec(`
      INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES ('test-id', 'terminal.scrollback.lines', '"not-a-number"', datetime('now'), datetime('now'))
    `);

    const result = service.getScrollbackLines();
    expect(result).toBe(DEFAULT_TERMINAL_SCROLLBACK);
  });
});

describe('SettingsService (registry config)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.REGISTRY_URL;

    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    process.env = originalEnv;
    sqlite.close();
  });

  it('merges partial config updates with existing values', async () => {
    await service.setRegistryConfig({
      url: 'https://my-registry.example.com',
      checkUpdatesOnStartup: true,
    });

    await service.setRegistryConfig({
      cacheDir: '/custom/cache',
    });

    const config = service.getRegistryConfig();
    expect(config.url).toBe('https://my-registry.example.com');
    expect(config.cacheDir).toBe('/custom/cache');
    expect(config.checkUpdatesOnStartup).toBe(true);
  });
});

describe('SettingsService (skills sync on startup)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('persists and reads false', async () => {
    await service.updateSettings({
      skills: {
        syncOnStartup: false,
      },
    });

    expect(service.getSkillsSyncOnStartup()).toBe(false);
    expect(service.getSetting('skills.syncOnStartup')).toBe('false');
  });
});

describe('SettingsService (skills source enablement)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('persists and retrieves source enablement map', async () => {
    await service.setSkillSourceEnabled('OpenAI', false);
    await service.setSkillSourceEnabled('anthropic', true);

    expect(service.getSkillSourcesEnabled()).toEqual({
      openai: false,
      anthropic: true,
    });
  });
});

describe('SettingsService (project template metadata)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns empty array when no projects tracked', () => {
    const tracked = service.getAllTrackedProjects();
    expect(tracked).toEqual([]);
  });

  it('stores and retrieves template metadata for a project', async () => {
    const metadata = {
      templateSlug: 'basic-template',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };

    await service.setProjectTemplateMetadata('proj-123', metadata);

    const retrieved = service.getProjectTemplateMetadata('proj-123');
    expect(retrieved).toEqual(metadata);
  });

  it('returns tracked projects with metadata', async () => {
    const metadata1 = {
      templateSlug: 'template-a',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };
    const metadata2 = {
      templateSlug: 'template-b',
      installedVersion: '2.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-16T12:00:00Z',
    };

    await service.setProjectTemplateMetadata('proj-1', metadata1);
    await service.setProjectTemplateMetadata('proj-2', metadata2);

    const tracked = service.getAllTrackedProjects();
    expect(tracked).toHaveLength(2);
    expect(tracked).toContainEqual({ projectId: 'proj-1', metadata: metadata1 });
    expect(tracked).toContainEqual({ projectId: 'proj-2', metadata: metadata2 });
  });

  it('does not affect other projects when clearing one', async () => {
    const metadata1 = {
      templateSlug: 'keep-this',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };
    const metadata2 = {
      templateSlug: 'remove-this',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };

    await service.setProjectTemplateMetadata('proj-keep', metadata1);
    await service.setProjectTemplateMetadata('proj-remove', metadata2);

    await service.clearProjectTemplateMetadata('proj-remove');

    expect(service.getProjectTemplateMetadata('proj-keep')).toEqual(metadata1);
    expect(service.getProjectTemplateMetadata('proj-remove')).toBeNull();
  });

  it('updates lastUpdateCheckAt timestamp', async () => {
    const metadata = {
      templateSlug: 'check-updates',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };

    await service.setProjectTemplateMetadata('proj-update-check', metadata);

    const before = new Date().toISOString();
    await service.updateLastUpdateCheck('proj-update-check');
    const after = new Date().toISOString();

    const updated = service.getProjectTemplateMetadata('proj-update-check');
    expect(updated).not.toBeNull();
    expect(updated!.lastUpdateCheckAt).toBeDefined();
    expect(updated!.lastUpdateCheckAt! >= before).toBe(true);
    expect(updated!.lastUpdateCheckAt! <= after).toBe(true);
  });
});

describe('SettingsService (terminal settings event emission)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('emits settings.terminal.changed event when scrollbackLines is updated', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 5000,
      },
    });

    expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith('settings.terminal.changed', {
      scrollbackLines: 5000,
    });
  });

  it('does not emit event when only other terminal settings are updated', async () => {
    await service.updateSettings({
      terminal: {
        inputMode: 'tty',
      },
    });

    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('succeeds and persists settings even when event emission throws', async () => {
    // Configure mock to throw
    mockEventEmitter.emit.mockImplementation(() => {
      throw new Error('Event handler failed');
    });

    // Should not throw - API should succeed
    const result = await service.updateSettings({
      terminal: {
        scrollbackLines: 5000,
      },
    });

    // Verify settings were persisted
    expect(result.terminal?.scrollbackLines).toBe(5000);

    // Verify emit was attempted
    expect(mockEventEmitter.emit).toHaveBeenCalledWith('settings.terminal.changed', {
      scrollbackLines: 5000,
    });
  });
});

describe('SettingsService (message pool settings)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('clears project pool settings when passed null', async () => {
    await service.setProjectPoolSettings('proj-to-clear', {
      enabled: false,
    });

    expect(service.getProjectPoolSettings('proj-to-clear')).toBeDefined();

    await service.setProjectPoolSettings('proj-to-clear', null);

    expect(service.getProjectPoolSettings('proj-to-clear')).toBeUndefined();
  });

  it('does not affect other projects when updating one', async () => {
    await service.setProjectPoolSettings('proj-a', { enabled: false });
    await service.setProjectPoolSettings('proj-b', { delayMs: 3000 });

    await service.setProjectPoolSettings('proj-a', { enabled: true, maxMessages: 20 });

    expect(service.getProjectPoolSettings('proj-a')).toEqual({ enabled: true, maxMessages: 20 });
    expect(service.getProjectPoolSettings('proj-b')).toEqual({ delayMs: 3000 });
  });
});

describe('SettingsService (messaging settings)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    sqlite = createTestDb();
    ({ service } = createTestService(sqlite));
  });

  afterEach(() => sqlite.close());

  it('reads followNote as on when unset', () => {
    expect(service.getSettings().messaging?.followNote).toBe(DEFAULT_MESSAGING_FOLLOW_NOTE);
    expect(service.getFollowNoteEnabled()).toBe(true);
  });

  it('round-trips false and then true through the exact KV key', async () => {
    // Layer note: the contract under test is KV encode/decode fidelity
    // ('false' must not collapse to the default), which only a real SQLite
    // round-trip can prove; mocking the delegate would test the mock.
    await service.updateSettings({ messaging: { followNote: false } });

    expect(service.getSetting('messaging.followNote')).toBe('false');
    expect(service.getSettings().messaging?.followNote).toBe(false);
    expect(service.getFollowNoteEnabled()).toBe(false);

    await service.updateSettings({ messaging: { followNote: true } });

    expect(service.getSetting('messaging.followNote')).toBe('true');
    expect(service.getSettings().messaging?.followNote).toBe(true);
    expect(service.getFollowNoteEnabled()).toBe(true);
  });
});

describe('SettingsService (preset CRUD)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  const validPreset = {
    name: 'My Preset',
    description: 'A test preset',
    agentConfigs: [
      { agentName: 'Agent1', providerConfigName: 'Config1' },
      { agentName: 'Agent2', providerConfigName: 'Config2' },
    ],
  };

  describe('createProjectPreset', () => {
    it('creates a new preset with valid data', async () => {
      await service.createProjectPreset('proj-1', validPreset);

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0]).toEqual(validPreset);
    });

    it('trims whitespace from preset name', async () => {
      await service.createProjectPreset('proj-1', { ...validPreset, name: '  My Preset  ' });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].name).toBe('My Preset');
    });
  });

  describe('removeAgentFromProjectPresets', () => {
    it('passes through agent removal to the preset delegate', async () => {
      await service.setProjectPresets('proj-1', [
        {
          name: 'My Preset',
          agentConfigs: [
            { agentName: 'Agent1', providerConfigName: 'Config1' },
            { agentName: 'Agent2', providerConfigName: 'Config2' },
          ],
        },
      ]);

      await service.removeAgentFromProjectPresets('proj-1', 'agent1');

      const configs = service.getProjectPresets('proj-1')[0].agentConfigs;
      expect(configs).toHaveLength(1);
      expect(configs[0].agentName).toBe('Agent2');
    });
  });

  describe('renameProviderConfigInProjectPresets', () => {
    it('passes through provider config preset renames to the preset delegate', async () => {
      await service.setProjectPresets('proj-1', [
        {
          name: 'My Preset',
          agentConfigs: [{ agentName: 'Agent1', providerConfigName: 'Config1' }],
        },
      ]);

      await service.renameProviderConfigInProjectPresets('proj-1', {
        profileId: 'profile-1',
        oldName: 'config1',
        newName: 'Config Renamed',
        agents: [{ name: 'agent1', profileId: 'profile-1' }],
      });

      expect(service.getProjectPresets('proj-1')[0].agentConfigs[0].providerConfigName).toBe(
        'Config Renamed',
      );
    });
  });

  describe('updateProjectPreset', () => {
    beforeEach(async () => {
      await service.createProjectPreset('proj-1', validPreset);
    });

    it('updates preset name', async () => {
      await service.updateProjectPreset('proj-1', 'My Preset', { name: 'Updated Preset' });

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('Updated Preset');
    });

    it('trims whitespace from updated name', async () => {
      await service.updateProjectPreset('proj-1', 'My Preset', { name: '  New Name  ' });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].name).toBe('New Name');
    });

    it('migrates activePreset when preset name differs only in case (regression)', async () => {
      // Set active preset with different casing than stored preset name
      await service.setProjectActivePreset('proj-1', 'my preset'); // lowercase

      // Verify active preset is set
      expect(service.getProjectActivePreset('proj-1')).toBe('my preset');

      // Rename preset to match the active preset's casing (case-insensitive migration)
      await service.updateProjectPreset('proj-1', 'My Preset', { name: 'my preset' });

      // Active preset should be updated to the new canonical name (lowercase)
      expect(service.getProjectActivePreset('proj-1')).toBe('my preset');

      // Verify the preset was renamed
      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].name).toBe('my preset');
    });
  });

  describe('deleteProjectPreset', () => {
    beforeEach(async () => {
      await service.createProjectPreset('proj-1', validPreset);
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        name: 'Another Preset',
      });
    });

    it('deletes preset by name', async () => {
      await service.deleteProjectPreset('proj-1', 'My Preset');

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('Another Preset');
    });

    it('trims whitespace from search name', async () => {
      await service.deleteProjectPreset('proj-1', '  My Preset  ');

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
    });
  });
});

describe('SettingsService (project active preset tracking)', () => {
  let sqlite: Database.Database;
  let service: SettingsService;
  let mockEventEmitter: EventEmitter2 & { emit: jest.Mock };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    mockEventEmitter = createMockEventEmitter();
    service = new SettingsService(sqlite as unknown as BetterSQLite3Database, mockEventEmitter);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('getProjectActivePreset', () => {
    it('returns the active preset name for a project', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');

      const activePreset = service.getProjectActivePreset('proj-1');
      expect(activePreset).toBe('My Preset');
    });
  });

  describe('setProjectActivePreset', () => {
    it('sets the active preset for a project', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');

      const settings = service.getSettings();
      expect(settings.projectActivePresets?.['proj-1']).toBe('Preset A');
    });

    it('does not affect other projects when clearing one', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');
      await service.setProjectActivePreset('proj-2', 'Preset B');

      await service.setProjectActivePreset('proj-1', null);

      expect(service.getProjectActivePreset('proj-1')).toBeNull();
      expect(service.getProjectActivePreset('proj-2')).toBe('Preset B');
    });
  });
});

// ==========================================================================
// Characterization Tests — lock current SettingsService behavior for 4B.0
// ==========================================================================

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

function createTestService(
  db: Database.Database,
  emitter?: EventEmitter2 & { emit: jest.Mock },
): { service: SettingsService; emitter: EventEmitter2 & { emit: jest.Mock } } {
  const mockEmitter = emitter ?? createMockEventEmitter();
  const service = new SettingsService(db as unknown as BetterSQLite3Database, mockEmitter);
  return { service, emitter: mockEmitter };
}

describe('SettingsService — Characterization: getSettings() comprehensive', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('returns empty SettingsDto with terminal defaults when DB is empty', () => {
    const s = service.getSettings();
    expect(s.terminal).toEqual({
      scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
      seedingMaxBytes: DEFAULT_TERMINAL_SEED_MAX_BYTES,
      inputMode: DEFAULT_TERMINAL_INPUT_MODE,
      suppressCtrlCWithSelection: DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
    });
    expect(s.claudeBinaryPath).toBeUndefined();
    expect(s.codexBinaryPath).toBeUndefined();
    expect(s.dbPath).toBeUndefined();
    expect(s.events).toBeUndefined();
    expect(s.activity).toBeUndefined();
    expect(s.autoClean).toBeUndefined();
    expect(s.messagePool).toBeUndefined();
    expect(s.registry).toBeUndefined();
    expect(s.skills).toBeUndefined();
    expect(s.registryTemplates).toBeUndefined();
    expect(s.projectPresets).toBeUndefined();
    expect(s.projectActivePresets).toBeUndefined();
  });

  it('ignores legacy instanceMode and apiKey keys', () => {
    db.exec(`
      INSERT INTO settings VALUES ('1','instanceMode','local',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','apiKey','secret',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect((s as Record<string, unknown>)['instanceMode']).toBeUndefined();
    expect((s as Record<string, unknown>)['apiKey']).toBeUndefined();
  });

  it('ignores legacy terminal.seeding.mode and terminal.engine keys', () => {
    db.exec(`
      INSERT INTO settings VALUES ('1','terminal.seeding.mode','pty',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','terminal.engine','xterm',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect(s.terminal).toEqual({
      scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
      seedingMaxBytes: DEFAULT_TERMINAL_SEED_MAX_BYTES,
      inputMode: DEFAULT_TERMINAL_INPUT_MODE,
      suppressCtrlCWithSelection: DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
    });
  });

  it.each([
    ['claudeBinaryPath', '/usr/bin/claude'],
    ['codexBinaryPath', '/usr/bin/codex'],
    ['dbPath', '/data/devchain.db'],
  ] as const)('reads %s from storage', (key, value) => {
    db.prepare("INSERT INTO settings VALUES ('1', ?, ?, datetime('now'), datetime('now'))").run(
      key,
      value,
    );
    expect(service.getSettings()[key]).toBe(value);
  });

  it('reads activity.idleTimeoutMs from storage', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','activity.idleTimeoutMs','60000',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().activity?.idleTimeoutMs).toBe(60000);
  });

  it('reads autoClean.statusIds JSON map from storage', () => {
    const map = { 'proj-1': ['status-a', 'status-b'] };
    db.exec(
      `INSERT INTO settings VALUES ('1','autoClean.statusIds','${JSON.stringify(map)}',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().autoClean?.statusIds).toEqual(map);
  });

  it('reads all messagePool fields from storage', () => {
    db.exec(`
      INSERT INTO settings VALUES ('1','messagePool.enabled','true',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','messagePool.delayMs','5000',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('3','messagePool.maxWaitMs','15000',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('4','messagePool.maxMessages','20',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('5','messagePool.separator','"---"',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect(s.messagePool?.enabled).toBe(true);
    expect(s.messagePool?.delayMs).toBe(5000);
    expect(s.messagePool?.maxWaitMs).toBe(15000);
    expect(s.messagePool?.maxMessages).toBe(20);
    expect(s.messagePool?.separator).toBe('---');
  });

  it('reads messagePool.projects JSON from storage', () => {
    const projects = { 'proj-1': { enabled: false, delayMs: 2000 } };
    db.exec(
      `INSERT INTO settings VALUES ('1','messagePool.projects','${JSON.stringify(projects)}',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().messagePool?.projects).toEqual(projects);
  });

  it('reads registry fields from storage', () => {
    db.exec(`
      INSERT INTO settings VALUES ('1','registry.url','"https://example.com"',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','registry.cacheDir','"/tmp/cache"',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('3','registry.checkUpdatesOnStartup','true',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect(s.registry?.url).toBe('https://example.com');
    expect(s.registry?.cacheDir).toBe('/tmp/cache');
    expect(s.registry?.checkUpdatesOnStartup).toBe(true);
  });

  it('reads skills fields from storage', () => {
    db.exec(`
      INSERT INTO settings VALUES ('1','skills.syncOnStartup','false',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','skills.sources','{"openai":false,"anthropic":true}',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect(s.skills?.syncOnStartup).toBe(false);
    expect(s.skills?.sources).toEqual({ openai: false, anthropic: true });
  });

  it('reads initialSessionPromptIds JSON map', () => {
    const map = { 'proj-1': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    db.exec(
      `INSERT INTO settings VALUES ('1','initialSessionPromptIds','${JSON.stringify(map)}',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().initialSessionPromptIds).toEqual(map);
  });

  it('reads projectPresets and projectActivePresets JSON', () => {
    const presets = {
      'proj-1': [{ name: 'P', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] }],
    };
    const actives = { 'proj-1': 'P' };
    db.exec(`
      INSERT INTO settings VALUES ('1','projectPresets','${JSON.stringify(presets)}',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','projectActivePresets','${JSON.stringify(actives)}',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect(s.projectPresets).toEqual(presets);
    expect(s.projectActivePresets).toEqual(actives);
  });

  it('gracefully ignores malformed JSON for JSON-parsed keys', () => {
    db.exec(`
      INSERT INTO settings VALUES ('1','initialSessionPromptIds','not-json',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('2','autoClean.statusIds','{bad',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('3','messagePool.projects','{bad',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('4','registryTemplates','{bad',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('5','projectPresets','{bad',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('6','projectActivePresets','{bad',datetime('now'),datetime('now'));
      INSERT INTO settings VALUES ('7','skills.sources','{bad',datetime('now'),datetime('now'));
    `);
    const s = service.getSettings();
    expect(s.initialSessionPromptIds).toBeUndefined();
    expect(s.autoClean).toBeUndefined();
    expect(s.messagePool?.projects).toBeUndefined();
    expect(s.registryTemplates).toBeUndefined();
    expect(s.projectPresets).toBeUndefined();
    expect(s.projectActivePresets).toBeUndefined();
    expect(s.skills?.sources).toBeUndefined();
  });
});

describe('SettingsService — Characterization: updateSettings() round-trip', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('round-trips all domain settings through a single updateSettings call', async () => {
    await service.updateSettings({
      dbPath: '/data/db.sqlite',
      terminal: {
        scrollbackLines: 5000,
        seedingMaxBytes: 512 * 1024,
        inputMode: 'form',
      },
      activity: { idleTimeoutMs: 45000 },
      autoClean: { statusIds: { 'proj-1': ['s1', 's2'] } },
      messagePool: {
        enabled: false,
        delayMs: 3000,
        maxWaitMs: 15000,
        maxMessages: 5,
        separator: '***',
      },
      registry: {
        url: 'https://custom.example.com',
        cacheDir: '/tmp/cache',
        checkUpdatesOnStartup: false,
      },
      skills: {
        syncOnStartup: false,
        sources: { openai: false },
      },
      events: {
        epicAssigned: { template: 'hello {{agent_name}}' },
      },
    });

    const s = service.getSettings();
    expect(s.dbPath).toBe('/data/db.sqlite');
    expect(s.terminal?.scrollbackLines).toBe(5000);
    expect(s.terminal?.seedingMaxBytes).toBe(512 * 1024);
    expect(s.terminal?.inputMode).toBe('form');
    expect(s.activity?.idleTimeoutMs).toBe(45000);
    expect(s.autoClean?.statusIds?.['proj-1']).toEqual(['s1', 's2']);
    expect(s.messagePool?.enabled).toBe(false);
    expect(s.messagePool?.delayMs).toBe(3000);
    expect(s.messagePool?.maxWaitMs).toBe(15000);
    expect(s.messagePool?.maxMessages).toBe(5);
    expect(s.messagePool?.separator).toBe('***');
    expect(s.registry?.url).toBe('https://custom.example.com');
    expect(s.registry?.cacheDir).toBe('/tmp/cache');
    expect(s.registry?.checkUpdatesOnStartup).toBe(false);
    expect(s.skills?.syncOnStartup).toBe(false);
    expect(s.skills?.sources).toEqual({ openai: false });
    expect(s.events?.epicAssigned?.template).toBe('hello {{agent_name}}');
  });

  it('stores invalid inputMode as default', async () => {
    await service.updateSettings({
      terminal: { inputMode: 'unknown-mode' as 'tty' },
    });
    expect(service.getSettings().terminal?.inputMode).toBe(DEFAULT_TERMINAL_INPUT_MODE);
  });

  it('handles initialSessionPromptId without projectId (global default)', async () => {
    await service.updateSettings({
      initialSessionPromptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const raw = service.getSetting('initialSessionPromptId');
    expect(raw).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

describe('SettingsService — Characterization: getAutoCleanStatusIds()', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('returns empty array when autoClean not configured', () => {
    expect(service.getAutoCleanStatusIds('proj-1')).toEqual([]);
  });

  it('returns empty array for unconfigured project', async () => {
    await service.updateSettings({ autoClean: { statusIds: { 'proj-other': ['s1'] } } });
    expect(service.getAutoCleanStatusIds('proj-1')).toEqual([]);
  });

  it('returns configured status IDs for project', async () => {
    await service.updateSettings({ autoClean: { statusIds: { 'proj-1': ['s1', 's2'] } } });
    expect(service.getAutoCleanStatusIds('proj-1')).toEqual(['s1', 's2']);
  });

  it('handles malformed JSON gracefully', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','autoClean.statusIds','{bad',datetime('now'),datetime('now'))`,
    );
    expect(service.getAutoCleanStatusIds('proj-1')).toEqual([]);
  });
});

describe('SettingsService — Characterization: getProjectSettings() / setProjectSettings()', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('returns empty object for unconfigured project', () => {
    const ps = service.getProjectSettings('proj-1');
    expect(ps).toEqual({});
  });

  it('returns all project-specific settings when configured', async () => {
    await service.updateSettings({
      projectId: 'proj-1',
      initialSessionPromptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    await service.updateSettings({
      autoClean: { statusIds: { 'proj-1': ['s1'] } },
    });
    await service.updateSettings({
      events: { epicAssigned: { template: 'template-text' } },
    });
    await service.setProjectPoolSettings('proj-1', { enabled: false });

    const ps = service.getProjectSettings('proj-1');
    expect(ps.initialSessionPromptId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(ps.autoCleanStatusIds).toEqual(['s1']);
    expect(ps.epicAssignedTemplate).toBe('template-text');
    expect(ps.messagePoolSettings).toEqual({ enabled: false });
  });

  it('sets multiple project settings atomically via setProjectSettings', async () => {
    await service.setProjectSettings('proj-1', {
      initialSessionPromptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      autoCleanStatusIds: ['s1', 's2'],
      epicAssignedTemplate: 'hello',
      messagePoolSettings: { delayMs: 2000 },
    });

    const ps = service.getProjectSettings('proj-1');
    expect(ps.initialSessionPromptId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(ps.autoCleanStatusIds).toEqual(['s1', 's2']);
    expect(ps.epicAssignedTemplate).toBe('hello');
    expect(ps.messagePoolSettings).toEqual({ delayMs: 2000 });
  });

  it('skips updateSettings when no project settings fields provided', async () => {
    const spy = jest.spyOn(service, 'updateSettings');
    await service.setProjectSettings('proj-1', {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('merges autoClean statusIds with existing projects', async () => {
    await service.updateSettings({ autoClean: { statusIds: { 'proj-other': ['x'] } } });
    await service.setProjectSettings('proj-1', { autoCleanStatusIds: ['s1'] });

    expect(service.getAutoCleanStatusIds('proj-other')).toEqual(['x']);
    expect(service.getAutoCleanStatusIds('proj-1')).toEqual(['s1']);
  });
});

describe('SettingsService — Characterization: setProjectPresets() / clearProjectPresets() / getAllProjectPresetsMap()', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('clearProjectPresets does not affect other projects', async () => {
    await service.setProjectPresets('proj-1', [
      { name: 'P1', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] },
    ]);
    await service.setProjectPresets('proj-2', [
      { name: 'P2', agentConfigs: [{ agentName: 'B', providerConfigName: 'D' }] },
    ]);
    await service.clearProjectPresets('proj-1');

    expect(service.getProjectPresets('proj-1')).toEqual([]);
    expect(service.getProjectPresets('proj-2')).toHaveLength(1);
  });

  it('getAllProjectPresetsMap returns all projects with presets', async () => {
    await service.setProjectPresets('proj-1', [
      { name: 'P1', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] },
    ]);
    await service.setProjectPresets('proj-2', [
      { name: 'P2', agentConfigs: [{ agentName: 'B', providerConfigName: 'D' }] },
    ]);

    const map = service.getAllProjectPresetsMap();
    expect(map.size).toBe(2);
    expect(map.get('proj-1')).toHaveLength(1);
    expect(map.get('proj-2')).toHaveLength(1);
  });
});

describe('SettingsService — Characterization: getAllProjectTemplateMetadataMap()', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('returns empty map when no templates tracked', () => {
    const map = service.getAllProjectTemplateMetadataMap();
    expect(map.size).toBe(0);
  });

  it('returns map with all tracked projects', async () => {
    const meta1 = {
      templateSlug: 'a',
      installedVersion: '1.0.0',
      registryUrl: 'https://r.com',
      installedAt: '2024-01-01T00:00:00Z',
    };
    const meta2 = {
      templateSlug: 'b',
      installedVersion: '2.0.0',
      registryUrl: 'https://r.com',
      installedAt: '2024-02-01T00:00:00Z',
    };
    await service.setProjectTemplateMetadata('proj-1', meta1);
    await service.setProjectTemplateMetadata('proj-2', meta2);

    const map = service.getAllProjectTemplateMetadataMap();
    expect(map.size).toBe(2);
    expect(map.get('proj-1')).toEqual(meta1);
    expect(map.get('proj-2')).toEqual(meta2);
  });
});

describe('SettingsService — Characterization: getMessagePoolConfig() defaults', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('returns all default values', () => {
    const cfg = service.getMessagePoolConfig();
    expect(cfg).toEqual({
      enabled: DEFAULT_MESSAGE_POOL_ENABLED,
      delayMs: DEFAULT_MESSAGE_POOL_DELAY_MS,
      maxWaitMs: DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
      maxMessages: DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
      separator: DEFAULT_MESSAGE_POOL_SEPARATOR,
    });
  });
});

describe('SettingsService — Characterization: getMessagePoolConfigForProject()', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('applies project overrides on top of global settings', async () => {
    await service.updateSettings({ messagePool: { delayMs: 5000 } });
    await service.setProjectPoolSettings('proj-1', { enabled: false, maxMessages: 3 });

    const cfg = service.getMessagePoolConfigForProject('proj-1');
    expect(cfg.enabled).toBe(false);
    expect(cfg.delayMs).toBe(5000);
    expect(cfg.maxMessages).toBe(3);
    expect(cfg.maxWaitMs).toBe(DEFAULT_MESSAGE_POOL_MAX_WAIT_MS);
    expect(cfg.separator).toBe(DEFAULT_MESSAGE_POOL_SEPARATOR);
  });
});

// ==========================================================================
// CRITICAL: Cross-delegate atomicity test
// ==========================================================================

describe('SettingsService — CRITICAL: updateSettings() cross-delegate atomicity', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('atomically writes settings across multiple domains in one updateSettings call', async () => {
    await service.updateSettings({
      terminal: { scrollbackLines: 7777 },
      messagePool: { enabled: false, delayMs: 2000 },
      autoClean: { statusIds: { 'proj-1': ['s1'] } },
      skills: { syncOnStartup: false },
    });

    expect(service.getSettings().terminal?.scrollbackLines).toBe(7777);
    expect(service.getSettings().messagePool?.enabled).toBe(false);
    expect(service.getSettings().messagePool?.delayMs).toBe(2000);
    expect(service.getAutoCleanStatusIds('proj-1')).toEqual(['s1']);
    expect(service.getSkillsSyncOnStartup()).toBe(false);
  });

  it('rolls back ALL writes when transaction body throws mid-way', async () => {
    await service.updateSettings({ terminal: { scrollbackLines: 5000 } });
    expect(service.getScrollbackLines()).toBe(5000);

    const originalPrepare = db.prepare.bind(db);
    let callCount = 0;
    jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('INSERT INTO settings')) {
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          callCount++;
          if (callCount >= 3) {
            throw new Error('Simulated mid-transaction failure');
          }
          return originalRun(...args);
        };
      }
      return stmt;
    });

    await expect(
      service.updateSettings({
        terminal: { scrollbackLines: 9999 },
        messagePool: { enabled: false },
        skills: { syncOnStartup: false },
      }),
    ).rejects.toThrow('Simulated mid-transaction failure');

    (db.prepare as jest.Mock).mockRestore();

    expect(service.getScrollbackLines()).toBe(5000);
    expect(service.getSettings().messagePool?.enabled).toBeUndefined();
    expect(service.getSkillsSyncOnStartup()).toBe(DEFAULT_SKILLS_SYNC_ON_STARTUP);
  });
});

// ==========================================================================
// API surface inventory — public methods delegate settings behavior
// ==========================================================================

describe('SettingsService — API surface inventory', () => {
  it('exposes only the inventoried delegate facade methods', () => {
    const db = createTestDb();
    const { service } = createTestService(db);

    const proto = Object.getPrototypeOf(service);
    const allMethods = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor' && typeof proto[name] === 'function',
    );

    const expectedMethods = [
      'getSettings',
      'updateSettings',
      'getSetting',
      'getScrollbackLines',
      'getFollowNoteEnabled',
      'getSkillsSyncOnStartup',
      'getSkillsCompletedSyncs',
      'setSkillCompletedSync',
      'getSkillSourcesEnabled',
      'getStoredSkillSourcesEnabled',
      'getHomePushedSkillSources',
      'setHomePushedSkillSources',
      'mergeSkillSourcesEnabled',
      'setSkillSourceEnabled',
      'getProviderCliVersions',
      'setProviderCliVersion',
      'getAutoCleanStatusIds',
      'getMessagePoolConfig',
      'getMessagePoolConfigForProject',
      'getProjectPoolSettings',
      'setProjectPoolSettings',
      'getProjectSettings',
      'setProjectSettings',
      'getRegistryConfig',
      'setRegistryConfig',
      'getProjectTemplateMetadata',
      'setProjectTemplateMetadata',
      'clearProjectTemplateMetadata',
      'getAllTrackedProjects',
      'getAllProjectTemplateMetadataMap',
      'updateLastUpdateCheck',
      'getProjectPresets',
      'setProjectPresets',
      'clearProjectPresets',
      'getAllProjectPresetsMap',
      'renameProviderConfigInProjectPresets',
      'removeAgentFromProjectPresets',
      'createProjectPreset',
      'updateProjectPreset',
      'deleteProjectPreset',
      'getProjectActivePreset',
      'setProjectActivePreset',
    ];

    for (const method of expectedMethods) {
      expect(allMethods).toContain(method);
    }

    expect(allMethods.length).toBe(expectedMethods.length);
    db.close();
  });
});
