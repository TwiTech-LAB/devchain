import { handleSendMessage } from './chat-tools';
import { handleGetAgentByName } from './agent-tools';
import type { McpResponse } from '../../dtos/mcp.dto';
import { missingSessionResolver } from '../utils/session-context-helpers';
import { createNullAdapter } from './null-adapter';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import type { AgentMessageDeliveryService } from '../../../agent-message-delivery/agent-message-delivery.service';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';
import type { InstructionsResolver } from '../instructions-resolver';
import type { ProjectCommunicationService } from '../../../project-communication/project-communication.service';
import type { ChatToolContext } from './chat-context';
import type { AgentToolContext } from './agent-context';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_ID = '00000000-0000-0000-0000-000000000003';

function makeAgentSessionCtx() {
  return {
    type: 'agent' as const,
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      status: 'active',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: AGENT_ID, name: 'Test Agent', projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function resolveToAgent() {
  return jest.fn().mockResolvedValue({ success: true, data: makeAgentSessionCtx() });
}

function assertServiceUnavailable(result: McpResponse, expectedMessageSubstring?: string) {
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.error!.code).toBe('SERVICE_UNAVAILABLE');
  expect(typeof result.error!.message).toBe('string');
  expect(result.error!.message.length).toBeGreaterThan(0);
  if (expectedMessageSubstring) {
    expect(result.error!.message).toContain(expectedMessageSubstring);
  }
}

function storageWithAgent(): Record<string, jest.Mock> {
  return {
    getAgent: jest
      .fn()
      .mockResolvedValue({ id: AGENT_ID, name: 'Test Agent', projectId: PROJECT_ID }),
    getAgentByName: jest.fn().mockResolvedValue({
      id: AGENT_ID,
      name: 'Test Agent',
      profileId: null,
      description: null,
      projectId: PROJECT_ID,
    }),
    listAgents: jest
      .fn()
      .mockResolvedValue({ items: [{ id: AGENT_ID, name: 'Test Agent' }], total: 1 }),
    listGuests: jest.fn().mockResolvedValue([]),
    listStatuses: jest.fn().mockResolvedValue({ items: [] }),
    getGuestByName: jest.fn().mockResolvedValue(null),
  };
}

function createNullChatContext(overrides: Partial<ChatToolContext> = {}): ChatToolContext {
  return {
    storage: createNullAdapter('StorageService'),
    teamsService: createNullAdapter<TeamsService>('TeamsService'),
    agentMessageDelivery: createNullAdapter<AgentMessageDeliveryService>(
      'AgentMessageDeliveryService',
    ),
    settingsService: createNullAdapter<SettingsService>('SettingsService'),
    projectCommunicationService: createNullAdapter<ProjectCommunicationService>(
      'ProjectCommunicationService',
    ),
    resolveSessionContext: () => Promise.resolve(missingSessionResolver()),
    ...overrides,
  };
}

describe('session-context-helpers: missingSessionResolver', () => {
  it('returns SERVICE_UNAVAILABLE with standalone MCP message', () => {
    const result = missingSessionResolver();
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('has the canonical response shape { success, error: { code, message } }', () => {
    const result = missingSessionResolver();
    expect(result).toEqual({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: expect.any(String),
      },
    });
  });
});

describe('chat-tools SERVICE_UNAVAILABLE', () => {
  it('handleSendMessage: teamsService missing (team routing path)', async () => {
    const ctx: ChatToolContext = createNullChatContext({
      storage: storageWithAgent() as never,
      resolveSessionContext: resolveToAgent(),
    });
    const result = await handleSendMessage(ctx, {
      sessionId: SESSION_ID,
      message: 'hi',
      teamName: 'MyTeam',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleSendMessage: agentMessageDelivery missing (agent recipient path)', async () => {
    const storage = storageWithAgent();
    storage.getAgentByName.mockResolvedValue({ id: 'r1', name: 'Agent-B', projectId: PROJECT_ID });
    const ctx: ChatToolContext = createNullChatContext({
      storage: storage as never,
      resolveSessionContext: resolveToAgent(),
    });
    const result = await handleSendMessage(ctx, {
      sessionId: SESSION_ID,
      message: 'hi',
      recipientAgentNames: ['Agent-B'],
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });
});

describe('agent-tools SERVICE_UNAVAILABLE', () => {
  it('handleGetAgentByName: instructionsResolver is null adapter', async () => {
    const storage = {
      ...storageWithAgent(),
      getAgentByName: jest.fn().mockResolvedValue({
        id: AGENT_ID,
        name: 'Test Agent',
        profileId: 'profile-1',
        description: null,
        projectId: PROJECT_ID,
        profile: { id: 'profile-1', name: 'Default', instructions: 'system prompt' },
      }),
    };
    const ctx: AgentToolContext = {
      storage: storage as never,
      sessionsService: createNullAdapter<SessionsService>('SessionsService'),
      terminalIO: createNullAdapter<TerminalIOService>('TerminalIOService'),
      instructionsResolver: createNullAdapter<InstructionsResolver>(
        'InstructionsResolver',
      ) as never,
      teamsService: createNullAdapter<TeamsService>('TeamsService'),
      defaultInlineMaxBytes: 64 * 1024,
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: 'Test Agent' });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });
});
