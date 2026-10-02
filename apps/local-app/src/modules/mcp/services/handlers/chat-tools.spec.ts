import { handleSendMessage } from './chat-tools';
import type { ChatToolContext } from './chat-context';
import type { AgentSessionContext, GuestSessionContext } from '../../dtos/mcp.dto';
import { NotFoundError } from '../../../../common/errors/error-types';
import { createNullAdapter } from './null-adapter';
import type { AgentMessageDeliveryService } from '../../../agent-message-delivery/agent-message-delivery.service';
import type { ProjectCommunicationService } from '../../../project-communication/project-communication.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_NAME = 'Agent-A';
const SESSION_ID = '00000000-0000-0000-0000-000000000003';
const GUEST_ID = '00000000-0000-0000-0000-000000000006';
const RECIPIENT_AGENT_ID = '00000000-0000-0000-0000-000000000007';
const TEAM_ID = '00000000-0000-0000-0000-000000000008';
const RECIPIENT_GUEST_ID = '00000000-0000-0000-0000-000000000009';

function makeAgentCtx(): AgentSessionContext {
  return {
    type: 'agent',
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      status: 'active',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeGuestCtx(): GuestSessionContext {
  return {
    type: 'guest',
    guest: { id: GUEST_ID, name: 'Guest-A', projectId: PROJECT_ID, tmuxSessionId: 'tmux-001' },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeCtx(
  sessionCtx: AgentSessionContext | GuestSessionContext | null = null,
  overrides: Partial<ChatToolContext> = {},
): ChatToolContext {
  return {
    storage: {
      getAgent: jest.fn().mockImplementation(async (id: string) => {
        if (id === AGENT_ID) return { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID };
        if (id === RECIPIENT_AGENT_ID)
          return { id: RECIPIENT_AGENT_ID, name: 'Agent-B', projectId: PROJECT_ID };
        throw new NotFoundError('Agent', id);
      }),
      getAgentByName: jest.fn().mockImplementation(async (_projectId: string, name: string) => {
        if (name === AGENT_NAME) return { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID };
        if (name === 'Agent-B')
          return { id: RECIPIENT_AGENT_ID, name: 'Agent-B', projectId: PROJECT_ID };
        throw new NotFoundError('Agent', name);
      }),
      getGuestByName: jest.fn().mockImplementation(async (_projectId: string, name: string) => {
        if (name === 'Guest-B') {
          return {
            id: RECIPIENT_GUEST_ID,
            name: 'Guest-B',
            projectId: PROJECT_ID,
            tmuxSessionId: 'tmux-guest-b',
          };
        }
        return null;
      }),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listGuests: jest.fn().mockResolvedValue([]),
    } as never,
    teamsService: {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
      findTeamByExactName: jest.fn().mockResolvedValue(null),
      getTeam: jest.fn().mockResolvedValue(null),
    } as never,
    agentMessageDelivery: createNullAdapter<AgentMessageDeliveryService>(
      'AgentMessageDeliveryService',
    ),
    projectCommunicationService: createNullAdapter<ProjectCommunicationService>(
      'ProjectCommunicationService',
    ),
    settingsService: {
      getMessagePoolConfigForProject: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
    } as never,
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: sessionCtx ?? makeAgentCtx(),
    }),
    ...overrides,
  };
}

describe('chat-tools handlers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleSendMessage', () => {
    it('delegates the project route before self-team fallback and maps success', async () => {
      const projectCommunicationService = {
        sendToProject: jest.fn().mockResolvedValue({
          result: {
            mode: 'project',
            targetProject: {
              id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              shortId: 'aaaaaaaa',
              name: 'Target',
            },
            deliveryStatus: 'queued',
          },
        }),
      };
      const ctx = makeCtx(null, { projectCommunicationService } as never);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientProjectId: 'aaaaaaaa',
        message: 'cross-project hello',
      });

      expect(projectCommunicationService.sendToProject).toHaveBeenCalledWith({
        callerAgentId: AGENT_ID,
        recipientProjectId: 'aaaaaaaa',
        message: 'cross-project hello',
      });
      expect(ctx.teamsService.listTeamsByAgent).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        data: {
          mode: 'project',
          targetProject: {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            shortId: 'aaaaaaaa',
            name: 'Target',
          },
          deliveryStatus: 'queued',
        },
      });
    });

    it('passes null caller context for project sends from guests', async () => {
      const projectCommunicationService = {
        sendToProject: jest.fn().mockResolvedValue({
          error: { code: 'AGENT_CONTEXT_REQUIRED', message: 'Agent required' },
        }),
      };
      const ctx = makeCtx(makeGuestCtx(), { projectCommunicationService } as never);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientProjectId: 'aaaaaaaa',
        message: 'hello',
      });

      expect(projectCommunicationService.sendToProject).toHaveBeenCalledWith(
        expect.objectContaining({ callerAgentId: null }),
      );
      expect(result).toEqual({
        success: false,
        error: { code: 'AGENT_CONTEXT_REQUIRED', message: 'Agent required' },
      });
    });

    it('returns error when session resolution fails', async () => {
      const ctx = makeCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'not found' },
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
        recipientAgentNames: ['Agent-B'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns error when no project associated', async () => {
      const sessionCtx = makeAgentCtx();
      (sessionCtx as unknown as Record<string, unknown>).project = null;
      const ctx = makeCtx(sessionCtx);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
        recipientAgentNames: ['Agent-B'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('returns NO_SELF_TEAM when sender has no teams and no explicit routing', async () => {
      const ctx = makeCtx();
      (ctx.teamsService!.listTeamsByAgent as jest.Mock).mockResolvedValue([]);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_SELF_TEAM');
    });

    it('returns AMBIGUOUS_SELF_TEAM when sender in multiple teams', async () => {
      const ctx = makeCtx();
      (ctx.teamsService!.listTeamsByAgent as jest.Mock).mockResolvedValue([
        { id: TEAM_ID, name: 'Team-A' },
        { id: '00000000-0000-0000-0000-000000000009', name: 'Team-B' },
      ]);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AMBIGUOUS_SELF_TEAM');
    });

    it('returns TEAM_NOT_FOUND when explicit team does not exist', async () => {
      const ctx = makeCtx();
      (ctx.teamsService!.findTeamByExactName as jest.Mock).mockResolvedValue(null);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        teamName: 'nonexistent',
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TEAM_NOT_FOUND');
    });

    it('returns RECIPIENT_NOT_FOUND when named agent does not exist', async () => {
      const ctx = makeCtx();
      (ctx.storage.getAgentByName as jest.Mock).mockRejectedValue(
        new NotFoundError('Agent', 'Unknown'),
      );
      (ctx.storage.getGuestByName as jest.Mock).mockResolvedValue(null);

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientAgentNames: ['Unknown'],
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RECIPIENT_NOT_FOUND');
    });

    it('classifies a deduplicated non-self explicit recipient as direct', async () => {
      const deliverAgentMessage = jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: RECIPIENT_AGENT_ID, status: 'queued' }],
      });
      const ctx = makeCtx(null, {
        agentMessageDelivery: {
          deliverAgentMessage,
        } as unknown as AgentMessageDeliveryService,
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientAgentNames: [AGENT_NAME, 'Agent-B', 'Agent-B'],
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(deliverAgentMessage).toHaveBeenCalledWith(
        [{ agentId: RECIPIENT_AGENT_ID, agentName: 'Agent-B' }],
        { routingKind: 'direct' },
        expect.objectContaining({
          kind: 'mcp.direct',
          senderAgentId: AGENT_ID,
          senderName: AGENT_NAME,
        }),
        { submitKeys: ['Enter'] },
      );
    });

    it('classifies a mixed explicit route as a group while publishing only agent descriptors', async () => {
      const deliverAgentMessage = jest.fn().mockResolvedValue({
        status: 'delivered',
        results: [{ agentId: RECIPIENT_AGENT_ID, status: 'delivered' }],
      });
      const deliverToGuest = jest.fn().mockResolvedValue({ delivered: true });
      const ctx = makeCtx(null, {
        agentMessageDelivery: {
          deliverAgentMessage,
          deliverToGuest,
          formatMessage: jest.fn().mockReturnValue('formatted'),
        } as unknown as AgentMessageDeliveryService,
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientAgentNames: ['Agent-B', 'Guest-B'],
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(deliverAgentMessage).toHaveBeenCalledWith(
        [{ agentId: RECIPIENT_AGENT_ID, agentName: 'Agent-B' }],
        { routingKind: 'group', groupKind: 'explicit' },
        expect.any(Object),
        { submitKeys: ['Enter'] },
      );
      expect(deliverToGuest).toHaveBeenCalledWith('tmux-guest-b', 'formatted', ['Enter']);
    });

    it('keeps team-to-lead routing as a team group with only the lead descriptor', async () => {
      const deliverAgentMessage = jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: RECIPIENT_AGENT_ID, status: 'queued' }],
      });
      const ctx = makeCtx(null, {
        agentMessageDelivery: {
          deliverAgentMessage,
        } as unknown as AgentMessageDeliveryService,
      });
      (ctx.teamsService.findTeamByExactName as jest.Mock).mockResolvedValue({
        id: TEAM_ID,
        name: 'Builders',
      });
      (ctx.teamsService.getTeam as jest.Mock).mockResolvedValue({
        id: TEAM_ID,
        name: 'Builders',
        teamLeadAgentId: RECIPIENT_AGENT_ID,
        members: [{ agentId: RECIPIENT_AGENT_ID }, { agentId: AGENT_ID }],
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        teamName: 'Builders',
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(deliverAgentMessage).toHaveBeenCalledWith(
        [{ agentId: RECIPIENT_AGENT_ID, agentName: 'Agent-B' }],
        {
          routingKind: 'group',
          groupKind: 'team',
          teamId: TEAM_ID,
          teamName: 'Builders',
          teamDeliveryMode: 'lead',
        },
        expect.any(Object),
        { submitKeys: ['Enter'] },
      );
    });

    it('keeps a one-recipient self-team fan-out as a team group', async () => {
      const deliverAgentMessage = jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: RECIPIENT_AGENT_ID, status: 'queued' }],
      });
      const ctx = makeCtx(null, {
        agentMessageDelivery: {
          deliverAgentMessage,
        } as unknown as AgentMessageDeliveryService,
      });
      (ctx.teamsService.listTeamsByAgent as jest.Mock).mockResolvedValue([
        { id: TEAM_ID, name: 'Builders' },
      ]);
      (ctx.teamsService.findTeamByExactName as jest.Mock).mockResolvedValue({
        id: TEAM_ID,
        name: 'Builders',
      });
      (ctx.teamsService.getTeam as jest.Mock).mockResolvedValue({
        id: TEAM_ID,
        name: 'Builders',
        teamLeadAgentId: AGENT_ID,
        members: [{ agentId: AGENT_ID }, { agentId: RECIPIENT_AGENT_ID }],
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(deliverAgentMessage).toHaveBeenCalledWith(
        [{ agentId: RECIPIENT_AGENT_ID, agentName: 'Agent-B' }],
        expect.objectContaining({
          routingKind: 'group',
          groupKind: 'team',
          teamDeliveryMode: 'lead_excluded',
        }),
        expect.any(Object),
        { submitKeys: ['Enter'] },
      );
    });

    it('makes no agent-message publication attempt for a guest-only route', async () => {
      const deliverAgentMessage = jest.fn();
      const deliver = jest.fn();
      const deliverToGuest = jest.fn().mockResolvedValue({ delivered: true });
      const ctx = makeCtx(null, {
        agentMessageDelivery: {
          deliverAgentMessage,
          deliver,
          deliverToGuest,
          formatMessage: jest.fn().mockReturnValue('formatted'),
        } as unknown as AgentMessageDeliveryService,
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientAgentNames: ['Guest-B'],
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(deliverAgentMessage).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(deliverToGuest).toHaveBeenCalledTimes(1);
    });

    it('keeps guest-sender delivery on the generic event-free path', async () => {
      const deliverAgentMessage = jest.fn();
      const deliver = jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: RECIPIENT_AGENT_ID, status: 'queued' }],
      });
      const ctx = makeCtx(makeGuestCtx(), {
        agentMessageDelivery: {
          deliverAgentMessage,
          deliver,
        } as unknown as AgentMessageDeliveryService,
      });

      const result = await handleSendMessage(ctx, {
        sessionId: SESSION_ID,
        recipientAgentNames: ['Agent-B'],
        message: 'hello',
      });

      expect(result.success).toBe(true);
      expect(deliverAgentMessage).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('does not mask storage failures as recipient-not-found errors', async () => {
      const ctx = makeCtx();
      (ctx.storage.getAgentByName as jest.Mock).mockRejectedValue(new Error('agent store offline'));

      await expect(
        handleSendMessage(ctx, {
          sessionId: SESSION_ID,
          recipientAgentNames: ['Agent-B'],
          message: 'hello',
        }),
      ).resolves.toEqual({
        success: false,
        error: { code: 'SEND_MESSAGE_FAILED', message: 'agent store offline' },
      });
      expect(ctx.storage.getGuestByName).not.toHaveBeenCalled();
    });
  });
});
