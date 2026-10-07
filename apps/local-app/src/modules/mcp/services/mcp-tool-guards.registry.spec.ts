import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { McpBindingRuntime } from '../tool-descriptors/binding-types';
import { allBindingDefinitions } from '../tool-descriptors/runtime-bindings';
import { SessionContextResolver } from './utils/session-context-resolver';
import { createMcpToolBindingRegistryFixture } from './testing/mcp-tool-binding-registry.fixture';

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_ID = '00000000-0000-0000-0000-000000000003';
const EPIC_ID = '00000000-0000-0000-0000-000000000010';
const RELATED_ID = '00000000-0000-0000-0000-000000000011';
const REVIEW_ID = '00000000-0000-0000-0000-000000000004';
const COMMENT_ID = '00000000-0000-0000-0000-000000000005';

// Records and session discovery do not resolve caller sessions. Every registered tool
// still needs a valid input here so a newly registered tool cannot silently miss the tables.
const minimalParams: Record<string, Record<string, unknown>> = {
  devchain_list_agents: { sessionId: SESSION_ID },
  devchain_get_agent_by_name: { sessionId: SESSION_ID, name: 'Coder' },
  devchain_list_statuses: { sessionId: SESSION_ID },
  devchain_send_message: {
    sessionId: SESSION_ID,
    message: 'hello',
    recipientAgentNames: ['Recipient'],
  },
  devchain_list_epics: { sessionId: SESSION_ID },
  devchain_list_assigned_epics_tasks: { sessionId: SESSION_ID, agentName: 'Coder' },
  devchain_create_epic: { sessionId: SESSION_ID, title: 'Test', statusName: 'Open' },
  devchain_get_epic_by_id: { sessionId: SESSION_ID, id: EPIC_ID },
  devchain_epic_relations_list: { sessionId: SESSION_ID, epicId: EPIC_ID },
  devchain_epic_relations_list_candidates: { sessionId: SESSION_ID, epicId: EPIC_ID },
  devchain_epic_relations_set: {
    sessionId: SESSION_ID,
    epicId: EPIC_ID,
    relatedEpicId: RELATED_ID,
    relation: 'related',
  },
  devchain_epic_relations_delete: {
    sessionId: SESSION_ID,
    epicId: EPIC_ID,
    relatedEpicId: RELATED_ID,
  },
  devchain_add_epic_comment: { sessionId: SESSION_ID, epicId: EPIC_ID, content: 'comment' },
  devchain_update_epic: { sessionId: SESSION_ID, id: EPIC_ID, version: 1, title: 'Updated' },
  devchain_delete_epic: { sessionId: SESSION_ID, id: EPIC_ID },
  devchain_projects_list: { sessionId: SESSION_ID },
  devchain_list_prompts: { sessionId: SESSION_ID },
  devchain_get_prompt: { sessionId: SESSION_ID, name: 'Default' },
  devchain_create_record: { epicId: EPIC_ID, type: 'note', data: {} },
  devchain_update_record: { id: EPIC_ID, version: 1, data: {} },
  devchain_get_record: { id: EPIC_ID },
  devchain_list_records: { epicId: EPIC_ID },
  devchain_add_tags: { id: EPIC_ID, tags: ['tag'] },
  devchain_remove_tags: { id: EPIC_ID, tags: ['tag'] },
  devchain_list_reviews: { sessionId: SESSION_ID },
  devchain_get_review: { sessionId: SESSION_ID, reviewId: REVIEW_ID },
  devchain_get_review_comments: { sessionId: SESSION_ID, reviewId: REVIEW_ID },
  devchain_reply_comment: {
    sessionId: SESSION_ID,
    reviewId: REVIEW_ID,
    parentCommentId: COMMENT_ID,
    content: 'reply',
  },
  devchain_resolve_comment: {
    sessionId: SESSION_ID,
    commentId: COMMENT_ID,
    resolution: 'resolved',
    version: 1,
  },
  devchain_apply_suggestion: { sessionId: SESSION_ID, commentId: COMMENT_ID, version: 1 },
  devchain_list_sessions: {},
  devchain_register_guest: { name: 'Guest', tmuxSessionId: 'guest-session' },
  devchain_list_skills: { sessionId: SESSION_ID },
  devchain_get_skill: { sessionId: SESSION_ID, slug: 'source/skill' },
  devchain_skills_usage_stats: { sessionId: SESSION_ID },
  devchain_skills_set_enabled: { sessionId: SESSION_ID, slugs: ['source/skill'], enabled: true },
  devchain_skills_set_source_enabled: {
    sessionId: SESSION_ID,
    sourceName: 'source',
    enabled: true,
  },
  devchain_skills_sync: { sessionId: SESSION_ID },
  devchain_teams_list: { sessionId: SESSION_ID },
  devchain_teams_members_list: { sessionId: SESSION_ID },
  devchain_teams_configs_list: { sessionId: SESSION_ID },
  devchain_teams_create_agent: { sessionId: SESSION_ID, name: 'Coder', configName: 'Default' },
  devchain_teams_delete_agent: { sessionId: SESSION_ID, name: 'Coder' },
  devchain_team: { sessionId: SESSION_ID },
};

const optionalServiceTools = new Set([
  'devchain_send_message',
  'devchain_projects_list',
  'devchain_create_epic',
  'devchain_add_epic_comment',
  'devchain_update_epic',
  'devchain_delete_epic',
  'devchain_epic_relations_set',
  'devchain_epic_relations_delete',
  'devchain_list_reviews',
  'devchain_get_review',
  'devchain_get_review_comments',
  'devchain_reply_comment',
  'devchain_resolve_comment',
  'devchain_apply_suggestion',
  'devchain_list_sessions',
  'devchain_register_guest',
  'devchain_list_skills',
  'devchain_get_skill',
  'devchain_skills_usage_stats',
  'devchain_skills_set_enabled',
  'devchain_skills_set_source_enabled',
  'devchain_skills_sync',
  'devchain_teams_list',
  'devchain_teams_members_list',
  'devchain_teams_configs_list',
  'devchain_teams_create_agent',
  'devchain_teams_delete_agent',
  'devchain_team',
]);
const agentRequiredTools = new Set([
  'devchain_teams_members_list',
  'devchain_teams_configs_list',
  'devchain_teams_create_agent',
  'devchain_teams_delete_agent',
  'devchain_skills_set_enabled',
  'devchain_skills_set_source_enabled',
  'devchain_skills_sync',
]);

function createStorage() {
  return {
    getAgent: jest.fn().mockResolvedValue({ id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID }),
    getProject: jest
      .fn()
      .mockResolvedValue({ id: PROJECT_ID, name: 'Project', rootPath: '/project' }),
    getEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Test',
      statusId: 'status',
      parentId: null,
      agentId: null,
      version: 1,
      tags: [],
    }),
    getWorkspaceEpicsByIdPrefix: jest
      .fn()
      .mockResolvedValue([{ id: RELATED_ID, projectId: PROJECT_ID }]),
    getReview: jest.fn().mockResolvedValue({ id: REVIEW_ID, projectId: PROJECT_ID }),
    getReviewComment: jest.fn().mockResolvedValue({ id: COMMENT_ID, reviewId: REVIEW_ID }),
    findStatusByName: jest.fn().mockResolvedValue({ id: 'status', label: 'Open' }),
    listStatuses: jest.fn().mockResolvedValue({ items: [] }),
    getAgentByName: jest
      .fn()
      .mockResolvedValue({ id: RELATED_ID, name: 'Recipient', projectId: PROJECT_ID }),
    getGuestByName: jest.fn().mockResolvedValue(null),
    listAgents: jest.fn().mockResolvedValue({ items: [{ id: AGENT_ID, name: 'Coder' }], total: 1 }),
  };
}

function createSessionsService(): NonNullable<McpBindingRuntime['sessionsService']> {
  return {
    listActiveSessions: jest
      .fn()
      .mockResolvedValue([{ id: SESSION_ID, agentId: AGENT_ID, status: 'running', startedAt: '' }]),
  } as unknown as NonNullable<McpBindingRuntime['sessionsService']>;
}

const rows = allBindingDefinitions.map(({ name }) => {
  const params = minimalParams[name];
  if (!params) throw new Error(`Missing guard inputs for ${name}`);
  const registry = createMcpToolBindingRegistryFixture({} as StorageService);
  const binding = registry.resolve(name)!;
  return { name, params: binding.paramsSchema?.parse(params) ?? params };
});
const sessionRows = rows.filter(({ params }) => 'sessionId' in params);
const projectRows = sessionRows.filter(
  ({ name }) => name !== 'devchain_projects_list' && name !== 'devchain_skills_sync',
);

function expectNoStorageCalls(storage: ReturnType<typeof createStorage>) {
  for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
}

describe('McpToolBindingRegistry guards', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(rows.filter(({ name }) => optionalServiceTools.has(name)))(
    '$name maps missing optional services to SERVICE_UNAVAILABLE',
    async ({ name, params }) => {
      const storage = createStorage();
      const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService, {
        ...(name === 'devchain_list_sessions' ? {} : { sessionsService: createSessionsService() }),
      });
      const result = await registry.resolve(name)!.invoke(params);
      expect(result).toEqual({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: expect.any(String) },
      });
      expect(result.error!.message.length).toBeGreaterThan(0);
    },
  );

  it.each(sessionRows)(
    '$name propagates session-not-found before domain access',
    async ({ name, params }) => {
      const failure = {
        success: false as const,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      };
      jest.spyOn(SessionContextResolver.prototype, 'resolve').mockResolvedValue(failure);
      const storage = createStorage();
      const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService);
      expect(await registry.resolve(name)!.invoke(params)).toBe(failure);
      expectNoStorageCalls(storage);
    },
  );

  it.each(projectRows)('$name rejects a session without a project', async ({ name, params }) => {
    jest.spyOn(SessionContextResolver.prototype, 'resolve').mockResolvedValue({
      success: true,
      data: {
        type: 'agent',
        session: { id: SESSION_ID, agentId: AGENT_ID, status: 'running', startedAt: '' },
        agent: { id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID },
        project: null,
      },
    });
    const storage = createStorage();
    const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService);
    expect(await registry.resolve(name)!.invoke(params)).toMatchObject({
      success: false,
      error: { code: 'PROJECT_NOT_FOUND' },
    });
    expectNoStorageCalls(storage);
  });

  it.each(
    sessionRows
      .filter(({ name }) => agentRequiredTools.has(name))
      .flatMap((row) =>
        row.name === 'devchain_skills_set_enabled'
          ? [
              { ...row, kind: 'guest' },
              { ...row, kind: 'agent without agent' },
            ]
          : [{ ...row, kind: 'guest' }],
      ),
  )('$name rejects $kind with AGENT_CONTEXT_REQUIRED', async ({ name, params, kind }) => {
    const project = { id: PROJECT_ID, name: 'Project', rootPath: '/project' };
    jest.spyOn(SessionContextResolver.prototype, 'resolve').mockResolvedValue({
      success: true,
      data:
        kind === 'guest'
          ? {
              type: 'guest',
              guest: {
                id: SESSION_ID,
                name: 'Guest',
                projectId: PROJECT_ID,
                tmuxSessionId: 'guest-session',
              },
              project,
            }
          : {
              type: 'agent',
              session: { id: SESSION_ID, agentId: null, status: 'running', startedAt: '' },
              agent: null,
              project,
            },
    });
    const storage = createStorage();
    const registry = createMcpToolBindingRegistryFixture(storage as unknown as StorageService);
    const result = await registry.resolve(name)!.invoke(params);
    expect(result).toMatchObject({ success: false, error: { code: 'AGENT_CONTEXT_REQUIRED' } });
    if (name === 'devchain_teams_members_list')
      expect(result.error?.message).toContain('Guest sessions must provide teamId');
    expectNoStorageCalls(storage);
  });
});
