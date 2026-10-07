import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SafeVendorHttpClient } from '../modules/external-integrations/transport/safe-vendor-http-client';
import { createApiTestApp } from './test/api-test-app';

type ApiMethod = 'GET' | 'POST' | 'PUT';

type RouteRow = [
  method: ApiMethod,
  url: string,
  body: (() => object) | undefined,
  expectedStatus: number,
  assert: (body: unknown) => void,
];

const matches = (expected: () => object) => (body: unknown) => {
  expect(body).toMatchObject(expected());
};
const equals = (expected: unknown) => (body: unknown) => {
  expect(body).toEqual(expected);
};

// HTTP integration is the cheapest proof of route registration, guards, validation,
// serialization and real SQLite wiring; only the process and vendor HTTP edges are fake.
describe('API route groups', () => {
  let fixture: Awaited<ReturnType<typeof createApiTestApp>>;
  let projectId: string;
  let agentId: string;
  let statusId: string;
  let configId: string;
  let providerId: string;
  let epicId: string;
  let reviewId: string;
  let workspaceId: string;
  let connectionEpoch: number;
  const sessionId = randomUUID();

  const persisted = (table: string, expected: () => object) => (body: unknown) => {
    matches(expected)(body);
    const { id } = body as { id: string };
    expect(fixture.sqlite.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)).toEqual({ id });
  };

  async function seed(url: string, payload: object, method: ApiMethod = 'POST') {
    const response = await fixture.app.inject({ method, url, payload });
    expect({ status: response.statusCode, body: response.json() }).toMatchObject({
      status: method === 'PUT' ? 200 : 201,
    });
    return response.json();
  }

  beforeAll(async () => {
    const fetchVendor: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const payload =
        url.pathname === '/api/v2/user'
          ? { user: { id: 42, username: 'API tester' } }
          : url.pathname === '/api/v2/team'
            ? { teams: [] }
            : undefined;
      if (!payload) throw new Error(`Unexpected vendor request: ${url.pathname}`);
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      });
    };
    fixture = await createApiTestApp((builder) =>
      builder
        .overrideProvider(SafeVendorHttpClient)
        .useValue(new SafeVendorHttpClient({ fetchImpl: fetchVendor })),
    );
    const rootPath = join(fixture.rootDir, 'project');
    mkdirSync(join(rootPath, '.git'), { recursive: true });
    const templatePath = join(fixture.rootDir, 'template.json');
    writeFileSync(templatePath, JSON.stringify({ _manifest: { name: 'API fixture' } }));
    const created = await seed('/api/projects/from-template', {
      name: 'API fixture',
      rootPath,
      templatePath,
    });
    projectId = created.project.id;
    workspaceId = created.project.workspaceId;
    const profile = await seed('/api/profiles', { projectId, name: 'API profile' });
    const provider = await fixture.storage.createProvider({
      name: 'claude',
      binPath: null,
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
    });
    providerId = provider.id;
    const config = await seed(`/api/profiles/${profile.id}/provider-configs`, {
      providerId: provider.id,
      name: 'API config',
    });
    configId = config.id;
    const agent = await seed('/api/agents', {
      projectId,
      profileId: profile.id,
      providerConfigId: configId,
      name: 'API agent',
    });
    agentId = agent.id;
    const status = await seed('/api/statuses', {
      projectId,
      label: 'API status',
      color: '#123456',
      position: 99,
    });
    statusId = status.id;
    const epic = await seed('/api/epics', { projectId, title: 'API epic', statusId });
    epicId = epic.id;
    const review = await seed('/api/reviews', {
      projectId,
      title: 'API review',
      status: 'closed',
      baseRef: 'HEAD',
      headRef: 'HEAD',
    });
    reviewId = review.id;
    await seed(
      '/api/integrations/connections',
      { projectId, provider: 'clickup', token: 'fixture-token' },
      'PUT',
    );
    const connection = await fixture.storage.getIntegrationConnection({
      projectId,
      provider: 'clickup',
    });
    connectionEpoch = connection!.generation;
    await fixture.storage.createExternalTaskLink({
      epicId,
      connectionId: connection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'task-1',
      sourceSnapshot: {},
    });
    // An unattached reader session cannot block the project's import readiness check.
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions
      (id, agent_id, status, provider_name_at_launch, started_at, created_at, updated_at)
      VALUES (?, ?, 'running', 'claude', ?, ?, ?)`,
      )
      .run(
        sessionId,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
  });

  afterAll(async () => {
    await fixture?.close();
  });

  const rows: RouteRow[] = [
    ['GET', '/api/git/commits?projectId=:project', undefined, 200, equals([])],
    [
      'GET',
      '/api/git/working-tree?projectId=:project',
      undefined,
      200,
      equals({
        changes: { staged: [], unstaged: [], untracked: [] },
        diff: '',
        untrackedDiffsCapped: false,
        untrackedTotal: 0,
        untrackedProcessed: 0,
      }),
    ],
    [
      'GET',
      '/api/git/commit/abcd?projectId=:project',
      undefined,
      200,
      equals({ sha: 'abcd', diff: '', changedFiles: [] }),
    ],
    [
      'GET',
      '/api/reviews/:review',
      undefined,
      200,
      matches(() => ({ id: reviewId, projectId, title: 'API review', mode: 'working_tree' })),
    ],
    [
      'POST',
      '/api/reviews',
      () => ({ projectId, title: 'Created over HTTP', baseRef: 'HEAD', headRef: 'HEAD' }),
      201,
      persisted('reviews', () => ({ projectId, title: 'Created over HTTP', status: 'draft' })),
    ],
    ['GET', '/api/skills?projectId=:project&q=missing-fixture-skill', undefined, 200, equals([])],
    ['GET', '/api/skills/usage/stats?projectId=:project', undefined, 200, equals([])],
    [
      'GET',
      '/api/projects/:project/export',
      undefined,
      200,
      matches(() => ({
        agents: expect.arrayContaining([expect.objectContaining({ name: 'API agent' })]),
        statuses: expect.arrayContaining([expect.objectContaining({ label: 'API status' })]),
      })),
    ],
    [
      'POST',
      '/api/projects/:project/export',
      () => ({ manifest: { name: 'HTTP export' } }),
      201,
      matches(() => ({ _manifest: { name: 'HTTP export' } })),
    ],
    [
      'POST',
      '/api/projects/:project/import?dryRun=true',
      () => ({}),
      201,
      matches(() => ({ dryRun: true, readiness: { ready: true } })),
    ],
    [
      'POST',
      '/api/projects/setup-preview',
      () => ({ rawContent: { _manifest: { name: 'Preview template' } } }),
      200,
      matches(() => ({
        payload: { _manifest: { name: 'Preview template' } },
        familyAlternatives: [],
      })),
    ],
    ['GET', '/api/provider-auth', undefined, 200, equals({ items: [] })],
    [
      'GET',
      '/api/sessions/:session/transcript/summary',
      undefined,
      200,
      matches(() => ({ sessionId, providerName: 'claude', messageCount: 0, isOngoing: true })),
    ],
    [
      'GET',
      '/api/integrations/my-work/clickup?projectId=:project',
      undefined,
      200,
      matches(() => ({ provider: 'clickup', supported: true, tasks: [], workAreas: [] })),
    ],
    [
      'GET',
      '/api/integrations/my-work/clickup/tasks/task-1/estimate-log-state?projectId=:project&scopeKey=workspace-1',
      undefined,
      200,
      matches(() => ({
        initialized: false,
        revision: 0,
        loggedMinutes: 0,
        pendingDisposition: 'none',
      })),
    ],
    ['GET', '/api/e2ee/devices', undefined, 200, equals([])],
    [
      'GET',
      '/api/integrations/connections?projectId=:project',
      undefined,
      200,
      matches(() => ({
        items: expect.arrayContaining([
          expect.objectContaining({ provider: 'clickup', connected: true }),
        ]),
      })),
    ],
    [
      'GET',
      '/api/integrations/connections/directory',
      undefined,
      200,
      matches(() => ({
        items: expect.arrayContaining([
          expect.objectContaining({
            project: { id: projectId, name: 'API fixture' },
            provider: 'clickup',
            configured: true,
          }),
        ]),
        truncated: false,
      })),
    ],
    [
      'GET',
      '/api/integrations/connections/clickup/sync-health?projectId=:project',
      undefined,
      200,
      matches(() => ({
        provider: 'clickup',
        enabled: false,
        counts: { total: 0 },
        items: [],
        truncated: false,
      })),
    ],
    [
      'GET',
      '/api/preflight',
      undefined,
      200,
      matches(() => ({
        checks: expect.arrayContaining([expect.objectContaining({ name: 'tmux' })]),
        supportedMcpProviders: ['test'],
      })),
    ],
    [
      'GET',
      '/api/records?epicId=:epic',
      undefined,
      200,
      matches(() => ({ items: [], total: 0, offset: 0 })),
    ],
    [
      'POST',
      '/api/hooks/events',
      () => ({
        hookEventName: 'Stop',
        tmuxSessionName: 'api-fixture',
        projectId,
        agentId,
        sessionId,
      }),
      201,
      equals({ ok: true, handled: true, data: {} }),
    ],
    [
      'GET',
      '/api/actions',
      undefined,
      200,
      matches(() =>
        expect.arrayContaining([expect.objectContaining({ type: 'send_agent_message' })]),
      ),
    ],
    [
      'GET',
      '/api/registry/cache',
      undefined,
      200,
      matches(() => ({
        templates: [],
        totalSize: 0,
        cacheDir: expect.stringContaining(fixture.rootDir),
      })),
    ],
    [
      'GET',
      '/api/skills/community-sources',
      undefined,
      200,
      matches(() =>
        expect.arrayContaining([
          expect.objectContaining({
            name: 'jeffallan',
            repoOwner: 'jeffallan',
            repoName: 'claude-skills',
          }),
        ]),
      ),
    ],
    ['GET', '/api/skills/local-sources', undefined, 200, equals([])],
    [
      'GET',
      '/api/workspaces',
      undefined,
      200,
      matches(() => expect.arrayContaining([expect.objectContaining({ id: workspaceId })])),
    ],
    [
      'POST',
      '/api/workspaces',
      () => ({ name: '  API workspace  ' }),
      201,
      persisted('project_workspaces', () => ({ name: 'API workspace' })),
    ],
    [
      'POST',
      '/api/teams',
      () => ({ projectId, name: 'API team', teamLeadAgentId: agentId, memberAgentIds: [agentId] }),
      201,
      persisted('teams', () => ({ projectId, name: 'API team', teamLeadAgentId: agentId })),
    ],
    [
      'POST',
      '/api/watchers',
      () => ({
        projectId,
        name: 'API watcher',
        enabled: false,
        condition: { type: 'contains', pattern: 'fixture' },
        eventName: 'api.fixture',
      }),
      201,
      persisted('terminal_watchers', () => ({ projectId, name: 'API watcher', enabled: false })),
    ],
    [
      'POST',
      '/api/subscribers',
      () => ({
        projectId,
        name: 'API subscriber',
        enabled: false,
        eventName: 'api.fixture',
        actionType: 'send_agent_message',
        actionInputs: {},
      }),
      201,
      persisted('automation_subscribers', () => ({
        projectId,
        name: 'API subscriber',
        enabled: false,
      })),
    ],
    [
      'POST',
      '/api/scheduled-epics',
      () => ({
        projectId,
        name: 'API schedule',
        enabled: false,
        cronExpression: '0 0 1 1 *',
        timezone: 'UTC',
        titleTemplate: 'API scheduled epic',
        templateStatusId: statusId,
      }),
      201,
      persisted('scheduled_epics', () => ({
        projectId,
        name: 'API schedule',
        enabled: false,
        templateStatusId: statusId,
      })),
    ],
    [
      'POST',
      '/api/prompts',
      () => ({ projectId, title: 'API prompt', content: 'Fixture instructions', tags: ['system'] }),
      201,
      persisted('prompts', () => ({
        projectId,
        title: 'API prompt',
        content: 'Fixture instructions',
        tags: ['system', 'type:custom'],
      })),
    ],
    [
      'GET',
      '/api/provider-configs/:config',
      undefined,
      200,
      matches(() => ({ id: configId, name: 'API config', providerId })),
    ],
    [
      'GET',
      '/api/git/commit/abcd%3Bid?projectId=:project',
      undefined,
      400,
      matches(() => ({ code: 'http_exception' })),
    ],
    [
      'POST',
      '/api/hooks/events',
      () => ({ hookEventName: 'Stop', unexpected: true }),
      400,
      matches(() => ({ code: 'http_exception' })),
    ],
  ];

  it.each(rows)('%s %s', async (method, route, body, expectedStatus, assert) => {
    const url = route.replace(
      /:(project|agent|epic|review|session|config)\b/g,
      (_, name: string) =>
        ({
          project: projectId,
          agent: agentId,
          epic: epicId,
          review: reviewId,
          session: sessionId,
          config: configId,
        })[name]!,
    );
    const response = await fixture.app.inject({
      method,
      url,
      ...(body ? { payload: body() } : {}),
      headers: { 'x-devchain-connection-epoch': String(connectionEpoch) },
    });
    expect({
      status: response.statusCode,
      ...(response.statusCode !== expectedStatus && { body: response.json() }),
    }).toEqual({ status: expectedStatus });
    assert(response.json());
  });
});
