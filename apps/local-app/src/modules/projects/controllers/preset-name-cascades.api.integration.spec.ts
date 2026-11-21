import { createApiTestApp, type ApiTestApp } from '../../../common/test/api-test-app';
import { SettingsService } from '../../settings/services/settings.service';
import { TeamsService } from '../../teams/services/teams.service';

const mockCascadeError = jest.fn();
jest.mock('../../../common/logging/logger', () => {
  const actual = jest.requireActual<typeof import('../../../common/logging/logger')>(
    '../../../common/logging/logger',
  );
  return {
    ...actual,
    createLogger: (context: string) => {
      const logger = actual.createLogger(context);
      if (context === 'TeamsService' || context === 'ProfilesService') {
        logger.error = (...args: unknown[]) => mockCascadeError(...args);
      }
      return logger;
    },
  };
});

// Real routes and SQLite storage verify the primary write and its preset cascade together.
describe('Preset name cascades', () => {
  let api: ApiTestApp;
  let settings: SettingsService;
  let teams: TeamsService;
  let providerId: string;

  beforeAll(async () => {
    api = await createApiTestApp();
    settings = api.app.get(SettingsService);
    teams = api.app.get(TeamsService);
    providerId = (await api.storage.createProvider({ name: 'claude' })).id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockCascadeError.mockClear();
  });

  afterAll(async () => {
    await api?.close();
  });

  const preset = {
    name: 'Team setup',
    origin: 'user',
    agentConfigs: [],
    teamConfigs: [
      {
        teamName: 'Builders',
        profileSelections: [{ profileName: 'Coder', configNames: ['Default'] }],
      },
    ],
  };

  async function seedProject(name: string) {
    const project = await api.storage.createProject({
      name,
      description: null,
      rootPath: api.rootDir,
      isTemplate: false,
    });
    const profile = await api.storage.createAgentProfile({ projectId: project.id, name: 'Coder' });
    const config = await api.storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId,
      name: 'Default',
      options: null,
      env: null,
    });
    const agent = await api.storage.createAgent({
      projectId: project.id,
      profileId: profile.id,
      providerConfigId: config.id,
      name: 'Coder1',
    });
    const team = await teams.createTeam({
      projectId: project.id,
      name: 'Builders',
      memberAgentIds: [agent.id],
      profileIds: [profile.id],
    });
    await settings.setProjectPresets(project.id, [preset]);
    return { projectId: project.id, profileId: profile.id, teamId: team.id };
  }

  it('updates preset entries after profile and team renames and removes them on disband', async () => {
    const { projectId, profileId, teamId } = await seedProject('Cascade success');
    const profileUrl = `/api/profiles/${profileId}`;
    const teamUrl = `/api/teams/${teamId}`;
    const profile = await api.app.inject({
      method: 'PUT',
      url: profileUrl,
      payload: { name: 'Developer' },
    });
    const team = await api.app.inject({
      method: 'PUT',
      url: teamUrl,
      payload: { name: 'Coders' },
    });
    expect([profile.statusCode, team.statusCode]).toEqual([200, 200]);
    expect(settings.getProjectPresets(projectId)).toEqual([
      {
        ...preset,
        teamConfigs: [
          {
            teamName: 'Coders',
            profileSelections: [{ profileName: 'Developer', configNames: ['Default'] }],
          },
        ],
      },
    ]);

    const disband = await api.app.inject({ method: 'DELETE', url: teamUrl });
    expect(disband.statusCode).toBe(200);
    expect(settings.getProjectPresets(projectId)).toEqual([{ ...preset, teamConfigs: [] }]);
  });

  it('keeps preset entries during project team teardown', async () => {
    const { projectId, teamId } = await seedProject('Import teardown');
    await teams.deleteTeamsByProject(projectId);
    expect(await teams.getTeam(teamId)).toBeNull();
    expect(settings.getProjectPresets(projectId)).toEqual([preset]);
  });

  it.each([
    {
      cascade: 'renameTeamInProjectPresets',
      route: 'teams',
      method: 'PUT',
      message: 'Failed to rename team in project presets',
    },
    {
      cascade: 'removeTeamFromProjectPresets',
      route: 'teams',
      method: 'DELETE',
      message: 'Failed to remove disbanded team from project presets',
    },
    {
      cascade: 'renameProfileInProjectPresets',
      route: 'profiles',
      method: 'PUT',
      message: 'Failed to rename profile in project presets',
    },
  ] as const)(
    'logs $cascade failures and returns success',
    async ({ cascade, route, method, message }) => {
      const { projectId, profileId, teamId } = await seedProject(cascade);
      const failure = new Error('preset write failed');
      jest.spyOn(settings, cascade).mockRejectedValueOnce(failure);
      const id = route === 'profiles' ? profileId : teamId;
      const response = await api.app.inject({
        method,
        url: `/api/${route}/${id}`,
        payload: method === 'PUT' ? { name: 'Renamed' } : undefined,
      });

      expect(response.statusCode).toBe(200);
      if (method === 'DELETE') {
        expect(await teams.getTeam(teamId)).toBeNull();
      } else {
        expect(response.json()).toMatchObject({ name: 'Renamed' });
      }
      expect(mockCascadeError).toHaveBeenCalledWith(
        expect.objectContaining({ error: failure, projectId }),
        message,
      );
    },
  );
});
