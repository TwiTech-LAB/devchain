import { createApiTestApp, type ApiTestApp } from '../../../common/test/api-test-app';
import { EventsService } from '../../events/services/events.service';
import { TeamsService } from '../../teams/services/teams.service';

// HTTP injection proves the public contract: route wiring, the serialized agent and the error
// codes that the HTTP exception filter returns.
describe('Agent API', () => {
  let api: ApiTestApp;
  let projectId: string;
  let lead: string;
  let member: string;
  let owner: string;
  let loner: string;

  beforeAll(async () => {
    api = await createApiTestApp();
    const project = await api.storage.createProject({
      name: 'Disable Project',
      description: null,
      rootPath: api.rootDir,
      isTemplate: false,
    });
    projectId = project.id;
    const provider = await api.storage.createProvider({ name: 'claude' });
    const profile = await api.storage.createAgentProfile({ projectId, name: 'Coder' });
    const config = await api.storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: 'Default',
      options: null,
      env: null,
    });
    const createAgent = async (name: string, isProjectOwner = false) =>
      (
        await api.storage.createAgent({
          projectId,
          profileId: profile.id,
          providerConfigId: config.id,
          name,
          isProjectOwner,
        })
      ).id;
    lead = await createAgent('Lead');
    member = await createAgent('Member');
    owner = await createAgent('Owner', true);
    loner = await createAgent('Loner');
    await api.app.get(TeamsService).createTeam({
      projectId,
      name: 'Builders',
      teamLeadAgentId: lead,
      memberAgentIds: [lead, member, owner],
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  const post = (agentId: string, action: string, payload?: object) =>
    api.app.inject({ method: 'POST', url: `/api/agents/${agentId}/${action}`, payload });

  /** Send an agent edit; return the response and the `agent.updated` events that it published. */
  const editAgent = async (method: 'PUT' | 'PATCH', agentId: string, payload: object) => {
    const publish = jest.spyOn(api.app.get(EventsService), 'publish');
    try {
      const response = await api.app.inject({ method, url: `/api/agents/${agentId}`, payload });
      const published = publish.mock.calls.filter(([name]) => name === 'agent.updated');
      return { response, published };
    } finally {
      publish.mockRestore();
    }
  };

  it.each(['PUT', 'PATCH'] as const)(
    '%s /api/agents/:id stores the change and publishes agent.updated once',
    async (method) => {
      const payload = { description: `edited by ${method}` };
      const { response, published } = await editAgent(method, loner, payload);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: loner, ...payload });
      expect(published).toEqual([['agent.updated', { agentId: loner, projectId }]]);
    },
  );

  // A project owner change writes two rows: the new owner and the former owner.
  it('publishes agent.updated once for each agent row that a project owner change writes', async () => {
    const makeOwner = async (agentId: string) => {
      const { response, published } = await editAgent('PATCH', agentId, { isProjectOwner: true });
      expect(response.statusCode).toBe(200);
      return published;
    };
    try {
      expect(await makeOwner(owner)).toEqual([['agent.updated', { agentId: owner, projectId }]]);

      expect(await makeOwner(loner)).toEqual([
        ['agent.updated', { agentId: loner, projectId }],
        ['agent.updated', { agentId: owner, projectId }],
      ]);
      expect((await api.storage.getAgent(owner)).isProjectOwner).toBe(false);
      expect((await api.storage.getAgent(loner)).isProjectOwner).toBe(true);
    } finally {
      // Later tests expect `owner` to own the project.
      await makeOwner(owner);
    }
  });

  it('disables and enables a team member and shows the flag in agent reads', async () => {
    const disabled = await post(member, 'disable');
    expect(disabled.statusCode).toBe(201);
    expect(disabled.json()).toMatchObject({ id: member, disabled: true });
    expect((await post(member, 'disable')).statusCode).toBe(201);

    const single = await api.app.inject({ method: 'GET', url: `/api/agents/${member}` });
    expect(single.json()).toMatchObject({ disabled: true });
    const list = await api.app.inject({ method: 'GET', url: `/api/agents?projectId=${projectId}` });
    expect(list.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: member, disabled: true }),
        expect.objectContaining({ id: lead, disabled: false }),
      ]),
    );

    const enabled = await post(member, 'enable');
    expect(enabled.statusCode).toBe(201);
    expect(enabled.json()).toMatchObject({ id: member, disabled: false });
  });

  it.each([
    ['Project Owner', () => owner, 'AGENT_IS_PROJECT_OWNER'],
    ['team lead', () => lead, 'AGENT_IS_TEAM_LEAD'],
    ['agent in no team', () => loner, 'AGENT_NOT_IN_TEAM'],
  ])('rejects Disable for the %s with %s', async (_name, agentId, code) => {
    const response = await post(agentId(), 'disable');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', details: { code } });
  });

  it('refuses a restart of a disabled agent before it stops or starts a session', async () => {
    await post(member, 'disable');

    const response = await post(member, 'restart', { projectId });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'AGENT_DISABLED',
      message: 'Agent Member is disabled. Enable it first.',
    });
    expect(api.sqlite.prepare('SELECT id FROM sessions WHERE agent_id = ?').all(member)).toEqual(
      [],
    );
  });
});
