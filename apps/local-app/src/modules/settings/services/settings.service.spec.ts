import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SettingsService,
  DEFAULT_TERMINAL_SCROLLBACK,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  MAX_TERMINAL_SEED_MAX_BYTES,
  MIN_TERMINAL_SEED_MAX_BYTES,
  DEFAULT_TERMINAL_INPUT_MODE,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
  DEFAULT_SKILLS_SYNC_ON_STARTUP,
  DEFAULT_MESSAGE_POOL_ENABLED,
  DEFAULT_MESSAGE_POOL_DELAY_MS,
  DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
  DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
  DEFAULT_MESSAGE_POOL_SEPARATOR,
} from './settings.service';
import { settingsTerminalChangedEvent } from '../../events/catalog';

// Helper to create mock EventEmitter2
function createMockEventEmitter(): EventEmitter2 & { emit: jest.Mock } {
  return {
    emit: jest.fn(),
  } as unknown as EventEmitter2 & { emit: jest.Mock };
}

describe('SettingsService (events templates)', () => {
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

  it('persists and retrieves events.epicAssigned.template', async () => {
    await service.updateSettings({
      events: {
        epicAssigned: {
          template: '[Epic Assignment]\n{epic_title} -> {agent_name}',
        },
      },
    });

    const settings = service.getSettings();
    expect(settings.events?.epicAssigned?.template).toBe(
      '[Epic Assignment]\n{epic_title} -> {agent_name}',
    );

    const raw = service.getSetting('events.epicAssigned.template');
    expect(raw).toBe('[Epic Assignment]\n{epic_title} -> {agent_name}');
  });

  it('returns empty string when template cleared', async () => {
    await service.updateSettings({
      events: {
        epicAssigned: {
          template: null,
        },
      },
    });

    const settings = service.getSettings();
    expect(settings.events?.epicAssigned?.template).toBe('');
  });
});

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

  it('returns terminal defaults when unset', () => {
    const settings = service.getSettings();
    // Note: seedingMode removed from API (tmux-based seeding is implicit)
    expect(settings.terminal?.scrollbackLines).toBe(DEFAULT_TERMINAL_SCROLLBACK);
    expect(settings.terminal?.seedingMaxBytes).toBe(DEFAULT_TERMINAL_SEED_MAX_BYTES);
    expect(settings.terminal?.inputMode).toBe(DEFAULT_TERMINAL_INPUT_MODE);
  });

  it('clamps terminal seeding max bytes when persisted', async () => {
    await service.updateSettings({
      terminal: {
        seedingMaxBytes: MAX_TERMINAL_SEED_MAX_BYTES * 8,
      },
    });

    const settings = service.getSettings();
    expect(settings.terminal?.seedingMaxBytes).toBe(MAX_TERMINAL_SEED_MAX_BYTES);
    const raw = service.getSetting('terminal.seeding.maxBytes');
    expect(raw).toBe(String(MAX_TERMINAL_SEED_MAX_BYTES));
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

  it('returns default when no setting is stored', () => {
    const result = service.getScrollbackLines();
    expect(result).toBe(DEFAULT_TERMINAL_SCROLLBACK);
  });

  it('returns stored value when within valid range', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 5000,
      },
    });

    const result = service.getScrollbackLines();
    expect(result).toBe(5000);
  });

  it('clamps value to MIN_TERMINAL_SCROLLBACK when below minimum', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 10,
      },
    });

    const result = service.getScrollbackLines();
    expect(result).toBe(MIN_TERMINAL_SCROLLBACK);
  });

  it('clamps value to MAX_TERMINAL_SCROLLBACK when above maximum', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 100000,
      },
    });

    const result = service.getScrollbackLines();
    expect(result).toBe(MAX_TERMINAL_SCROLLBACK);
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

  it('returns default registry URL when nothing configured', () => {
    const config = service.getRegistryConfig();
    expect(config.url).toBe('https://a1-devchain.twitechlab.com');
    expect(config.cacheDir).toBe('');
    expect(config.checkUpdatesOnStartup).toBe(true);
  });

  it('uses REGISTRY_URL environment variable as fallback', () => {
    process.env.REGISTRY_URL = 'https://custom-registry.example.com';

    const config = service.getRegistryConfig();
    expect(config.url).toBe('https://custom-registry.example.com');
  });

  it('persists and retrieves custom registry URL', async () => {
    await service.setRegistryConfig({
      url: 'https://my-registry.example.com',
    });

    const config = service.getRegistryConfig();
    expect(config.url).toBe('https://my-registry.example.com');
  });

  it('settings take priority over environment variable', async () => {
    process.env.REGISTRY_URL = 'https://env-registry.example.com';

    await service.setRegistryConfig({
      url: 'https://settings-registry.example.com',
    });

    const config = service.getRegistryConfig();
    expect(config.url).toBe('https://settings-registry.example.com');
  });

  it('persists and retrieves cacheDir', async () => {
    await service.setRegistryConfig({
      cacheDir: '/tmp/registry-cache',
    });

    const config = service.getRegistryConfig();
    expect(config.cacheDir).toBe('/tmp/registry-cache');
  });

  it('persists and retrieves checkUpdatesOnStartup', async () => {
    await service.setRegistryConfig({
      checkUpdatesOnStartup: false,
    });

    const config = service.getRegistryConfig();
    expect(config.checkUpdatesOnStartup).toBe(false);
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

  it('defaults to true when unset', () => {
    expect(service.getSkillsSyncOnStartup()).toBe(DEFAULT_SKILLS_SYNC_ON_STARTUP);
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

  it('persists and reads true', async () => {
    await service.updateSettings({
      skills: {
        syncOnStartup: true,
      },
    });

    expect(service.getSkillsSyncOnStartup()).toBe(true);
    expect(service.getSetting('skills.syncOnStartup')).toBe('true');
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

  it('returns empty source map when unset', () => {
    expect(service.getSkillSourcesEnabled()).toEqual({});
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

  it('returns null for untracked project', () => {
    const metadata = service.getProjectTemplateMetadata('unknown-project');
    expect(metadata).toBeNull();
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

  it('clears template metadata for a project', async () => {
    const metadata = {
      templateSlug: 'template-to-remove',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };

    await service.setProjectTemplateMetadata('proj-to-clear', metadata);
    expect(service.getProjectTemplateMetadata('proj-to-clear')).not.toBeNull();

    await service.clearProjectTemplateMetadata('proj-to-clear');
    expect(service.getProjectTemplateMetadata('proj-to-clear')).toBeNull();
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

  it('does nothing when updating lastUpdateCheckAt for untracked project', async () => {
    // Should not throw and should not create metadata
    await service.updateLastUpdateCheck('untracked-project');
    expect(service.getProjectTemplateMetadata('untracked-project')).toBeNull();
  });

  it('overwrites existing metadata when setting for same project', async () => {
    const metadata1 = {
      templateSlug: 'old-template',
      installedVersion: '1.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-15T12:00:00Z',
    };
    const metadata2 = {
      templateSlug: 'new-template',
      installedVersion: '2.0.0',
      registryUrl: 'https://registry.example.com',
      installedAt: '2024-01-16T12:00:00Z',
    };

    await service.setProjectTemplateMetadata('proj-overwrite', metadata1);
    await service.setProjectTemplateMetadata('proj-overwrite', metadata2);

    const retrieved = service.getProjectTemplateMetadata('proj-overwrite');
    expect(retrieved).toEqual(metadata2);
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

  it('emits event with clamped value when scrollbackLines exceeds max', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 100000, // Exceeds MAX_TERMINAL_SCROLLBACK (50000)
      },
    });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith('settings.terminal.changed', {
      scrollbackLines: 50000, // Clamped to max
    });
  });

  it('emits event with clamped value when scrollbackLines below min', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 10, // Below MIN_TERMINAL_SCROLLBACK (100)
      },
    });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith('settings.terminal.changed', {
      scrollbackLines: 100, // Clamped to min
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

  it('does not emit event when non-terminal settings are updated', async () => {
    await service.updateSettings({
      dbPath: '/tmp/test.db',
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

  it('validates event payload using catalog schema before emit', async () => {
    // Verify the schema expects a positive integer
    expect(() =>
      settingsTerminalChangedEvent.schema.parse({ scrollbackLines: 5000 }),
    ).not.toThrow();
    expect(() => settingsTerminalChangedEvent.schema.parse({ scrollbackLines: -1 })).toThrow();
    expect(() => settingsTerminalChangedEvent.schema.parse({ scrollbackLines: 3.14 })).toThrow();
    expect(() => settingsTerminalChangedEvent.schema.parse({})).toThrow();

    // Now test that SettingsService uses this schema
    await service.updateSettings({
      terminal: {
        scrollbackLines: 5000,
      },
    });

    // Since clamped value is always a valid positive integer, emit should succeed
    expect(mockEventEmitter.emit).toHaveBeenCalledWith('settings.terminal.changed', {
      scrollbackLines: 5000,
    });
  });

  it('emits payload that conforms to the event catalog schema', async () => {
    await service.updateSettings({
      terminal: {
        scrollbackLines: 2500,
      },
    });

    expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockEventEmitter.emit.mock.calls[0];

    expect(eventName).toBe('settings.terminal.changed');
    // Validate the actual emitted payload matches the schema
    expect(() => settingsTerminalChangedEvent.schema.parse(payload)).not.toThrow();
    expect(payload).toEqual({ scrollbackLines: 2500 });
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

  it('returns defaults for global message pool config', () => {
    const config = service.getMessagePoolConfig();
    expect(config.enabled).toBe(true);
    expect(config.delayMs).toBe(10000);
    expect(config.maxWaitMs).toBe(30000);
    expect(config.maxMessages).toBe(10);
    expect(config.separator).toBe('\n---\n');
  });

  it('returns undefined for unconfigured project pool settings', () => {
    const settings = service.getProjectPoolSettings('unconfigured-project');
    expect(settings).toBeUndefined();
  });

  it('stores and retrieves project-specific pool settings', async () => {
    await service.setProjectPoolSettings('proj-pool', {
      enabled: false,
      delayMs: 5000,
      maxMessages: 5,
    });

    const settings = service.getProjectPoolSettings('proj-pool');
    expect(settings).toEqual({
      enabled: false,
      delayMs: 5000,
      maxMessages: 5,
    });
  });

  it('applies project overrides on top of global config', async () => {
    await service.setProjectPoolSettings('proj-override', {
      enabled: false,
      delayMs: 2000,
    });

    const config = service.getMessagePoolConfigForProject('proj-override');
    expect(config.enabled).toBe(false);
    expect(config.delayMs).toBe(2000);
    // Should use global defaults for non-overridden values
    expect(config.maxWaitMs).toBe(30000);
    expect(config.maxMessages).toBe(10);
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

    it('accepts agentConfig modelOverride as string', async () => {
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        agentConfigs: [
          {
            agentName: 'Agent1',
            providerConfigName: 'Config1',
            modelOverride: 'openai/gpt-5',
          },
        ],
      });

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].agentConfigs[0]).toEqual({
        agentName: 'Agent1',
        providerConfigName: 'Config1',
        modelOverride: 'openai/gpt-5',
      });
    });

    it('accepts agentConfig modelOverride as null', async () => {
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        agentConfigs: [
          {
            agentName: 'Agent1',
            providerConfigName: 'Config1',
            modelOverride: null,
          },
        ],
      });

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].agentConfigs[0]).toEqual({
        agentName: 'Agent1',
        providerConfigName: 'Config1',
        modelOverride: null,
      });
    });

    it('throws ValidationError for duplicate name (case-insensitive)', async () => {
      await service.createProjectPreset('proj-1', validPreset);

      await expect(
        service.createProjectPreset('proj-1', { ...validPreset, name: 'my preset' }),
      ).rejects.toThrow('already exists (case-insensitive)');

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
    });

    it('throws ValidationError for empty name after trimming', async () => {
      await expect(
        service.createProjectPreset('proj-1', { ...validPreset, name: '   ' }),
      ).rejects.toThrow('cannot be empty or whitespace only');
    });

    it('throws ValidationError for invalid preset schema', async () => {
      await expect(
        service.createProjectPreset('proj-1', { name: '', agentConfigs: 'invalid' }),
      ).rejects.toThrow('Invalid preset data');
    });

    it('trims whitespace from preset name', async () => {
      await service.createProjectPreset('proj-1', { ...validPreset, name: '  My Preset  ' });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].name).toBe('My Preset');
    });

    it('allows same name in different projects', async () => {
      await service.createProjectPreset('proj-1', validPreset);
      await service.createProjectPreset('proj-2', validPreset);

      expect(service.getProjectPresets('proj-1')).toHaveLength(1);
      expect(service.getProjectPresets('proj-2')).toHaveLength(1);
    });

    it('allows multiple presets with different names in same project', async () => {
      await service.createProjectPreset('proj-1', validPreset);
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        name: 'Another Preset',
      });

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(2);
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

    it('updates preset description', async () => {
      await service.updateProjectPreset('proj-1', 'My Preset', {
        description: 'New description',
      });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].description).toBe('New description');
    });

    it('updates agent configs', async () => {
      const newConfigs = [{ agentName: 'Agent3', providerConfigName: 'Config3' }];
      await service.updateProjectPreset('proj-1', 'My Preset', { agentConfigs: newConfigs });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].agentConfigs).toEqual(newConfigs);
    });

    it('matches preset name case-insensitively', async () => {
      await service.updateProjectPreset('proj-1', 'my preset', { name: 'Updated Name' });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].name).toBe('Updated Name');
    });

    it('throws ValidationError if preset not found', async () => {
      await expect(
        service.updateProjectPreset('proj-1', 'Nonexistent', { name: 'New Name' }),
      ).rejects.toThrow('Preset "Nonexistent" not found');
    });

    it('throws ValidationError for name conflict (case-insensitive)', async () => {
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        name: 'Another Preset',
      });

      await expect(
        service.updateProjectPreset('proj-1', 'My Preset', { name: 'another preset' }),
      ).rejects.toThrow('already exists (case-insensitive)');
    });

    it('throws ValidationError for invalid schema', async () => {
      await expect(
        service.updateProjectPreset('proj-1', 'My Preset', { agentConfigs: 'invalid' }),
      ).rejects.toThrow('Invalid preset update');
    });

    it('trims whitespace from updated name', async () => {
      await service.updateProjectPreset('proj-1', 'My Preset', { name: '  New Name  ' });

      const presets = service.getProjectPresets('proj-1');
      expect(presets[0].name).toBe('New Name');
    });

    it('migrates activePreset when preset name is changed', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');

      expect(service.getProjectActivePreset('proj-1')).toBe('My Preset');

      await service.updateProjectPreset('proj-1', 'My Preset', { name: 'Renamed Preset' });

      expect(service.getProjectActivePreset('proj-1')).toBe('Renamed Preset');
    });

    it('does not affect activePreset when name is not changed', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');

      await service.updateProjectPreset('proj-1', 'My Preset', { description: 'New description' });

      expect(service.getProjectActivePreset('proj-1')).toBe('My Preset');
    });

    it('does not affect activePreset when renaming a different preset', async () => {
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        name: 'Another Preset',
      });
      await service.setProjectActivePreset('proj-1', 'My Preset');

      await service.updateProjectPreset('proj-1', 'Another Preset', { name: 'Renamed Another' });

      expect(service.getProjectActivePreset('proj-1')).toBe('My Preset');
    });

    it('does not set activePreset when renaming non-active preset', async () => {
      await service.createProjectPreset('proj-1', {
        ...validPreset,
        name: 'Another Preset',
      });
      // No active preset is set

      await service.updateProjectPreset('proj-1', 'Another Preset', { name: 'Renamed Another' });

      expect(service.getProjectActivePreset('proj-1')).toBeNull();
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

    it('migrates activePreset when renaming to different case (regression)', async () => {
      // Set active preset with original casing
      await service.setProjectActivePreset('proj-1', 'My Preset');

      // Rename preset to lowercase (active preset should be updated)
      await service.updateProjectPreset('proj-1', 'My Preset', { name: 'mypreset' });

      // Active preset should be updated to the new canonical name
      expect(service.getProjectActivePreset('proj-1')).toBe('mypreset');
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

    it('matches preset name case-insensitively', async () => {
      await service.deleteProjectPreset('proj-1', 'my preset');

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('Another Preset');
    });

    it('throws ValidationError if preset not found', async () => {
      await expect(service.deleteProjectPreset('proj-1', 'Nonexistent')).rejects.toThrow(
        'Preset "Nonexistent" not found',
      );
    });

    it('trims whitespace from search name', async () => {
      await service.deleteProjectPreset('proj-1', '  My Preset  ');

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
    });

    it('clears all presets when last one deleted', async () => {
      await service.deleteProjectPreset('proj-1', 'My Preset');
      await service.deleteProjectPreset('proj-1', 'Another Preset');

      const presets = service.getProjectPresets('proj-1');
      expect(presets).toHaveLength(0);
    });

    it('clears activePreset when the active preset is deleted', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');

      expect(service.getProjectActivePreset('proj-1')).toBe('My Preset');

      await service.deleteProjectPreset('proj-1', 'My Preset');

      expect(service.getProjectActivePreset('proj-1')).toBeNull();
    });

    it('does not clear activePreset when a different preset is deleted', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');

      await service.deleteProjectPreset('proj-1', 'Another Preset');

      expect(service.getProjectActivePreset('proj-1')).toBe('My Preset');
    });

    it('does not error when deleting preset with no active preset set', async () => {
      // No active preset set

      await expect(service.deleteProjectPreset('proj-1', 'My Preset')).resolves.not.toThrow();
    });

    it('clears activePreset when deleted preset name differs only in case (regression)', async () => {
      // Set active preset with different casing than stored preset name
      await service.setProjectActivePreset('proj-1', 'my preset'); // lowercase

      // Verify active preset is set
      expect(service.getProjectActivePreset('proj-1')).toBe('my preset');

      // Delete preset using original casing
      await service.deleteProjectPreset('proj-1', 'My Preset'); // title case

      // Active preset should be cleared (case-insensitive comparison)
      expect(service.getProjectActivePreset('proj-1')).toBeNull();
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
    it('returns null for project with no active preset', () => {
      const activePreset = service.getProjectActivePreset('untracked-project');
      expect(activePreset).toBeNull();
    });

    it('returns null when projectActivePresets is not set', () => {
      const activePreset = service.getProjectActivePreset('any-project');
      expect(activePreset).toBeNull();
    });

    it('returns the active preset name for a project', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');

      const activePreset = service.getProjectActivePreset('proj-1');
      expect(activePreset).toBe('My Preset');
    });

    it('returns null for a project that had its active preset cleared', async () => {
      await service.setProjectActivePreset('proj-1', 'My Preset');
      expect(service.getProjectActivePreset('proj-1')).toBe('My Preset');

      await service.setProjectActivePreset('proj-1', null);
      expect(service.getProjectActivePreset('proj-1')).toBeNull();
    });
  });

  describe('setProjectActivePreset', () => {
    it('sets the active preset for a project', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');

      const settings = service.getSettings();
      expect(settings.projectActivePresets?.['proj-1']).toBe('Preset A');
    });

    it('stores multiple project active presets independently', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');
      await service.setProjectActivePreset('proj-2', 'Preset B');

      expect(service.getProjectActivePreset('proj-1')).toBe('Preset A');
      expect(service.getProjectActivePreset('proj-2')).toBe('Preset B');
    });

    it('clears the active preset when passed null', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');
      expect(service.getProjectActivePreset('proj-1')).toBe('Preset A');

      await service.setProjectActivePreset('proj-1', null);

      const settings = service.getSettings();
      expect(settings.projectActivePresets?.['proj-1']).toBeUndefined();
      expect(service.getProjectActivePreset('proj-1')).toBeNull();
    });

    it('updates the active preset for an existing project', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');
      expect(service.getProjectActivePreset('proj-1')).toBe('Preset A');

      await service.setProjectActivePreset('proj-1', 'Preset B');

      expect(service.getProjectActivePreset('proj-1')).toBe('Preset B');
    });

    it('does not affect other projects when clearing one', async () => {
      await service.setProjectActivePreset('proj-1', 'Preset A');
      await service.setProjectActivePreset('proj-2', 'Preset B');

      await service.setProjectActivePreset('proj-1', null);

      expect(service.getProjectActivePreset('proj-1')).toBeNull();
      expect(service.getProjectActivePreset('proj-2')).toBe('Preset B');
    });

    it('persists and retrieves through getSettings cycle', async () => {
      await service.setProjectActivePreset('proj-1', 'Test Preset');

      const settings = service.getSettings();
      expect(settings.projectActivePresets?.['proj-1']).toBe('Test Preset');
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
    });
  });

  it('reads claudeBinaryPath from storage', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','claudeBinaryPath','/usr/bin/claude',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().claudeBinaryPath).toBe('/usr/bin/claude');
  });

  it('reads codexBinaryPath from storage', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','codexBinaryPath','/usr/bin/codex',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().codexBinaryPath).toBe('/usr/bin/codex');
  });

  it('reads dbPath from storage', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','dbPath','/data/devchain.db',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().dbPath).toBe('/data/devchain.db');
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

  it('clamps terminal.scrollbackLines to valid range on read', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','terminal.scrollback.lines','1',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().terminal?.scrollbackLines).toBe(MIN_TERMINAL_SCROLLBACK);

    db.exec(`UPDATE settings SET value = '999999' WHERE key = 'terminal.scrollback.lines'`);
    expect(service.getSettings().terminal?.scrollbackLines).toBe(MAX_TERMINAL_SCROLLBACK);
  });

  it('clamps terminal.seedingMaxBytes to valid range on read', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','terminal.seeding.maxBytes','1',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().terminal?.seedingMaxBytes).toBe(MIN_TERMINAL_SEED_MAX_BYTES);

    db.exec(`UPDATE settings SET value = '999999999' WHERE key = 'terminal.seeding.maxBytes'`);
    expect(service.getSettings().terminal?.seedingMaxBytes).toBe(MAX_TERMINAL_SEED_MAX_BYTES);
  });

  it('ignores unknown terminal.inputMode values', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','terminal.inputMode','unknown',datetime('now'),datetime('now'))`,
    );
    expect(service.getSettings().terminal?.inputMode).toBe(DEFAULT_TERMINAL_INPUT_MODE);
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

  it('clamps activity.idleTimeoutMs to [1000, 86400000]', async () => {
    await service.updateSettings({ activity: { idleTimeoutMs: 500 } });
    expect(service.getSettings().activity?.idleTimeoutMs).toBe(1000);

    await service.updateSettings({ activity: { idleTimeoutMs: 100_000_000 } });
    expect(service.getSettings().activity?.idleTimeoutMs).toBe(86400000);
  });

  it('stores invalid inputMode as default', async () => {
    await service.updateSettings({
      terminal: { inputMode: 'unknown-mode' as 'tty' },
    });
    expect(service.getSettings().terminal?.inputMode).toBe(DEFAULT_TERMINAL_INPUT_MODE);
  });

  it('handles initialSessionPromptId with projectId (per-project mapping)', async () => {
    await service.updateSettings({
      projectId: 'proj-1',
      initialSessionPromptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const s = service.getSettings();
    expect(s.initialSessionPromptIds?.['proj-1']).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('handles initialSessionPromptId without projectId (global default)', async () => {
    await service.updateSettings({
      initialSessionPromptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const raw = service.getSetting('initialSessionPromptId');
    expect(raw).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('returns updated settings after updateSettings', async () => {
    const result = await service.updateSettings({ dbPath: '/test.db' });
    expect(result.dbPath).toBe('/test.db');
    expect(result.terminal?.scrollbackLines).toBe(DEFAULT_TERMINAL_SCROLLBACK);
  });
});

describe('SettingsService — Characterization: getSetting()', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('returns undefined for key not in DB', () => {
    expect(service.getSetting('nonexistent.key')).toBeUndefined();
  });

  it('returns raw value for non-JSON value', () => {
    db.exec(`INSERT INTO settings VALUES ('1','mykey','rawvalue',datetime('now'),datetime('now'))`);
    expect(service.getSetting('mykey')).toBe('rawvalue');
  });

  it('decodes JSON-encoded string value', () => {
    db.exec(
      `INSERT INTO settings VALUES ('1','mykey','"decoded"',datetime('now'),datetime('now'))`,
    );
    expect(service.getSetting('mykey')).toBe('decoded');
  });

  it('returns empty string for empty value', () => {
    db.exec(`INSERT INTO settings VALUES ('1','mykey','',datetime('now'),datetime('now'))`);
    expect(service.getSetting('mykey')).toBe('');
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

  it('setProjectPresets stores validated presets', async () => {
    await service.setProjectPresets('proj-1', [
      { name: 'P1', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] },
    ]);
    const presets = service.getProjectPresets('proj-1');
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('P1');
  });

  it('setProjectPresets throws ValidationError for invalid preset data', async () => {
    await expect(
      service.setProjectPresets('proj-1', [{ name: '', agentConfigs: [] }]),
    ).rejects.toThrow('Invalid preset data');
  });

  it('setProjectPresets overwrites existing presets for same project', async () => {
    await service.setProjectPresets('proj-1', [
      { name: 'Old', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] },
    ]);
    await service.setProjectPresets('proj-1', [
      { name: 'New', agentConfigs: [{ agentName: 'B', providerConfigName: 'D' }] },
    ]);
    const presets = service.getProjectPresets('proj-1');
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('New');
  });

  it('clearProjectPresets removes presets for project', async () => {
    await service.setProjectPresets('proj-1', [
      { name: 'P', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] },
    ]);
    await service.clearProjectPresets('proj-1');
    expect(service.getProjectPresets('proj-1')).toEqual([]);
  });

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

  it('getAllProjectPresetsMap returns empty map when no presets', () => {
    const map = service.getAllProjectPresetsMap();
    expect(map.size).toBe(0);
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

describe('SettingsService — Characterization: getProjectPresets() validation on read', () => {
  let db: Database.Database;
  let service: SettingsService;

  beforeEach(() => {
    db = createTestDb();
    ({ service } = createTestService(db));
  });
  afterEach(() => db.close());

  it('filters out invalid presets on read', () => {
    const presets = {
      'proj-1': [
        { name: 'Valid', agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }] },
        { name: '', agentConfigs: [] },
      ],
    };
    db.exec(
      `INSERT INTO settings VALUES ('1','projectPresets','${JSON.stringify(presets)}',datetime('now'),datetime('now'))`,
    );

    const result = service.getProjectPresets('proj-1');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Valid');
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

  it('merges stored values over defaults', async () => {
    await service.updateSettings({
      messagePool: { enabled: false, delayMs: 2000 },
    });
    const cfg = service.getMessagePoolConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.delayMs).toBe(2000);
    expect(cfg.maxWaitMs).toBe(DEFAULT_MESSAGE_POOL_MAX_WAIT_MS);
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

  it('falls back to global config when project has no overrides', () => {
    const cfg = service.getMessagePoolConfigForProject('proj-1');
    expect(cfg).toEqual({
      enabled: DEFAULT_MESSAGE_POOL_ENABLED,
      delayMs: DEFAULT_MESSAGE_POOL_DELAY_MS,
      maxWaitMs: DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
      maxMessages: DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
      separator: DEFAULT_MESSAGE_POOL_SEPARATOR,
    });
  });

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

  it('preset rename + active-preset migration are atomic', async () => {
    await service.createProjectPreset('proj-1', {
      name: 'Original',
      agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }],
    });
    await service.setProjectActivePreset('proj-1', 'Original');

    await service.updateProjectPreset('proj-1', 'Original', { name: 'Renamed' });

    const presets = service.getProjectPresets('proj-1');
    const active = service.getProjectActivePreset('proj-1');
    expect(presets[0].name).toBe('Renamed');
    expect(active).toBe('Renamed');
  });

  it('preset delete + active-preset cascade are atomic', async () => {
    await service.createProjectPreset('proj-1', {
      name: 'ToDelete',
      agentConfigs: [{ agentName: 'A', providerConfigName: 'C' }],
    });
    await service.setProjectActivePreset('proj-1', 'ToDelete');

    await service.deleteProjectPreset('proj-1', 'ToDelete');

    expect(service.getProjectPresets('proj-1')).toHaveLength(0);
    expect(service.getProjectActivePreset('proj-1')).toBeNull();
  });

  it('multi-domain setProjectSettings writes are committed together', async () => {
    await service.setProjectSettings('proj-1', {
      initialSessionPromptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      autoCleanStatusIds: ['s1', 's2'],
      epicAssignedTemplate: 'tmpl',
      messagePoolSettings: { delayMs: 4000 },
    });

    const ps = service.getProjectSettings('proj-1');
    expect(ps.initialSessionPromptId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(ps.autoCleanStatusIds).toEqual(['s1', 's2']);
    expect(ps.epicAssignedTemplate).toBe('tmpl');
    expect(ps.messagePoolSettings?.delayMs).toBe(4000);
  });
});

// ==========================================================================
// API surface inventory — 32 public methods (thin facade after 4B.6)
// ==========================================================================

describe('SettingsService — API surface inventory', () => {
  it('has exactly 32 public methods on prototype (no private methods — all logic in delegates)', () => {
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
      'getSkillsSyncOnStartup',
      'getSkillSourcesEnabled',
      'setSkillSourceEnabled',
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
