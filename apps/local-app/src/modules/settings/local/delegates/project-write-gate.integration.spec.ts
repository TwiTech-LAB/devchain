// Direct writers with real SQLite are the cheapest layer that catches a missing
// write-site guard when controller/service admission would otherwise hide it.
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectFrozenError } from '../../../../common/errors/error-types';
import { createTestDatabase } from '../../../../common/test/test-database.helper';
import type { SettingsDto } from '../../dtos/settings.dto';
import { SettingsService } from '../../services/settings.service';
import { LocalStorageService } from '../../../storage/local/local-storage.service';
import { ProjectWriteGate } from '../../../storage/write-gate/project-write-gate';
import { TeamsStore } from '../../../teams/storage/teams.store';

const stamp = '2026-09-22T00:00:00.000Z';
const metadata = {
  templateSlug: 'gate-template',
  installedVersion: '1.0.0',
  registryUrl: 'https://example.test/registry',
  installedAt: stamp,
  lastUpdateCheckAt: stamp,
};
const preset = {
  name: 'Base',
  agentConfigs: [{ agentName: 'Bot', providerConfigName: 'default' }],
};

describe('Direct project writer admission', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let gate: ProjectWriteGate;
  let settings: SettingsService;
  let teams: TeamsStore;
  let blockedId: string;
  let writableId: string;
  let blockedTeamId: string;
  let writableTeamId: string;

  beforeEach(async () => {
    database = createTestDatabase();
    const storage = new LocalStorageService(database.db);
    gate = new ProjectWriteGate();
    gate.bindStorage(storage);
    await gate.onModuleInit();
    blockedId = (
      await storage.createProject({
        name: 'Blocked',
        rootPath: '/tmp/blocked',
        description: null,
        isTemplate: false,
      })
    ).id;
    writableId = (
      await storage.createProject({
        name: 'Writable',
        rootPath: '/tmp/writable',
        description: null,
        isTemplate: false,
      })
    ).id;
    settings = new SettingsService(database.db, new EventEmitter2(), gate);
    teams = new TeamsStore(database.db, gate);
    blockedTeamId = (
      await teams.createTeam({ projectId: blockedId, name: 'Blocked team', memberAgentIds: [] })
    ).id;
    writableTeamId = (
      await teams.createTeam({ projectId: writableId, name: 'Writable team', memberAgentIds: [] })
    ).id;
    await settings.updateSettings({
      initialSessionPromptIds: { [blockedId]: 'old-prompt', [writableId]: 'writable-prompt' },
      autoClean: { statusIds: { [blockedId]: [], [writableId]: [] } },
      messagePool: {
        projects: { [blockedId]: { enabled: true }, [writableId]: { enabled: true } },
      },
      registryTemplates: { [blockedId]: metadata, [writableId]: metadata },
      projectPresets: { [blockedId]: [preset], [writableId]: [preset] },
      projectActivePresets: { [blockedId]: 'Base', [writableId]: 'Base' },
    });
    gate.markFrozen(blockedId, stamp);
  });

  afterEach(() => database.sqlite.close());

  const snapshot = (): unknown[] =>
    ['settings', 'teams', 'team_members', 'team_profiles', 'team_profile_configs'].map((table) =>
      database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );

  function changeMap<T>(
    stored: Record<string, T> | undefined,
    value: T,
    remove: boolean,
  ): Record<string, T> {
    const next = { ...stored };
    if (remove) delete next[blockedId];
    else next[blockedId] = value;
    return next;
  }

  const maps: Array<[string, (remove: boolean) => SettingsDto]> = [
    [
      'initial prompts',
      (remove) => ({
        initialSessionPromptIds: changeMap(
          settings.getSettings().initialSessionPromptIds,
          'changed-prompt',
          remove,
        ),
      }),
    ],
    [
      'auto-clean',
      (remove) => ({
        autoClean: {
          statusIds: changeMap(settings.getSettings().autoClean?.statusIds, [writableId], remove),
        },
      }),
    ],
    [
      'message pool',
      (remove) => ({
        messagePool: {
          projects: changeMap(
            settings.getSettings().messagePool?.projects,
            { enabled: false },
            remove,
          ),
        },
      }),
    ],
    [
      'registry metadata',
      (remove) => ({
        registryTemplates: changeMap(
          settings.getSettings().registryTemplates,
          { ...metadata, installedVersion: '2.0.0' },
          remove,
        ),
      }),
    ],
    [
      'presets',
      (remove) => ({
        projectPresets: changeMap(settings.getSettings().projectPresets, [], remove),
      }),
    ],
    [
      'active presets',
      (remove) => ({
        projectActivePresets: changeMap(
          settings.getSettings().projectActivePresets,
          'Changed',
          remove,
        ),
      }),
    ],
  ];

  it.each(
    maps.flatMap(([name, update]) =>
      [false, true].map((remove) => [name, remove, update] as const),
    ),
  )(
    'rejects changing/removing the blocked %s slice (remove=%s) before global writes',
    async (_name, remove, update) => {
      const before = snapshot();

      await expect(
        settings.updateSettings({ cloud: { instanceLabel: 'Must not change' }, ...update(remove) }),
      ).rejects.toThrow(ProjectFrozenError);

      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    [
      'project prompt alias',
      () =>
        settings.updateSettings({ projectId: blockedId, initialSessionPromptId: 'changed-prompt' }),
    ],
    ['replace presets', () => settings.setProjectPresets(blockedId, [])],
    ['clear presets', () => settings.clearProjectPresets(blockedId)],
    [
      'create preset',
      () => settings.createProjectPreset(blockedId, { name: 'New', agentConfigs: [] }),
    ],
    [
      'update preset',
      () => settings.updateProjectPreset(blockedId, 'Base', { description: 'Changed' }),
    ],
    ['delete preset', () => settings.deleteProjectPreset(blockedId, 'Base')],
    ['set active preset', () => settings.setProjectActivePreset(blockedId, 'Changed')],
    ['clear active preset', () => settings.setProjectActivePreset(blockedId, null)],
    ['remove preset agent', () => settings.removeAgentFromProjectPresets(blockedId, 'Bot')],
    [
      'rename preset provider config',
      () =>
        settings.renameProviderConfigInProjectPresets(blockedId, {
          profileId: 'profile',
          oldName: 'default',
          newName: 'Changed',
          agents: [{ name: 'Bot', profileId: 'profile' }],
        }),
    ],
    [
      'set registry metadata',
      () =>
        settings.setProjectTemplateMetadata(blockedId, { ...metadata, installedVersion: '2.0.0' }),
    ],
    ['clear registry metadata', () => settings.clearProjectTemplateMetadata(blockedId)],
    ['registry timestamp', () => settings.updateLastUpdateCheck(blockedId)],
    [
      'create team',
      () => teams.createTeam({ projectId: blockedId, name: 'New', memberAgentIds: [] }),
    ],
    ['update team', () => teams.updateTeam(blockedTeamId, { name: 'Changed' })],
    ['delete team', () => teams.deleteTeam(blockedTeamId)],
    ['delete project teams', () => teams.deleteTeamsByProject(blockedId)],
    ['delete all named teams', () => teams.deleteTeamsByIds([writableTeamId, blockedTeamId])],
    ['replace team profile configs', () => teams.replaceTeamProfileConfigs(blockedTeamId, [])],
  ] as const)('refuses the direct %s writer without changing rows', async (_name, write) => {
    const before = snapshot();

    await expect(write()).rejects.toThrow(ProjectFrozenError);

    expect(snapshot()).toEqual(before);
  });

  it('refuses capped team creation before its agent callback', async () => {
    const before = snapshot();
    const createAgentFn = jest.fn();

    await expect(
      teams.createTeamAgentAtomicCapped({
        teamId: blockedTeamId,
        maxMembers: 5,
        teamLeadAgentId: null,
        createAgentFn,
      }),
    ).rejects.toThrow(ProjectFrozenError);

    expect(createAgentFn).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('allows writable-project and global settings updates while preserving blocked entries', async () => {
    const before = settings.getSettings();

    await settings.setProjectTemplateMetadata(writableId, {
      ...metadata,
      installedVersion: '2.0.0',
    });
    await settings.setProjectPresets(writableId, []);
    await settings.updateSettings({ cloud: { instanceLabel: 'Global change' } });

    expect(settings.getProjectTemplateMetadata(writableId)?.installedVersion).toBe('2.0.0');
    expect(settings.getProjectPresets(writableId)).toEqual([]);
    expect(settings.getProjectTemplateMetadata(blockedId)).toEqual(
      before.registryTemplates?.[blockedId],
    );
    expect(settings.getProjectPresets(blockedId)).toEqual(before.projectPresets?.[blockedId]);
    expect(settings.getSettings().cloud?.instanceLabel).toBe('Global change');
  });
});
