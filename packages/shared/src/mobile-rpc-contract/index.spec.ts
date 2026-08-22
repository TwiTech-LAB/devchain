import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MOBILE_RPC_CATALOG,
  MOBILE_RPC_COMPATIBILITY_FACTS,
  MOBILE_RPC_CRYPTO_MODES,
  MOBILE_RPC_METHODS,
  MOBILE_RPC_PARAMS_MODES,
  getMobileRpcCryptoMode,
  getMobileRpcParamsSchema,
  getMobileRpcResultSchema,
  isMobileRpcMethod,
  type MobileRpcMethod,
  type MobileRpcParams,
  type MobileRpcResult,
} from './index.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const STATUS_ID = '22222222-2222-4222-8222-222222222222';
const EPIC_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_ID = '66666666-6666-4666-8666-666666666666';
const PROFILE_ID = '77777777-7777-4777-8777-777777777777';
const CONFIG_ID = '88888888-8888-4888-8888-888888888888';
const PROVIDER_ID = '99999999-9999-4999-8999-999999999999';
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROMPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLIENT_MESSAGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ISO = '2026-08-11T08:00:00.000Z';

const status = {
  id: STATUS_ID,
  name: 'In Progress',
  color: '#336699',
  position: 1,
};

const epic = {
  id: EPIC_ID,
  projectId: PROJECT_ID,
  title: 'Canonical contract',
  statusId: STATUS_ID,
  statusName: 'In Progress',
  statusColor: '#336699',
  statusPosition: 1,
  status,
  agentId: null,
  parentId: null,
  version: 3,
  updatedAt: ISO,
  description: null,
  createdAt: ISO,
  tags: ['mobile-rpc'],
};

const metrics = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheCreationTokens: 1,
  totalTokens: 18,
  totalContextConsumption: 18,
  compactionCount: 0,
  phaseBreakdowns: [{ phaseNumber: 1, contribution: 18, peakTokens: 18 }],
  visibleContextTokens: 10,
  totalContextTokens: 18,
  contextWindowTokens: 200_000,
  costUsd: 0.01,
  primaryModel: 'example-model',
  durationMs: 100,
  messageCount: 1,
  isOngoing: true,
};

const message = {
  id: 'message-1',
  parentId: null,
  role: 'assistant' as const,
  timestamp: ISO,
  content: [{ type: 'text' as const, text: 'Done' }],
  toolCalls: [],
  toolResults: [],
  isMeta: false,
  isSidechain: false,
};

const semanticStep = {
  id: 'step-1',
  type: 'output' as const,
  startTime: ISO,
  durationMs: 50,
  content: { outputText: 'Done' },
  context: 'main' as const,
};

const transcriptChunk = {
  id: 'chunk-1',
  type: 'ai' as const,
  startTime: ISO,
  endTime: ISO,
  messages: [message],
  metrics: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 1,
    totalTokens: 18,
    messageCount: 1,
    durationMs: 100,
    costUsd: 0.01,
  },
  semanticSteps: [semanticStep],
  turns: [
    {
      id: 'turn-1',
      assistantMessageId: 'message-1',
      timestamp: ISO,
      steps: [semanticStep],
      summary: { thinkingCount: 0, toolCallCount: 0, subagentCount: 0, outputCount: 1 },
      durationMs: 50,
      additiveTurnField: 'preserved',
    },
  ],
  additiveChunkField: { retained: true },
};

const lifecycleOperation = {
  operationId: OPERATION_ID,
  type: 'restore' as const,
  agentId: null,
  sessionId: null,
  projectId: PROJECT_ID,
  status: 'running' as const,
  createdAt: ISO,
  updatedAt: ISO,
};

const PARAM_FIXTURES = {
  'board.listWorkspaces': {},
  'board.listProjects': {},
  'board.listStatuses': { projectId: PROJECT_ID },
  'board.listParentEpics': { projectId: PROJECT_ID },
  'board.listParentChildren': { parentId: EPIC_ID },
  'board.listEpicsByStatus': { statusId: STATUS_ID },
  'board.listParentEpicsByStatus': { projectId: PROJECT_ID, statusId: STATUS_ID },
  'board.getEpicDetail': { epicId: EPIC_ID },
  'board.updateEpicAssignment': {
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    agentId: null,
    version: 3,
  },
  'board.listEpicComments': { projectId: PROJECT_ID, epicId: EPIC_ID },
  'board.addEpicComment': {
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    authorName: 'Mobile User',
    content: 'A comment',
  },
  'board.deleteEpicComment': {
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    commentId: COMMENT_ID,
  },
  'chat.listAgents': { projectId: PROJECT_ID },
  'chat.listTeams': { projectId: PROJECT_ID },
  'chat.listProfiles': { projectId: PROJECT_ID, teamId: null },
  'chat.listProfileConfigs': { projectId: PROJECT_ID, profileId: PROFILE_ID },
  'chat.createTeamAgent': {
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    name: 'Coder',
    providerConfigId: CONFIG_ID,
  },
  'chat.createIndependentAgent': {
    projectId: PROJECT_ID,
    name: 'Coder',
    profileId: PROFILE_ID,
    providerConfigId: CONFIG_ID,
  },
  'chat.deleteAgent': { projectId: PROJECT_ID, agentId: AGENT_ID },
  'chat.getTranscriptSummary': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.getTranscriptChunks': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.getTranscriptTail': { sessionId: SESSION_ID, projectId: PROJECT_ID, since: 'cursor' },
  'chat.listCustomPrompts': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.getCustomPrompt': {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    promptId: PROMPT_ID,
  },
  'chat.sendMessage': {
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    text: 'Hello',
    clientMessageId: CLIENT_MESSAGE_ID,
  },
  'chat.getPendingMessages': {
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    clientMessageIds: [CLIENT_MESSAGE_ID],
  },
  'chat.launchAgent': { agentId: AGENT_ID, projectId: PROJECT_ID },
  'chat.restartAgent': { agentId: AGENT_ID, projectId: PROJECT_ID },
  'chat.restoreSession': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.terminateSession': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.getOperationStatus': { operationId: OPERATION_ID, projectId: PROJECT_ID },
  'chat.getAgentStatus': { agentId: AGENT_ID, projectId: PROJECT_ID },
  'chat.listPendingAskQuestions': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.listSessions': { agentId: AGENT_ID, projectId: PROJECT_ID },
  'chat.deleteSessionRecord': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'chat.renameSession': { sessionId: SESSION_ID, projectId: PROJECT_ID, name: null },
  'terminal.viewport.subscribe': { sessionId: SESSION_ID, projectId: PROJECT_ID },
  'terminal.viewport.unsubscribe': { subscriptionId: 'vp-1' },
  'terminal.sendKey': { sessionId: SESSION_ID, projectId: PROJECT_ID, key: 'Enter' },
  'e2ee.adoptDeviceKey': {
    kid: 'kid',
    publicKeyB64: 'public-key',
    label: 'Alice’s iPhone',
  },
  'e2ee.revokeDeviceKey': {},
  'e2ee.bindNotificationRoutingIdentity': {
    routingKid: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
  },
} satisfies Record<MobileRpcMethod, unknown>;

const comment = {
  id: COMMENT_ID,
  epicId: EPIC_ID,
  authorName: 'Mobile User',
  content: 'A comment',
  createdAt: ISO,
  updatedAt: ISO,
};

const createdAgent = {
  id: AGENT_ID,
  name: 'Coder',
  profileId: PROFILE_ID,
  providerConfigId: CONFIG_ID,
  description: null,
  teamId: null,
};

const session = {
  id: SESSION_ID,
  epicId: null,
  agentId: AGENT_ID,
  tmuxSessionId: 'tmux-1',
  status: 'stopped' as const,
  startedAt: ISO,
  endedAt: ISO,
  name: null,
  createdAt: ISO,
  updatedAt: ISO,
};

const RESULT_FIXTURES = {
  'board.listWorkspaces': [
    {
      id: '0defa017-0000-4000-8000-000000000001',
      name: 'Default',
      isDefault: true,
      position: 0,
      projectCount: 1,
    },
  ],
  'board.listProjects': [{ id: PROJECT_ID, name: 'DevChain' }],
  'board.listStatuses': [{ status, epicCount: 1 }],
  'board.listParentEpics': {
    statuses: [status],
    items: [{ ...epic, childCount: 0, childStatusCounts: [] }],
    total: 1,
    limit: 20,
    offset: 0,
  },
  'board.listParentChildren': {
    items: [epic],
    total: 1,
    limit: 50,
    offset: 0,
    childStatusCounts: [],
  },
  'board.listEpicsByStatus': [epic],
  'board.listParentEpicsByStatus': {
    items: [{ ...epic, childCount: 0, childStatusCounts: [] }],
    total: 1,
    limit: 20,
    offset: 0,
  },
  'board.getEpicDetail': epic,
  'board.updateEpicAssignment': epic,
  'board.listEpicComments': { items: [comment], total: 1, limit: 20, offset: 0 },
  'board.addEpicComment': comment,
  'board.deleteEpicComment': { deleted: true },
  'chat.listAgents': [
    {
      id: AGENT_ID,
      name: 'Coder',
      type: 'agent',
      online: true,
      sessionId: SESSION_ID,
      activityState: 'busy',
    },
  ],
  'chat.listTeams': [
    {
      id: TEAM_ID,
      name: 'Builders',
      teamLeadAgentId: null,
      memberAgentIds: [AGENT_ID],
      memberCount: 1,
    },
  ],
  'chat.listProfiles': [{ id: PROFILE_ID, name: 'Coder', familySlug: null }],
  'chat.listProfileConfigs': [
    {
      id: CONFIG_ID,
      profileId: PROFILE_ID,
      providerId: PROVIDER_ID,
      providerName: 'codex',
      name: 'gpt',
      position: 0,
    },
  ],
  'chat.createTeamAgent': { ...createdAgent, teamId: TEAM_ID },
  'chat.createIndependentAgent': createdAgent,
  'chat.deleteAgent': { deleted: true },
  'chat.getTranscriptSummary': {
    sessionId: SESSION_ID,
    providerName: 'codex',
    metrics,
    messageCount: 1,
    isOngoing: true,
    cursor: 'cursor-1',
  },
  'chat.getTranscriptChunks': {
    chunks: [transcriptChunk],
    nextCursor: null,
    prevCursor: null,
    totalCount: 1,
  },
  'chat.getTranscriptTail': {
    kind: 'delta',
    cursor: 'cursor-2',
    replaceFromChunkId: 'chunk-1',
    replaceFromChunkIndex: 0,
    deltaChunks: [transcriptChunk],
    deltaMessages: [message],
    metrics,
    totalChunkCount: 1,
    totalMessageCount: 1,
  },
  'chat.listCustomPrompts': [{ id: PROMPT_ID, title: 'Review' }],
  'chat.getCustomPrompt': { id: PROMPT_ID, title: 'Review', content: 'Review this change.' },
  'chat.sendMessage': {
    status: 'queued',
    messageId: 'message-log-1',
    clientMessageId: CLIENT_MESSAGE_ID,
  },
  'chat.getPendingMessages': [
    {
      messageId: 'message-log-1',
      clientMessageId: CLIENT_MESSAGE_ID,
      text: 'Hello',
      status: 'queued',
      timestamp: 1_786_435_200_000,
    },
  ],
  'chat.launchAgent': { operationId: OPERATION_ID, status: 'launching' },
  'chat.restartAgent': { operationId: OPERATION_ID, status: 'restarting' },
  'chat.restoreSession': { operationId: OPERATION_ID, status: 'restoring' },
  'chat.terminateSession': { status: 'terminated' },
  'chat.getOperationStatus': lifecycleOperation,
  'chat.getAgentStatus': null,
  'chat.listPendingAskQuestions': [
    {
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Continue?',
          header: 'Decision',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue execution' }],
        },
      ],
      createdAt: 1_786_435_200_000,
      expiresAt: 1_786_437_000_000,
    },
  ],
  'chat.listSessions': {
    items: [
      {
        id: SESSION_ID,
        providerSessionId: 'provider-session',
        providerNameAtLaunch: 'codex',
        status: 'stopped',
        startedAt: ISO,
        endedAt: ISO,
        lastActivityAt: ISO,
        sizeBytes: 1024,
        transcriptAvailable: true,
        name: null,
      },
    ],
    nextCursor: null,
    hasMore: false,
    total: 1,
  },
  'chat.deleteSessionRecord': { deleted: true },
  'chat.renameSession': session,
  'terminal.viewport.subscribe': { subscriptionId: 'vp-1' },
  'terminal.viewport.unsubscribe': { ok: false },
  'terminal.sendKey': { ok: true },
  'e2ee.adoptDeviceKey': { kid: 'kid', trust: 'unverified', verifiedVia: 'email-tofu' },
  'e2ee.revokeDeviceKey': { kid: 'kid', removed: true },
  'e2ee.bindNotificationRoutingIdentity': {
    kid: 'kid',
    routingKid: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
    bound: true,
  },
} satisfies Record<MobileRpcMethod, unknown>;

describe('mobile RPC catalog', () => {
  it('contains exactly 42 methods with the canonical domain counts', () => {
    expect(MOBILE_RPC_METHODS).toHaveLength(42);
    expect(new Set(MOBILE_RPC_METHODS).size).toBe(42);
    expect(Object.keys(MOBILE_RPC_CATALOG)).toEqual(MOBILE_RPC_METHODS);

    const counts = Object.groupBy(MOBILE_RPC_METHODS, (method) => method.split('.')[0]);
    expect(counts.board).toHaveLength(12);
    expect(counts.chat).toHaveLength(24);
    expect(counts.terminal).toHaveLength(3);
    expect(counts.e2ee).toHaveLength(3);
  });

  it('has four strict params schemas and 38 passthrough schemas', () => {
    const strictMethods = MOBILE_RPC_METHODS.filter(
      (method) => MOBILE_RPC_CATALOG[method].paramsMode === MOBILE_RPC_PARAMS_MODES.strict,
    );
    expect(strictMethods).toEqual([
      'chat.listCustomPrompts',
      'chat.getCustomPrompt',
      'chat.getPendingMessages',
      'terminal.sendKey',
    ]);

    for (const method of MOBILE_RPC_METHODS) {
      const fixture = PARAM_FIXTURES[method];
      expect(getMobileRpcParamsSchema(method).safeParse(fixture).success, method).toBe(true);
      const withAdditiveField = { ...fixture, additiveField: 'retained' };
      const acceptsAdditiveField =
        getMobileRpcParamsSchema(method).safeParse(withAdditiveField).success;
      expect(acceptsAdditiveField, method).toBe(!strictMethods.includes(method));
    }

    expect(MOBILE_RPC_METHODS).toHaveLength(strictMethods.length + 38);
  });

  it('has crypto counts 39/1/2 and the exact exceptional methods', () => {
    const byMode = Object.groupBy(MOBILE_RPC_METHODS, getMobileRpcCryptoMode);
    expect(byMode[MOBILE_RPC_CRYPTO_MODES.conditionalSeal]).toHaveLength(39);
    expect(byMode[MOBILE_RPC_CRYPTO_MODES.plaintextBootstrap]).toEqual(['e2ee.adoptDeviceKey']);
    expect(byMode[MOBILE_RPC_CRYPTO_MODES.sealedOnly]).toEqual([
      'e2ee.revokeDeviceKey',
      'e2ee.bindNotificationRoutingIdentity',
    ]);
  });

  it('accepts an optional bounded adopt-device label', () => {
    const schema = getMobileRpcParamsSchema('e2ee.adoptDeviceKey');
    const base = { kid: 'kid', publicKeyB64: 'public-key' };

    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, label: 'x'.repeat(120) }).success).toBe(true);
    expect(schema.safeParse({ ...base, label: 'x'.repeat(121) }).success).toBe(false);
  });

  it('accepts a representative producer-wire fixture for every result schema', () => {
    for (const method of MOBILE_RPC_METHODS) {
      const result = getMobileRpcResultSchema(method).safeParse(RESULT_FIXTURES[method]);
      expect(result.success, method).toBe(true);
    }
  });

  it('models verified producer drift rather than stale consumer declarations', () => {
    expect(
      getMobileRpcResultSchema('chat.launchAgent').safeParse({
        operationId: OPERATION_ID,
        status: 'launching',
      }).success,
    ).toBe(true);
    expect(
      getMobileRpcResultSchema('chat.launchAgent').safeParse({
        operationId: OPERATION_ID,
        status: 'pending',
      }).success,
    ).toBe(false);

    expect(
      getMobileRpcResultSchema('chat.sendMessage').safeParse({ status: 'delivered' }).success,
    ).toBe(true);
    expect(
      getMobileRpcResultSchema('chat.sendMessage').safeParse({
        status: 'queued',
        clientMessageId: CLIENT_MESSAGE_ID,
      }).success,
    ).toBe(true);
    expect(
      getMobileRpcResultSchema('chat.getOperationStatus').safeParse(lifecycleOperation).success,
    ).toBe(true);
    expect(getMobileRpcResultSchema('chat.getAgentStatus').safeParse(null).success).toBe(true);
    expect(
      getMobileRpcResultSchema('terminal.viewport.unsubscribe').safeParse({ ok: false }).success,
    ).toBe(true);
    expect(getMobileRpcResultSchema('terminal.sendKey').safeParse({ ok: false }).success).toBe(
      false,
    );
    expect(getMobileRpcResultSchema('board.getEpicDetail').safeParse(epic).success).toBe(true);
    const epicWithJsonOmittedFields = {
      id: epic.id,
      projectId: epic.projectId,
      title: epic.title,
      statusId: epic.statusId,
      agentId: epic.agentId,
      parentId: epic.parentId,
      version: epic.version,
      updatedAt: epic.updatedAt,
      description: epic.description,
      createdAt: epic.createdAt,
      tags: epic.tags,
    };
    expect(
      getMobileRpcResultSchema('board.getEpicDetail').safeParse(epicWithJsonOmittedFields).success,
    ).toBe(true);
  });

  it('enforces the 17-value terminal key enum', () => {
    const schema = getMobileRpcParamsSchema('terminal.sendKey');
    const keys = [
      'Up',
      'Down',
      'Left',
      'Right',
      'Enter',
      'Escape',
      'Tab',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ];
    expect(keys).toHaveLength(17);
    for (const key of keys) {
      expect(schema.safeParse({ sessionId: SESSION_ID, projectId: PROJECT_ID, key }).success).toBe(
        true,
      );
    }
    expect(
      schema.safeParse({ sessionId: SESSION_ID, projectId: PROJECT_ID, key: 'Space' }).success,
    ).toBe(false);
  });

  it('retains additive fields on passthrough result objects', () => {
    const input = {
      ...epic,
      additiveTopLevel: { supported: true },
      status: { ...status, additiveNested: 'preserved' },
    };
    const parsed = getMobileRpcResultSchema('board.getEpicDetail').parse(input);
    expect(parsed).toMatchObject({
      additiveTopLevel: { supported: true },
      status: { additiveNested: 'preserved' },
    });

    const transcript = getMobileRpcResultSchema('chat.getTranscriptChunks').parse(
      RESULT_FIXTURES['chat.getTranscriptChunks'],
    );
    expect(transcript.chunks[0]).toMatchObject({
      additiveChunkField: { retained: true },
      turns: [{ additiveTurnField: 'preserved' }],
    });
  });

  it('accepts ISO transcript timestamps and rejects raw Date values at every known layer', () => {
    const schema = getMobileRpcResultSchema('chat.getTranscriptChunks');
    expect(schema.safeParse(RESULT_FIXTURES['chat.getTranscriptChunks']).success).toBe(true);

    const replacements: Array<(fixture: Record<string, unknown>) => void> = [
      (fixture) => {
        const chunks = fixture.chunks as Array<Record<string, unknown>>;
        chunks[0].startTime = new Date(ISO);
      },
      (fixture) => {
        const chunks = fixture.chunks as Array<Record<string, unknown>>;
        const messages = chunks[0].messages as Array<Record<string, unknown>>;
        messages[0].timestamp = new Date(ISO);
      },
      (fixture) => {
        const chunks = fixture.chunks as Array<Record<string, unknown>>;
        const steps = chunks[0].semanticSteps as Array<Record<string, unknown>>;
        steps[0].startTime = new Date(ISO);
      },
      (fixture) => {
        const chunks = fixture.chunks as Array<Record<string, unknown>>;
        const turns = chunks[0].turns as Array<Record<string, unknown>>;
        turns[0].timestamp = new Date(ISO);
      },
      (fixture) => {
        const chunks = fixture.chunks as Array<Record<string, unknown>>;
        const turns = chunks[0].turns as Array<Record<string, unknown>>;
        const steps = turns[0].steps as Array<Record<string, unknown>>;
        steps[0].startTime = new Date(ISO);
      },
    ];

    for (const replace of replacements) {
      const fixture = structuredClone(
        RESULT_FIXTURES['chat.getTranscriptChunks'],
      ) as unknown as Record<string, unknown>;
      replace(fixture);
      expect(schema.safeParse(fixture).success).toBe(false);
    }
  });

  it('records only the approved sparse compatibility facts', () => {
    const compatibility = Object.fromEntries(
      MOBILE_RPC_METHODS.flatMap((method) => {
        const entry = MOBILE_RPC_CATALOG[method] as {
          compatibility?: readonly string[];
        };
        return entry.compatibility ? [[method, entry.compatibility]] : [];
      }),
    );
    expect(compatibility).toEqual({
      'board.listEpicsByStatus': [MOBILE_RPC_COMPATIBILITY_FACTS.projectIdDerivedFromStatus],
      'chat.getTranscriptChunks': [
        MOBILE_RPC_COMPATIBILITY_FACTS.transcriptIsoTimestampProjection,
        MOBILE_RPC_COMPATIBILITY_FACTS.deprecatedTranscriptTurnsPreserved,
      ],
      'chat.getTranscriptTail': [
        MOBILE_RPC_COMPATIBILITY_FACTS.expiredCursorReturnsNull,
        MOBILE_RPC_COMPATIBILITY_FACTS.replaceFromChunkIdAuthoritative,
        MOBILE_RPC_COMPATIBILITY_FACTS.transcriptIsoTimestampProjection,
        MOBILE_RPC_COMPATIBILITY_FACTS.deprecatedTranscriptTurnsPreserved,
      ],
      'chat.sendMessage': [MOBILE_RPC_COMPATIBILITY_FACTS.optionalClientMessageId],
      'terminal.viewport.subscribe': [
        MOBILE_RPC_COMPATIBILITY_FACTS.viewportDimensionsIgnored,
        MOBILE_RPC_COMPATIBILITY_FACTS.viewportRequiresTunnelV2,
      ],
      'e2ee.adoptDeviceKey': [
        MOBILE_RPC_COMPATIBILITY_FACTS.nonCanonicalInstallIdKeepsAppendBehavior,
        MOBILE_RPC_COMPATIBILITY_FACTS.trustImplementationValidatesKeyAndKid,
      ],
      'e2ee.revokeDeviceKey': [
        MOBILE_RPC_COMPATIBILITY_FACTS.revokeParamsIgnored,
        MOBILE_RPC_COMPATIBILITY_FACTS.revokeIdentityFromVerifiedSenderKid,
      ],
      'e2ee.bindNotificationRoutingIdentity': [
        MOBILE_RPC_COMPATIBILITY_FACTS.bindIdentityFromVerifiedSenderKid,
      ],
    });
  });

  it('derives guards, lookups, and method-indexed public types from the catalog', () => {
    expect(isMobileRpcMethod('chat.sendMessage')).toBe(true);
    expect(isMobileRpcMethod('chat.unknown')).toBe(false);
    expect(isMobileRpcMethod(null)).toBe(false);

    expectTypeOf<MobileRpcParams<'terminal.sendKey'>['key']>().toEqualTypeOf<
      | 'Up'
      | 'Down'
      | 'Left'
      | 'Right'
      | 'Enter'
      | 'Escape'
      | 'Tab'
      | '0'
      | '1'
      | '2'
      | '3'
      | '4'
      | '5'
      | '6'
      | '7'
      | '8'
      | '9'
    >();
    expectTypeOf<MobileRpcResult<'terminal.viewport.unsubscribe'>>().toMatchTypeOf<{
      ok: boolean;
    }>();
    expectTypeOf<MobileRpcResult<'chat.getAgentStatus'>>().toMatchTypeOf<{
      agentId: string | null;
      sessionId: string | null;
    } | null>();
  });

  it('is a self-contained source with no runtime import except zod and no barrel export', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const imports = Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g), (match) => match[1]);
    expect(imports).toEqual(['zod']);

    const sharedBarrel = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(sharedBarrel).not.toContain('mobile-rpc-contract');
  });
});
