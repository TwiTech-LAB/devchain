import Database from 'better-sqlite3';
import { PresetSettingsDelegate } from './preset-settings.delegate';
import { ValidationError } from '../../../../common/errors/error-types';

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

function createDelegate(db: Database.Database): PresetSettingsDelegate {
  return new PresetSettingsDelegate({ sqlite: db });
}

const validPreset = {
  name: 'Test Preset',
  agentConfigs: [{ agentName: 'Agent1', providerConfigName: 'Config1' }],
};

const validPreset2 = {
  name: 'Another Preset',
  agentConfigs: [{ agentName: 'Agent2', providerConfigName: 'Config2' }],
};

describe('PresetSettingsDelegate', () => {
  let db: Database.Database;
  let delegate: PresetSettingsDelegate;

  beforeEach(() => {
    db = createTestDb();
    delegate = createDelegate(db);
  });
  afterEach(() => db.close());

  describe('Invariant: name uniqueness (case-insensitive)', () => {
    it('rejects creating a preset with a name that differs only in case', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);

      await expect(
        delegate.createProjectPreset('proj-1', { ...validPreset, name: 'test preset' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        delegate.createProjectPreset('proj-1', { ...validPreset, name: 'TEST PRESET' }),
      ).rejects.toThrow(ValidationError);
    });

    it('allows same name in different projects', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.createProjectPreset('proj-2', validPreset);

      expect(delegate.getProjectPresets('proj-1')).toHaveLength(1);
      expect(delegate.getProjectPresets('proj-2')).toHaveLength(1);
    });

    it('rejects renaming to a name that differs only in case from existing', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.createProjectPreset('proj-1', validPreset2);

      await expect(
        delegate.updateProjectPreset('proj-1', 'Another Preset', { name: 'test preset' }),
      ).rejects.toThrow(ValidationError);
    });

    it('allows renaming to the same name with different case (self-rename)', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);

      await delegate.updateProjectPreset('proj-1', 'Test Preset', { name: 'TEST PRESET' });

      const presets = delegate.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('TEST PRESET');
    });

    it('trims and validates preset name on create', async () => {
      await expect(
        delegate.createProjectPreset('proj-1', { ...validPreset, name: '  ' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        delegate.createProjectPreset('proj-1', { ...validPreset, name: '' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Invariant: rename updates active preset atomically', () => {
    it('migrates activePreset when the active preset is renamed', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.setProjectActivePreset('proj-1', 'Test Preset');

      await delegate.updateProjectPreset('proj-1', 'Test Preset', { name: 'Renamed Preset' });

      expect(delegate.getProjectActivePreset('proj-1')).toBe('Renamed Preset');
      const presets = delegate.getProjectPresets('proj-1');
      expect(presets.find((p) => p.name === 'Renamed Preset')).toBeDefined();
      expect(presets.find((p) => p.name === 'Test Preset')).toBeUndefined();
    });

    it('does not change activePreset when a non-active preset is renamed', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.createProjectPreset('proj-1', validPreset2);
      await delegate.setProjectActivePreset('proj-1', 'Test Preset');

      await delegate.updateProjectPreset('proj-1', 'Another Preset', {
        name: 'Renamed Other',
      });

      expect(delegate.getProjectActivePreset('proj-1')).toBe('Test Preset');
    });

    it('renames active preset case-insensitively', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.setProjectActivePreset('proj-1', 'TEST PRESET');

      await delegate.updateProjectPreset('proj-1', 'test preset', { name: 'New Name' });

      expect(delegate.getProjectActivePreset('proj-1')).toBe('New Name');
    });

    it('preset rename + active migration are atomic (rollback on failure)', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.setProjectActivePreset('proj-1', 'Test Preset');

      const originalPrepare = db.prepare.bind(db);
      let callCount = 0;
      const spy = jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO settings')) {
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args: unknown[]) => {
            callCount++;
            if (callCount >= 2) {
              throw new Error('Simulated failure');
            }
            return originalRun(...args);
          };
        }
        return stmt;
      });

      await expect(
        delegate.updateProjectPreset('proj-1', 'Test Preset', { name: 'Renamed' }),
      ).rejects.toThrow('Simulated failure');

      spy.mockRestore();

      expect(delegate.getProjectPresets('proj-1')[0].name).toBe('Test Preset');
      expect(delegate.getProjectActivePreset('proj-1')).toBe('Test Preset');
    });
  });

  describe('Invariant: delete cascades on active preset', () => {
    it('clears activePreset when the active preset is deleted', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.setProjectActivePreset('proj-1', 'Test Preset');

      await delegate.deleteProjectPreset('proj-1', 'Test Preset');

      expect(delegate.getProjectPresets('proj-1')).toHaveLength(0);
      expect(delegate.getProjectActivePreset('proj-1')).toBeNull();
    });

    it('does not clear activePreset when a non-active preset is deleted', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.createProjectPreset('proj-1', validPreset2);
      await delegate.setProjectActivePreset('proj-1', 'Test Preset');

      await delegate.deleteProjectPreset('proj-1', 'Another Preset');

      expect(delegate.getProjectPresets('proj-1')).toHaveLength(1);
      expect(delegate.getProjectActivePreset('proj-1')).toBe('Test Preset');
    });

    it('delete + active cascade are case-insensitive', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.setProjectActivePreset('proj-1', 'test preset');

      await delegate.deleteProjectPreset('proj-1', 'TEST PRESET');

      expect(delegate.getProjectActivePreset('proj-1')).toBeNull();
    });

    it('preset delete + active cascade are atomic (rollback on failure)', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.setProjectActivePreset('proj-1', 'Test Preset');

      const originalPrepare = db.prepare.bind(db);
      let callCount = 0;
      const spy = jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO settings')) {
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args: unknown[]) => {
            callCount++;
            if (callCount >= 2) {
              throw new Error('Simulated failure');
            }
            return originalRun(...args);
          };
        }
        return stmt;
      });

      await expect(delegate.deleteProjectPreset('proj-1', 'Test Preset')).rejects.toThrow(
        'Simulated failure',
      );

      spy.mockRestore();

      expect(delegate.getProjectPresets('proj-1')).toHaveLength(1);
      expect(delegate.getProjectActivePreset('proj-1')).toBe('Test Preset');
    });
  });

  describe('Invariant: schema validation', () => {
    it('rejects create with invalid preset (missing name)', async () => {
      await expect(
        delegate.createProjectPreset('proj-1', { name: '', agentConfigs: [] }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects create with invalid preset (missing agentConfigs)', async () => {
      await expect(delegate.createProjectPreset('proj-1', { name: 'Test' })).rejects.toThrow(
        ValidationError,
      );
    });

    it('rejects update with invalid name type', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);

      await expect(
        delegate.updateProjectPreset('proj-1', 'Test Preset', { name: 123 }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects update with invalid agentConfigs type', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);

      await expect(
        delegate.updateProjectPreset('proj-1', 'Test Preset', { agentConfigs: 'not-array' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects update producing invalid merged preset', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);

      await expect(
        delegate.updateProjectPreset('proj-1', 'Test Preset', {
          agentConfigs: [{ agentName: '', providerConfigName: '' }],
        }),
      ).rejects.toThrow(ValidationError);
    });

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

      const result = delegate.getProjectPresets('proj-1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Valid');
    });

    it('rejects setProjectPresets with invalid data', async () => {
      await expect(
        delegate.setProjectPresets('proj-1', [{ name: '', agentConfigs: [] }]),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Basic CRUD operations', () => {
    it('getProjectPresets returns empty array for unconfigured project', () => {
      expect(delegate.getProjectPresets('proj-1')).toEqual([]);
    });

    it('setProjectPresets stores validated presets', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);
      const presets = delegate.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('Test Preset');
    });

    it('setProjectPresets overwrites existing presets', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);
      await delegate.setProjectPresets('proj-1', [validPreset2]);
      expect(delegate.getProjectPresets('proj-1')).toHaveLength(1);
      expect(delegate.getProjectPresets('proj-1')[0].name).toBe('Another Preset');
    });

    it('clearProjectPresets removes presets for project', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);
      await delegate.clearProjectPresets('proj-1');
      expect(delegate.getProjectPresets('proj-1')).toEqual([]);
    });

    it('clearProjectPresets does not affect other projects', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);
      await delegate.setProjectPresets('proj-2', [validPreset2]);
      await delegate.clearProjectPresets('proj-1');

      expect(delegate.getProjectPresets('proj-1')).toEqual([]);
      expect(delegate.getProjectPresets('proj-2')).toHaveLength(1);
    });

    it('getAllProjectPresetsMap returns all projects with presets', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);
      await delegate.setProjectPresets('proj-2', [validPreset2]);

      const map = delegate.getAllProjectPresetsMap();
      expect(map.size).toBe(2);
      expect(map.get('proj-1')).toHaveLength(1);
      expect(map.get('proj-2')).toHaveLength(1);
    });

    it('getAllProjectPresetsMap returns empty map when no presets', () => {
      const map = delegate.getAllProjectPresetsMap();
      expect(map.size).toBe(0);
    });

    it('getProjectActivePreset returns null when not set', () => {
      expect(delegate.getProjectActivePreset('proj-1')).toBeNull();
    });

    it('setProjectActivePreset sets and clears active preset', async () => {
      await delegate.setProjectActivePreset('proj-1', 'Test');
      expect(delegate.getProjectActivePreset('proj-1')).toBe('Test');

      await delegate.setProjectActivePreset('proj-1', null);
      expect(delegate.getProjectActivePreset('proj-1')).toBeNull();
    });

    it('deleteProjectPreset throws for non-existent preset', async () => {
      await expect(delegate.deleteProjectPreset('proj-1', 'NotThere')).rejects.toThrow(
        ValidationError,
      );
    });

    it('updateProjectPreset throws for non-existent preset', async () => {
      await expect(
        delegate.updateProjectPreset('proj-1', 'NotThere', { name: 'New' }),
      ).rejects.toThrow(ValidationError);
    });

    it('delete matches name case-insensitively', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.deleteProjectPreset('proj-1', 'test preset');
      expect(delegate.getProjectPresets('proj-1')).toHaveLength(0);
    });

    it('update matches name case-insensitively', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.updateProjectPreset('proj-1', 'test preset', { description: 'updated' });

      const presets = delegate.getProjectPresets('proj-1');
      expect(presets[0].description).toBe('updated');
    });
  });

  describe('renameProviderConfigInProjectPresets', () => {
    it('renames only matching provider config references for agents mapped to the target profile', async () => {
      await delegate.setProjectPresets('proj-1', [
        {
          name: 'Preset A',
          description: 'kept',
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: ' Old Config ',
              modelOverride: 'openai/gpt-5',
            },
            { agentName: 'Reviewer', providerConfigName: 'Old Config', modelOverride: null },
            { agentName: 'Other', providerConfigName: 'Different Config' },
          ],
        },
        {
          name: 'Preset B',
          agentConfigs: [{ agentName: 'coder', providerConfigName: 'OLD CONFIG' }],
        },
      ]);
      await delegate.setProjectPresets('proj-2', [validPreset2]);
      await delegate.setProjectActivePreset('proj-1', 'Preset A');

      await delegate.renameProviderConfigInProjectPresets('proj-1', {
        profileId: 'profile-target',
        oldName: 'old config',
        newName: 'New Config',
        agents: [
          { name: ' coder ', profileId: 'profile-target' },
          { name: 'Reviewer', profileId: 'profile-other' },
        ],
      });

      expect(delegate.getProjectPresets('proj-1')).toEqual([
        {
          name: 'Preset A',
          description: 'kept',
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: 'New Config',
              modelOverride: 'openai/gpt-5',
            },
            { agentName: 'Reviewer', providerConfigName: 'Old Config', modelOverride: null },
            { agentName: 'Other', providerConfigName: 'Different Config' },
          ],
        },
        {
          name: 'Preset B',
          agentConfigs: [{ agentName: 'coder', providerConfigName: 'New Config' }],
        },
      ]);
      expect(delegate.getProjectPresets('proj-2')).toEqual([validPreset2]);
      expect(delegate.getProjectActivePreset('proj-1')).toBe('Preset A');
    });

    it('updates casing-only renames in stored preset export values', async () => {
      await delegate.setProjectPresets('proj-1', [
        {
          name: 'Preset A',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'Config Alpha' }],
        },
      ]);

      await delegate.renameProviderConfigInProjectPresets('proj-1', {
        profileId: 'profile-target',
        oldName: 'Config Alpha',
        newName: 'config alpha',
        agents: [{ name: 'Coder', profileId: 'profile-target' }],
      });

      expect(delegate.getProjectPresets('proj-1')[0].agentConfigs[0].providerConfigName).toBe(
        'config alpha',
      );
    });

    it('does not write settings when no preset entries change', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);

      const originalPrepare = db.prepare.bind(db);
      let writeCount = 0;
      const spy = jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO settings')) {
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args: unknown[]) => {
            writeCount++;
            return originalRun(...args);
          };
        }
        return stmt;
      });

      await delegate.renameProviderConfigInProjectPresets('proj-1', {
        profileId: 'profile-target',
        oldName: 'Missing Config',
        newName: 'New Config',
        agents: [{ name: 'Agent1', profileId: 'profile-target' }],
      });

      spy.mockRestore();
      expect(writeCount).toBe(0);
      expect(delegate.getProjectPresets('proj-1')).toEqual([validPreset]);
    });

    it('rejects empty rename values before writing invalid preset data', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);

      await expect(
        delegate.renameProviderConfigInProjectPresets('proj-1', {
          profileId: 'profile-target',
          oldName: 'Config1',
          newName: '   ',
          agents: [{ name: 'Agent1', profileId: 'profile-target' }],
        }),
      ).rejects.toThrow(ValidationError);

      expect(delegate.getProjectPresets('proj-1')).toEqual([validPreset]);
    });
  });
});
