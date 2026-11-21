/**
 * Create from the bundled `teams-dev` template when `copilot` is the only installed provider.
 *
 * Layer: backend-integration. One app boot with real SQLite runs the real setup-preview and
 * create routes, and the request body comes from the real wizard functions
 * (`initialWizardConfigState` -> `buildConfigEmission`), as the create wizard sends it. This
 * layer is used because the e2e Jest project cannot load the `.tsx` wizard modules, and it keeps
 * one source of truth for the body without a stored fixture.
 */
import { createApiTestApp, type ApiTestApp } from '../../common/test/api-test-app';
import {
  buildConfigEmission,
  initialWizardConfigState,
} from '../../ui/components/project/wizard/useWizardConfig';
import type { SetupPreviewResponse } from '../../ui/pages/projects/lib/project-contracts';

interface ExportedProject {
  profiles: Array<{
    name: string;
    providerConfigs?: Array<{ name: string; providerName: string }>;
  }>;
  agents: Array<{
    name: string;
    profileId?: string;
    providerConfigName?: string | null;
    modelOverride?: string | null;
  }>;
  teams?: Array<{
    name: string;
    profileNames?: string[];
    profileSelections?: Array<{ profileName: string; configNames: string[] }>;
  }>;
}

describe('create from teams-dev with only copilot installed', () => {
  let api: ApiTestApp;

  beforeAll(async () => {
    api = await createApiTestApp();
  });

  afterAll(async () => {
    await api.close();
  });

  async function post<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
    const res = await api.app.inject({ method: 'POST', url, payload: payload as object });
    return { status: res.statusCode, body: JSON.parse(res.payload) as T };
  }

  it('creates every agent and the Builders team on copilot', async () => {
    expect((await post('/api/providers', { name: 'copilot' })).status).toBe(201);

    const preview = await post<SetupPreviewResponse>('/api/projects/setup-preview', {
      slug: 'teams-dev',
    });
    expect(preview.status).toBe(200);
    const emission = buildConfigEmission(preview.body, initialWizardConfigState(preview.body));

    const created = await post<{
      success: boolean;
      project?: { id: string };
      providerMappingRequired?: unknown;
    }>('/api/projects/from-template', {
      name: 'Copilot only',
      rootPath: api.rootDir,
      templateId: 'teams-dev',
      ...emission,
    });
    expect(created.status).toBe(201);
    expect(created.body.success).toBe(true);
    expect(created.body.providerMappingRequired).toBeUndefined();

    const exported = await api.app.inject({
      method: 'GET',
      url: `/api/projects/${created.body.project!.id}/export`,
    });
    const project = JSON.parse(exported.payload) as ExportedProject;

    const configProvider = (profileName: string, configName: string) =>
      project.profiles
        .find((profile) => profile.name === profileName)
        ?.providerConfigs?.find((config) => config.name === configName)?.providerName;
    const profileNameById = new Map(
      (preview.body.payload.profiles ?? []).map((profile) => [profile.id, profile.name]),
    );
    const templateProfileOf = (agentName: string) => {
      const agent = preview.body.payload.agents?.find((a) => a.name === agentName);
      return profileNameById.get(agent?.profileId ?? '') ?? '';
    };

    expect(project.agents.map((agent) => agent.name).sort()).toEqual([
      'Architect',
      'Brainstormer',
      'Code Reviewer',
      'Epic Manager',
    ]);
    for (const agent of project.agents) {
      expect({
        agent: agent.name,
        provider: configProvider(templateProfileOf(agent.name), agent.providerConfigName ?? ''),
      }).toEqual({ agent: agent.name, provider: 'copilot' });
    }
    expect(
      project.agents.find((agent) => agent.name === 'Epic Manager')?.modelOverride ?? null,
    ).toBeNull();

    const builders = project.teams?.find((team) => team.name === 'Builders');
    expect(builders?.profileNames).toContain('Coder');
    const coderConfigs =
      builders?.profileSelections?.find((selection) => selection.profileName === 'Coder')
        ?.configNames ?? [];
    expect(coderConfigs).toContain('copilot');
    expect(coderConfigs.map((name) => configProvider('Coder', name))).toEqual(
      coderConfigs.map(() => 'copilot'),
    );
  });
});
