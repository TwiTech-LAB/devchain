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

  describe('mergeProjectTemplatePresets', () => {
    const builders = { teamName: ' Builders ', profileSelections: [] };
    const retired = { teamName: 'Retired', profileSelections: [] };
    const kept = {
      ...validPreset,
      name: 'My preset',
      origin: 'user',
      description: 'Keep the preset fields',
      teamConfigs: [builders],
    };
    const teamOnly = {
      name: 'Team only',
      origin: 'user',
      agentConfigs: [],
      teamConfigs: [builders],
    };
    const empty = {
      name: 'No surviving entries',
      origin: 'user',
      agentConfigs: validPreset2.agentConfigs,
      teamConfigs: [retired],
    };
    const incoming = { ...validPreset2, name: '  TEST PRESET ' };

    // SQLite verifies the resulting list, including ownership and persisted order.
    it.each([
      {
        rule: 'incoming presets win normalized name collisions and precede surviving user presets',
        stored: [kept, validPreset2, { ...validPreset, origin: 'user' }, teamOnly],
        imports: [
          { ...incoming, origin: 'user' },
          { ...validPreset2, origin: 'invalid' },
        ],
        teams: ['BUILDERS'],
        expected: [incoming, validPreset2, kept, teamOnly],
      },
      {
        rule: 'prunes missing agent and team references and drops a preset without entries',
        stored: [
          {
            ...kept,
            agentConfigs: [...kept.agentConfigs, ...validPreset2.agentConfigs],
            teamConfigs: [builders, retired],
          },
          empty,
        ],
        imports: [incoming],
        teams: ['builders'],
        expected: [incoming, kept],
      },
      {
        rule: 'empty template preset list removes only template presets and prunes users',
        stored: [validPreset, kept, teamOnly],
        imports: [],
        teams: [' builders '],
        expected: [kept, teamOnly],
      },
      {
        rule: 'unavailable team names preserve existing team entries',
        stored: [empty],
        imports: [],
        teams: undefined,
        expected: [{ ...empty, agentConfigs: [] }],
      },
      {
        rule: 'an available team roster can be empty',
        stored: [teamOnly],
        imports: [],
        teams: [],
        expected: [],
      },
    ])('$rule', async ({ stored, imports, teams, expected }) => {
      await delegate.setProjectPresets('proj-1', stored);
      await delegate.mergeProjectTemplatePresets('proj-1', imports, [' aGENT1 '], teams);
      expect(delegate.getProjectPresets('proj-1')).toEqual(expected);
    });

    it('leaves the stored list intact when a template preset fails validation', async () => {
      await delegate.setProjectPresets('proj-1', [kept]);
      await expect(
        delegate.mergeProjectTemplatePresets('proj-1', [incoming, { name: '' }], []),
      ).rejects.toThrow(ValidationError);
      expect(delegate.getProjectPresets('proj-1')).toEqual([kept]);
    });
  });

  describe('preset name cascades', () => {
    const builderSelection = { profileName: ' CODER ', configNames: [' CONFIG1 ', 'Other'] };
    const reviewerSelection = { profileName: 'Reviewer', configNames: ['Config1'] };
    const builders = {
      teamName: ' BUILDERS ',
      profileSelections: [builderSelection, reviewerSelection],
    };
    const reviewers = { teamName: 'Reviewers', profileSelections: [] };
    const coders = { ...builders, teamName: 'Coders' };
    const original = {
      name: 'Team setup',
      description: 'Kept during cascades',
      origin: 'user',
      agentConfigs: [
        { agentName: ' Coder1 ', providerConfigName: 'Config1', effortOverride: 'high' },
        { agentName: 'Reviewer1', providerConfigName: 'Config1', modelOverride: 'opus' },
      ],
      teamConfigs: [builders, reviewers],
    };
    const configRename = {
      profileId: 'profile-coder',
      profileName: 'Coder',
      oldName: 'Config1',
      newName: 'Config2',
    };
    const configRenamed = {
      ...builders,
      profileSelections: [
        { ...builderSelection, configNames: ['Config2', 'Other'] },
        reviewerSelection,
      ],
    };

    // SQLite verifies each cascade preserves the rest of the persisted preset.
    it.each([
      {
        rule: 'config rename updates agent and team references for the matching profile',
        stored: original,
        cascade: () =>
          delegate.renameProviderConfigInProjectPresets('proj-1', {
            ...configRename,
            agents: [
              { name: 'Coder1', profileId: 'profile-coder' },
              { name: 'Reviewer1', profileId: 'profile-reviewer' },
            ],
          }),
        expected: {
          ...original,
          agentConfigs: [
            { ...original.agentConfigs[0], providerConfigName: 'Config2' },
            original.agentConfigs[1],
          ],
          teamConfigs: [configRenamed, reviewers],
        },
      },
      {
        rule: 'config rename updates team references when no agents use the profile',
        stored: original,
        cascade: () =>
          delegate.renameProviderConfigInProjectPresets('proj-1', { ...configRename, agents: [] }),
        expected: { ...original, teamConfigs: [configRenamed, reviewers] },
      },
      {
        rule: 'team rename updates the matching entry',
        stored: original,
        cascade: () => delegate.renameTeamInProjectPresets('proj-1', 'Builders', 'Coders'),
        expected: { ...original, teamConfigs: [coders, reviewers] },
      },
      {
        rule: 'team rename keeps the first source entry when the destination already exists',
        stored: {
          ...original,
          teamConfigs: [
            { teamName: ' CODERS ', profileSelections: [] },
            builders,
            { teamName: 'builders', profileSelections: [] },
            reviewers,
          ],
        },
        cascade: () => delegate.renameTeamInProjectPresets('proj-1', 'Builders', 'Coders'),
        expected: { ...original, teamConfigs: [coders, reviewers] },
      },
      {
        rule: 'team disband removes all matching entries',
        stored: { ...original, teamConfigs: [builders, reviewers, { ...builders }] },
        cascade: () => delegate.removeTeamFromProjectPresets('proj-1', 'Builders'),
        expected: { ...original, teamConfigs: [reviewers] },
      },
      {
        rule: 'profile rename updates the matching selection',
        stored: original,
        cascade: () => delegate.renameProfileInProjectPresets('proj-1', 'Coder', 'Developer'),
        expected: {
          ...original,
          teamConfigs: [
            {
              ...builders,
              profileSelections: [
                { ...builderSelection, profileName: 'Developer' },
                reviewerSelection,
              ],
            },
            reviewers,
          ],
        },
      },
    ])('$rule', async ({ stored, cascade, expected }) => {
      await delegate.setProjectPresets('proj-1', [stored, validPreset]);
      await delegate.setProjectPresets('proj-2', [stored]);

      await cascade();

      expect(delegate.getProjectPresets('proj-1')).toEqual([expected, validPreset]);
      expect(delegate.getProjectPresets('proj-2')).toEqual([stored]);
    });
  });

  const teamConfigs = [
    {
      teamName: 'Builders',
      profileSelections: [{ profileName: 'Coder', configNames: ['Config1'] }],
    },
  ];
  const replacement = [{ teamName: 'Reviewers', profileSelections: [] }];
  const duplicateTeams = [...teamConfigs, { teamName: '  BUILDERS  ', profileSelections: [] }];

  // The in-memory settings database exercises the delegate's persisted JSON contract.
  it('create sets the user mark and an update keeps it and the team entries', async () => {
    const projectId = 'proj-1';
    const created = await delegate.createProjectPreset(projectId, {
      ...validPreset,
      name: ' Test Preset ',
      origin: 'template',
      teamConfigs,
    });
    expect(created).toEqual({ ...validPreset, origin: 'user', teamConfigs });
    expect(delegate.getProjectPresets(projectId)).toEqual([created]);

    await delegate.updateProjectPreset(projectId, validPreset.name, { description: 'Updated' });
    expect(delegate.getProjectPresets(projectId)).toEqual([
      { ...validPreset, origin: 'user', teamConfigs, description: 'Updated' },
    ]);
  });

  it.each([
    {
      rule: 'an update replaces the team entries without marking a template preset',
      stored: { ...validPreset, teamConfigs },
      updates: { teamConfigs: replacement },
      expected: { ...validPreset, teamConfigs: replacement },
    },
    {
      rule: 'an empty array clears the team entries',
      stored: { ...validPreset, teamConfigs },
      updates: { teamConfigs: [] },
      expected: { ...validPreset, teamConfigs: [] },
    },
    {
      rule: 'renaming a legacy preset marks it as user-owned',
      stored: validPreset,
      updates: { name: 'Renamed' },
      expected: { ...validPreset, name: 'Renamed', origin: 'user' },
    },
  ])('$rule', async ({ stored, updates, expected }) => {
    const projectId = 'proj-1';
    await delegate.setProjectPresets(projectId, [stored]);
    await delegate.updateProjectPreset(projectId, validPreset.name, updates);
    expect(delegate.getProjectPresets(projectId)).toEqual([expected]);
  });

  it('creating a preset rejects duplicate team names', async () => {
    const projectId = 'proj-1';
    await expect(
      delegate.createProjectPreset(projectId, { ...validPreset, teamConfigs: duplicateTeams }),
    ).rejects.toThrow(ValidationError);
    expect(delegate.getProjectPresets(projectId)).toEqual([]);
  });

  it('updating a preset rejects duplicate team names', async () => {
    const projectId = 'proj-1';
    await delegate.setProjectPresets(projectId, [validPreset]);
    await expect(
      delegate.updateProjectPreset(projectId, validPreset.name, { teamConfigs: duplicateTeams }),
    ).rejects.toThrow(ValidationError);
    expect(delegate.getProjectPresets(projectId)).toEqual([validPreset]);
  });

  it('reading a stored preset preserves duplicate team entries', async () => {
    const projectId = 'proj-1';
    const stored = { ...validPreset, teamConfigs: duplicateTeams };
    await delegate.setProjectPresets(projectId, [stored]);
    expect(delegate.getProjectPresets(projectId)).toEqual([stored]);
  });

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

    it('setProjectPresets overwrites existing presets', async () => {
      await delegate.setProjectPresets('proj-1', [validPreset]);
      await delegate.setProjectPresets('proj-1', [validPreset2]);
      expect(delegate.getProjectPresets('proj-1')).toHaveLength(1);
      expect(delegate.getProjectPresets('proj-1')[0].name).toBe('Another Preset');
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

    it('update matches name case-insensitively', async () => {
      await delegate.createProjectPreset('proj-1', validPreset);
      await delegate.updateProjectPreset('proj-1', 'test preset', { description: 'updated' });

      const presets = delegate.getProjectPresets('proj-1');
      expect(presets[0].description).toBe('updated');
    });
  });

  describe('removeAgentFromProjectPresets', () => {
    it('removes matching agentConfigs from all presets for the project (case-insensitive)', async () => {
      await delegate.setProjectPresets('proj-1', [
        {
          name: 'Preset A',
          description: 'kept',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'Config1' },
            { agentName: 'Reviewer', providerConfigName: 'Config2' },
          ],
        },
        {
          name: 'Preset B',
          agentConfigs: [
            { agentName: 'CODER', providerConfigName: 'Config3' },
            { agentName: 'Other', providerConfigName: 'Config4' },
          ],
        },
      ]);
      await delegate.setProjectPresets('proj-2', [
        {
          name: 'Other Project Preset',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'Config5' }],
        },
      ]);

      await delegate.removeAgentFromProjectPresets('proj-1', 'coder');

      expect(delegate.getProjectPresets('proj-1')).toEqual([
        {
          name: 'Preset A',
          description: 'kept',
          agentConfigs: [{ agentName: 'Reviewer', providerConfigName: 'Config2' }],
        },
        {
          name: 'Preset B',
          agentConfigs: [{ agentName: 'Other', providerConfigName: 'Config4' }],
        },
      ]);
      // Other project unaffected
      expect(delegate.getProjectPresets('proj-2')[0].agentConfigs).toHaveLength(1);
    });

    it('trims agent name before matching', async () => {
      await delegate.setProjectPresets('proj-1', [
        { name: 'P', agentConfigs: [{ agentName: 'Agent1', providerConfigName: 'C' }] },
      ]);

      await delegate.removeAgentFromProjectPresets('proj-1', '  Agent1  ');

      expect(delegate.getProjectPresets('proj-1')[0].agentConfigs).toHaveLength(0);
    });

    it('preserves empty presets with agentConfigs: []', async () => {
      await delegate.setProjectPresets('proj-1', [
        { name: 'P', agentConfigs: [{ agentName: 'OnlyAgent', providerConfigName: 'C' }] },
      ]);

      await delegate.removeAgentFromProjectPresets('proj-1', 'OnlyAgent');

      const presets = delegate.getProjectPresets('proj-1');
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe('P');
      expect(presets[0].agentConfigs).toEqual([]);
    });

    it('throws ValidationError for whitespace-only agent name', async () => {
      await expect(delegate.removeAgentFromProjectPresets('proj-1', '   ')).rejects.toThrow(
        ValidationError,
      );

      await expect(delegate.removeAgentFromProjectPresets('proj-1', '')).rejects.toThrow(
        ValidationError,
      );
    });

    it('is a no-op and does not write when no preset entry changes', async () => {
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

      await delegate.removeAgentFromProjectPresets('proj-1', 'NonExistentAgent');

      spy.mockRestore();
      expect(writeCount).toBe(0);
      expect(delegate.getProjectPresets('proj-1')).toEqual([validPreset]);
    });

    it('preserves modelOverride on remaining agentConfigs after removal', async () => {
      await delegate.setProjectPresets('proj-1', [
        {
          name: 'P',
          agentConfigs: [
            { agentName: 'ToRemove', providerConfigName: 'C1', modelOverride: 'openai/gpt-5' },
            { agentName: 'Keeper', providerConfigName: 'C2', modelOverride: 'claude-opus' },
            { agentName: 'KeeperNull', providerConfigName: 'C3', modelOverride: null },
          ],
        },
      ]);

      await delegate.removeAgentFromProjectPresets('proj-1', 'ToRemove');

      const configs = delegate.getProjectPresets('proj-1')[0].agentConfigs;
      expect(configs).toHaveLength(2);
      expect(configs[0]).toEqual({
        agentName: 'Keeper',
        providerConfigName: 'C2',
        modelOverride: 'claude-opus',
      });
      expect(configs[1]).toEqual({
        agentName: 'KeeperNull',
        providerConfigName: 'C3',
        modelOverride: null,
      });
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

    it('preserves effortOverride through provider-config rename', async () => {
      await delegate.setProjectPresets('proj-1', [
        {
          name: 'Preset A',
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: 'Old Config',
              modelOverride: 'openai/gpt-5',
              effortOverride: 'high',
            },
          ],
        },
      ]);

      await delegate.renameProviderConfigInProjectPresets('proj-1', {
        profileId: 'profile-target',
        oldName: 'Old Config',
        newName: 'New Config',
        agents: [{ name: 'Coder', profileId: 'profile-target' }],
      });

      const configs = delegate.getProjectPresets('proj-1')[0].agentConfigs;
      expect(configs[0].providerConfigName).toBe('New Config');
      expect(configs[0].modelOverride).toBe('openai/gpt-5');
      expect(configs[0].effortOverride).toBe('high');
    });

    it('preserves effortOverride when updateProjectPreset replaces agentConfigs', async () => {
      await delegate.setProjectPresets('proj-1', [
        {
          name: 'Preset A',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'cfg', effortOverride: 'low' }],
        },
      ]);

      await delegate.updateProjectPreset('proj-1', 'Preset A', {
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'cfg', effortOverride: 'high' }],
      });

      const configs = delegate.getProjectPresets('proj-1')[0].agentConfigs;
      expect(configs[0].effortOverride).toBe('high');
    });
  });
});
