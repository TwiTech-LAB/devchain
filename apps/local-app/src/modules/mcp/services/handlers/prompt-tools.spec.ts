import { handleGetPrompt, handleListPrompts } from './prompt-tools';
import type { McpToolContext } from './types';
import type { AgentSessionContext } from '../../dtos/mcp.dto';

function makeCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    storage: {
      getPrompt: jest.fn(),
      listPrompts: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
    } as unknown as McpToolContext['storage'],
    teamsService: {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    } as unknown as McpToolContext['teamsService'],
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
        } as unknown as McpToolContext['teamsService'],
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
