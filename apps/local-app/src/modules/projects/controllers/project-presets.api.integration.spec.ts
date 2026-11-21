import { createApiTestApp, type ApiTestApp } from '../../../common/test/api-test-app';
import { RegistryOrchestrationService } from '../../registry/services/registry-orchestration.service';
import { SettingsService } from '../../settings/services/settings.service';
import { TeamsService } from '../../teams/services/teams.service';

// HTTP injection exercises the request schemas and serialized responses with real preset storage.
describe('Project preset API', () => {
  let api: ApiTestApp;
  let projectId: string;
  let projectUrl: string;

  beforeAll(async () => {
    api = await createApiTestApp();
    const project = await api.storage.createProject({
      name: 'Preset Project',
      description: null,
      rootPath: api.rootDir,
      isTemplate: false,
    });
    projectId = project.id;
    projectUrl = `/api/projects/${projectId}`;
  });

  afterAll(async () => {
    await api?.close();
  });

  const teamConfigs = [{ teamName: 'Builders', profileSelections: [] }];

  it('writes team entries while keeping preset ownership server-controlled', async () => {
    const url = `${projectUrl}/presets`;
    const preset = { name: 'My preset', agentConfigs: [], teamConfigs };
    const created = await api.app.inject({
      method: 'POST',
      url,
      payload: { ...preset, name: ' My preset ', origin: 'template' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ ...preset, origin: 'user' });

    const updated = await api.app.inject({
      method: 'PATCH',
      url,
      payload: { presetName: preset.name, updates: { teamConfigs: [] } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ ...preset, origin: 'user', teamConfigs: [] });

    const invalidUpdate = await api.app.inject({
      method: 'PATCH',
      url,
      payload: { presetName: preset.name, updates: { origin: 'user' } },
    });
    expect(invalidUpdate.statusCode).toBe(400);

    const duplicateTeams = [...teamConfigs, { teamName: ' BUILDERS ', profileSelections: [] }];
    const duplicateCreate = await api.app.inject({
      method: 'POST',
      url,
      payload: { ...preset, name: 'Duplicate teams', teamConfigs: duplicateTeams },
    });
    expect(duplicateCreate.statusCode).toBe(400);

    const duplicateUpdate = await api.app.inject({
      method: 'PATCH',
      url,
      payload: { presetName: preset.name, updates: { teamConfigs: duplicateTeams } },
    });
    expect(duplicateUpdate.statusCode).toBe(400);
  });

  it('includes team entries from export overrides and omits the ownership mark', async () => {
    const preset = { name: 'Export override', agentConfigs: [], teamConfigs };
    const response = await api.app.inject({
      method: 'POST',
      url: `${projectUrl}/export`,
      payload: { presets: [{ ...preset, origin: 'user' }] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().presets).toEqual([preset]);
  });

  it('returns the applied team count and clears the active marker after a team edit', async () => {
    const provider = await api.storage.createProvider({ name: 'claude' });
    const profile = await api.storage.createAgentProfile({ projectId, name: 'Coder' });
    const config = await api.storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: 'Fast',
      options: null,
      env: null,
    });
    const agent = await api.storage.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name: 'Builder',
    });
    const teams = api.app.get(TeamsService);
    const team = await teams.createTeam({
      projectId,
      name: 'Builders',
      memberAgentIds: [agent.id],
      profileIds: [profile.id],
    });
    const url = `${projectUrl}/presets`;
    const preset = {
      name: 'Fast teams',
      agentConfigs: [],
      teamConfigs: [
        {
          teamName: 'Builders',
          profileSelections: [{ profileName: 'Coder', configNames: ['Fast'] }],
        },
      ],
    };
    const created = await api.app.inject({ method: 'POST', url, payload: preset });
    expect(created.statusCode).toBe(201);

    const applied = await api.app.inject({
      method: 'POST',
      url: `${url}/apply`,
      payload: { presetName: preset.name },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ applied: 0, teamsApplied: 1, warnings: [] });
    expect((await teams.getTeam(team.id))?.profileConfigSelections).toEqual([
      { profileId: profile.id, configIds: [config.id] },
    ]);
    expect((await api.app.inject({ method: 'GET', url })).json().activePreset).toBe(preset.name);

    await teams.updateTeam(team.id, { profileConfigSelections: [] });

    expect((await api.app.inject({ method: 'GET', url })).json().activePreset).toBeNull();
  });

  it('reads the merged presets and clears the active marker for a preset pruned by replace import', async () => {
    const project = await api.storage.createProject({
      name: 'Replace Presets Project',
      description: null,
      rootPath: api.rootDir,
      isTemplate: false,
    });
    const settings = api.app.get(SettingsService);
    const kept = {
      name: 'Personal',
      origin: 'user' as const,
      agentConfigs: [{ agentName: ' Coder ', providerConfigName: 'Default' }],
    };
    await settings.setProjectPresets(project.id, [
      kept,
      { name: 'Old template', agentConfigs: [] },
      {
        name: 'Orphan',
        origin: 'user',
        agentConfigs: [{ agentName: 'Retired', providerConfigName: 'Default' }],
      },
    ]);
    await settings.setProjectActivePreset(project.id, 'Orphan');
    await api.storage.createProvider({ name: 'codex' });

    const profileId = '11111111-1111-4111-8111-111111111111';
    const incoming = { name: 'New template', agentConfigs: [] };
    const url = `/api/projects/${project.id}`;
    const replaced = await api.app.inject({
      method: 'POST',
      url: `${url}/import`,
      payload: {
        version: 1,
        profiles: [
          {
            id: profileId,
            name: 'Coder',
            provider: { name: 'codex' },
            providerConfigs: [{ name: 'Default', providerName: 'codex' }],
          },
        ],
        agents: [{ name: 'Coder', profileId, providerConfigName: 'Default' }],
        presets: [incoming],
      },
    });
    expect(replaced.json()).toMatchObject({ success: true });

    const read = await api.app.inject({ method: 'GET', url: `${url}/presets` });
    expect(read.json()).toEqual({ presets: [incoming, kept], activePreset: null });
  });

  it('stores registry presets as template presets, so a later import replaces them', async () => {
    await api.storage.createProvider({ name: 'agy' });
    const profileId = '33333333-3333-4333-8333-333333333333';
    const template = {
      version: 1,
      profiles: [
        {
          id: profileId,
          name: 'Coder',
          provider: { name: 'agy' },
          providerConfigs: [{ name: 'Default', providerName: 'agy' }],
        },
      ],
      agents: [{ name: 'Coder', profileId, providerConfigName: 'Default' }],
    };
    const preset = {
      name: 'Registry default',
      agentConfigs: [{ agentName: 'Coder', providerConfigName: 'Default' }],
    };
    const acquire = jest
      .spyOn(api.app.get(RegistryOrchestrationService), 'getOrDownloadTemplate')
      .mockResolvedValue({
        content: { ...template, presets: [{ ...preset, origin: 'user' }] },
        metadata: {
          slug: 'example',
          version: '1.0.0',
          checksum: 'checksum',
          cachedAt: '2026-01-01T00:00:00.000Z',
          size: 1,
        },
      });

    const created = await api.app.inject({
      method: 'POST',
      url: '/api/projects/from-registry',
      payload: {
        slug: 'example',
        version: '1.0.0',
        projectName: 'Registry Presets Project',
        rootPath: api.rootDir,
      },
    });
    acquire.mockRestore();
    expect(created.statusCode).toBe(201);
    expect(created.json().imported.agents).toBe(1);

    const url = `/api/projects/${created.json().project.id}`;
    const stored = await api.app.inject({ method: 'GET', url: `${url}/presets` });
    expect(stored.json().presets).toEqual([preset]);

    const replaced = await api.app.inject({
      method: 'POST',
      url: `${url}/import`,
      payload: { ...template, presets: [] },
    });
    expect(replaced.json()).toMatchObject({ success: true });

    const read = await api.app.inject({ method: 'GET', url: `${url}/presets` });
    expect(read.json().presets).toEqual([]);
  });
});
