import { handleGetPrompt, handleListPrompts } from './prompt-tools';
import type { PromptToolContext } from './prompt-context';
import type { AgentSessionContext } from '../../dtos/mcp.dto';

function makeCtx(overrides: Partial<PromptToolContext> = {}): PromptToolContext {
  return {
    storage: {
      getPrompt: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
    } as unknown as PromptToolContext['storage'],
    teamsService: {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    } as unknown as PromptToolContext['teamsService'],
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: agentSession,
    }),
    ...overrides,
  };
}

const agentSession: AgentSessionContext = {
  type: 'agent',
  session: { id: 'session-1', agentId: 'agent-1', status: 'running', startedAt: '2026-01-01' },
  agent: { id: 'agent-1', name: 'Coder', projectId: 'proj-1' },
  project: { id: 'proj-1', name: 'Demo', rootPath: '/tmp' },
};

const testPrompt = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  projectId: 'proj-1',
  title: 'Hello Prompt',
  content: 'Hello {{agent_name}}, team: {{team_name}}',
  version: 1,
  tags: [],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

describe('prompt-tools', () => {
  describe('handleGetPrompt', () => {
    it('by name with sessionId: content is rendered', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: agentSession,
        }),
      });
      (ctx.storage.listPrompts as jest.Mock).mockResolvedValue({
        items: [{ id: testPrompt.id, title: testPrompt.title, version: 1, tags: [] }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(testPrompt);

      const result = await handleGetPrompt(ctx, {
        name: 'Hello Prompt',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      const prompt = (result.data as { prompt: { content: string } }).prompt;
      expect(prompt.content).toBe('Hello Coder, team: ');
    });

    it('prefers a System exact-title candidate after more than ten substring distractors', async () => {
      const systemPrompt = {
        ...testPrompt,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        content: 'system',
        tags: ['type:system'],
      };
      const items = [
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `distractor-${index}`,
          title: `Hello Prompt ${index}`,
          version: 1,
          tags: ['type:system'],
        })),
        { id: testPrompt.id, title: testPrompt.title, version: 1, tags: ['type:custom'] },
        { id: systemPrompt.id, title: systemPrompt.title, version: 1, tags: systemPrompt.tags },
      ];
      const ctx = makeCtx();
      (ctx.storage.listPrompts as jest.Mock).mockResolvedValue({
        items,
        total: items.length,
        limit: 10000,
        offset: 0,
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(systemPrompt);

      const result = await handleGetPrompt(ctx, {
        name: 'Hello Prompt',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      expect(ctx.storage.listPrompts).toHaveBeenCalledWith({
        projectId: 'proj-1',
        q: 'Hello Prompt',
        limit: 10000,
        offset: 0,
      });
      expect(ctx.storage.getPrompt).toHaveBeenCalledWith(systemPrompt.id);
    });

    it('filters version and case before System-first ranking', async () => {
      const customV2 = {
        ...testPrompt,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        version: 2,
        tags: ['type:custom'],
      };
      const ctx = makeCtx();
      (ctx.storage.listPrompts as jest.Mock).mockResolvedValue({
        items: [
          { id: 'system-v1', title: 'Hello Prompt', version: 1, tags: ['type:system'] },
          { id: 'wrong-case', title: 'hello prompt', version: 2, tags: ['type:system'] },
          {
            id: customV2.id,
            title: customV2.title,
            version: customV2.version,
            tags: customV2.tags,
          },
        ],
        total: 3,
        limit: 10000,
        offset: 0,
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(customV2);

      const result = await handleGetPrompt(ctx, {
        name: 'Hello Prompt',
        version: 2,
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      expect(ctx.storage.getPrompt).toHaveBeenCalledWith(customV2.id);
    });

    it('by id with sessionId: content is rendered', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: agentSession,
        }),
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(testPrompt);

      const result = await handleGetPrompt(ctx, {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      const prompt = (result.data as { prompt: { content: string } }).prompt;
      expect(prompt.content).toBe('Hello Coder, team: ');
    });

    it('by id without sessionId: content is raw', async () => {
      const ctx = makeCtx();
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(testPrompt);

      const result = await handleGetPrompt(ctx, { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });

      expect(result.success).toBe(true);
      const prompt = (result.data as { prompt: { content: string } }).prompt;
      expect(prompt.content).toBe('Hello {{agent_name}}, team: {{team_name}}');
    });

    it('by id with sessionId and team: team vars rendered', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: agentSession,
        }),
        teamsService: {
          listTeamsByAgent: jest.fn().mockResolvedValue([
            {
              id: 't1',
              name: 'Backend',
              teamLeadAgentId: 'agent-1',
              projectId: 'proj-1',
              description: null,
              maxMembers: 10,
              maxConcurrentTasks: 3,
              allowTeamLeadCreateAgents: false,
              createdAt: '',
              updatedAt: '',
            },
          ]),
        } as unknown as PromptToolContext['teamsService'],
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(testPrompt);

      const result = await handleGetPrompt(ctx, {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      const prompt = (result.data as { prompt: { content: string } }).prompt;
      expect(prompt.content).toBe('Hello Coder, team: Backend');
    });

    it('by id with invalid sessionId: returns session error, not raw content', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
        }),
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(testPrompt);

      const result = await handleGetPrompt(ctx, {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sessionId: 'bad-session',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });

    it('by name with invalid sessionId: returns session error (regression guard)', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
        }),
      });

      const result = await handleGetPrompt(ctx, {
        name: 'Hello Prompt',
        sessionId: 'bad-session',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });

    it('renders {{#if is_team_lead}} LEAD when agent is team lead', async () => {
      const leadPrompt = {
        ...testPrompt,
        content: '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}',
      };
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: agentSession,
        }),
        teamsService: {
          listTeamsByAgent: jest.fn().mockResolvedValue([
            {
              id: 't1',
              name: 'Backend',
              teamLeadAgentId: 'agent-1',
              projectId: 'proj-1',
              description: null,
              maxMembers: 10,
              maxConcurrentTasks: 3,
              allowTeamLeadCreateAgents: false,
              createdAt: '',
              updatedAt: '',
            },
          ]),
        } as unknown as PromptToolContext['teamsService'],
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(leadPrompt);

      const result = await handleGetPrompt(ctx, {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      const prompt = (result.data as { prompt: { content: string } }).prompt;
      expect(prompt.content).toBe('LEAD');
    });

    it('renders {{#if is_team_lead}} MEMBER when agent is not team lead', async () => {
      const leadPrompt = {
        ...testPrompt,
        content: '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}',
      };
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: agentSession,
        }),
        teamsService: {
          listTeamsByAgent: jest.fn().mockResolvedValue([
            {
              id: 't1',
              name: 'Backend',
              teamLeadAgentId: 'other-agent',
              projectId: 'proj-1',
              description: null,
              maxMembers: 10,
              maxConcurrentTasks: 3,
              allowTeamLeadCreateAgents: false,
              createdAt: '',
              updatedAt: '',
            },
          ]),
        } as unknown as PromptToolContext['teamsService'],
      });
      (ctx.storage.getPrompt as jest.Mock).mockResolvedValue(leadPrompt);

      const result = await handleGetPrompt(ctx, {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sessionId: 'session-1',
      });

      expect(result.success).toBe(true);
      const prompt = (result.data as { prompt: { content: string } }).prompt;
      expect(prompt.content).toBe('MEMBER');
    });
  });

  describe('handleListPrompts', () => {
    it('returns raw content (unchanged)', async () => {
      const ctx = makeCtx({
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: agentSession,
        }),
      });
      (ctx.storage.listPrompts as jest.Mock).mockResolvedValue({
        items: [
          {
            id: testPrompt.id,
            title: testPrompt.title,
            version: 1,
            tags: [],
            createdAt: testPrompt.createdAt,
            updatedAt: testPrompt.updatedAt,
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await handleListPrompts(ctx, { sessionId: 'session-1' });

      expect(result.success).toBe(true);
      const data = result.data as { prompts: Array<{ title: string }>; total: number };
      expect(data.prompts).toHaveLength(1);
      expect(data.prompts[0].title).toBe('Hello Prompt');
    });
  });
});
