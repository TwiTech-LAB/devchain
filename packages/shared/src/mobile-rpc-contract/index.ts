import { z } from 'zod';

export const MOBILE_RPC_CRYPTO_MODES = {
  conditionalSeal: 'conditional-seal',
  plaintextBootstrap: 'plaintext-bootstrap',
  sealedOnly: 'sealed-only',
} as const;

export type MobileRpcCryptoMode =
  (typeof MOBILE_RPC_CRYPTO_MODES)[keyof typeof MOBILE_RPC_CRYPTO_MODES];

export const MOBILE_RPC_PARAMS_MODES = {
  passthrough: 'passthrough',
  strict: 'strict',
} as const;

export type MobileRpcParamsMode =
  (typeof MOBILE_RPC_PARAMS_MODES)[keyof typeof MOBILE_RPC_PARAMS_MODES];

export const MOBILE_RPC_COMPATIBILITY_FACTS = {
  projectIdDerivedFromStatus: 'project-id-derived-from-status',
  optionalClientMessageId: 'optional-client-message-id',
  expiredCursorReturnsNull: 'expired-cursor-returns-null',
  replaceFromChunkIdAuthoritative: 'replace-from-chunk-id-authoritative',
  transcriptIsoTimestampProjection: 'transcript-iso-timestamp-projection',
  deprecatedTranscriptTurnsPreserved: 'deprecated-transcript-turns-preserved',
  viewportDimensionsIgnored: 'viewport-dimensions-ignored',
  viewportRequiresTunnelV2: 'viewport-requires-tunnel-v2',
  nonCanonicalInstallIdKeepsAppendBehavior: 'non-canonical-install-id-keeps-append-behavior',
  trustImplementationValidatesKeyAndKid: 'trust-implementation-validates-key-and-kid',
  revokeParamsIgnored: 'revoke-params-ignored',
  revokeIdentityFromVerifiedSenderKid: 'revoke-identity-from-verified-sender-kid',
  bindIdentityFromVerifiedSenderKid: 'bind-identity-from-verified-sender-kid',
} as const;

export type MobileRpcCompatibilityFact =
  (typeof MOBILE_RPC_COMPATIBILITY_FACTS)[keyof typeof MOBILE_RPC_COMPATIBILITY_FACTS];

interface MobileRpcCatalogEntry {
  readonly paramsSchema: z.ZodTypeAny;
  readonly resultSchema: z.ZodTypeAny;
  readonly paramsMode: MobileRpcParamsMode;
  readonly cryptoMode: MobileRpcCryptoMode;
  readonly compatibility?: readonly MobileRpcCompatibilityFact[];
}

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });

const projectSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
  })
  .passthrough();

const projectWorkspaceSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    isDefault: z.boolean(),
    position: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    color: z.string(),
    position: z.number().int(),
  })
  .passthrough();

const statusWithCountSchema = z
  .object({
    status: statusSchema,
    epicCount: z.number().int().nonnegative(),
  })
  .passthrough();

const childStatusCountSchema = z
  .object({
    statusId: uuidSchema,
    statusName: z.string().optional(),
    statusColor: z.string().optional(),
    count: z.number().int().nonnegative(),
  })
  .passthrough();

const epicSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    title: z.string(),
    statusId: uuidSchema,
    statusName: z.string().optional(),
    statusColor: z.string().optional(),
    statusPosition: z.number().int().optional(),
    status: statusSchema.optional(),
    agentId: uuidSchema.nullable(),
    agentName: z.string().optional(),
    parentId: uuidSchema.nullable(),
    version: z.number().int().nonnegative(),
    updatedAt: isoTimestampSchema,
    description: z.string().nullable(),
    createdAt: isoTimestampSchema,
    tags: z.array(z.string()),
  })
  .passthrough();

const parentEpicSummarySchema = epicSchema.extend({
  childCount: z.number().int().nonnegative(),
  childStatusCounts: z.array(childStatusCountSchema),
});

const parentEpicsResponseSchema = z
  .object({
    statuses: z.array(statusSchema),
    items: z.array(parentEpicSummarySchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .passthrough();

const parentEpicsByStatusResponseSchema = z
  .object({
    items: z.array(parentEpicSummarySchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .passthrough();

const parentChildrenResponseSchema = z
  .object({
    items: z.array(epicSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    childStatusCounts: z.array(childStatusCountSchema),
  })
  .passthrough();

const epicCommentSchema = z
  .object({
    id: uuidSchema,
    epicId: uuidSchema,
    authorName: z.string(),
    content: z.string(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .passthrough();

const epicCommentsPageSchema = z
  .object({
    items: z.array(epicCommentSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .passthrough();

const tokenUsageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
  })
  .passthrough();

const textContentBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const thinkingContentBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

const toolCallContentBlockSchema = z
  .object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.record(z.unknown()),
  })
  .passthrough();

const toolResultContentBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
    isError: z.boolean(),
    isTruncated: z.boolean().optional(),
    fullLength: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const imageContentBlockSchema = z
  .object({
    type: z.literal('image'),
    mediaType: z.string(),
    data: z.string(),
  })
  .passthrough();

const contentBlockSchema = z.discriminatedUnion('type', [
  textContentBlockSchema,
  thinkingContentBlockSchema,
  toolCallContentBlockSchema,
  toolResultContentBlockSchema,
  imageContentBlockSchema,
]);

const unifiedToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
    isTask: z.boolean(),
    taskDescription: z.string().optional(),
    taskSubagentType: z.string().optional(),
  })
  .passthrough();

const unifiedToolResultSchema = z
  .object({
    toolCallId: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
    isError: z.boolean(),
    isTruncated: z.boolean().optional(),
    fullLength: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const serializedMessageSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    role: z.enum(['user', 'assistant', 'system']),
    timestamp: isoTimestampSchema,
    content: z.array(contentBlockSchema),
    usage: tokenUsageSchema.optional(),
    model: z.string().optional(),
    toolCalls: z.array(unifiedToolCallSchema),
    toolResults: z.array(unifiedToolResultSchema),
    isMeta: z.boolean(),
    isSidechain: z.boolean(),
    isCompactSummary: z.boolean().optional(),
    sourceToolUseId: z.string().optional(),
    stopReason: z.string().nullable().optional(),
  })
  .passthrough();

const chunkMetricsSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    totalTokens: z.number(),
    messageCount: z.number().int().nonnegative(),
    durationMs: z.number(),
    costUsd: z.number(),
  })
  .passthrough();

const semanticStepContentSchema = z
  .object({
    thinkingText: z.string().optional(),
    toolName: z.string().optional(),
    toolInput: z.record(z.unknown()).optional(),
    toolCallId: z.string().optional(),
    toolResultContent: z.union([z.string(), z.array(z.unknown())]).optional(),
    isTruncated: z.boolean().optional(),
    fullLength: z.number().int().nonnegative().optional(),
    isError: z.boolean().optional(),
    outputText: z.string().optional(),
    subagentId: z.string().optional(),
    subagentDescription: z.string().optional(),
    interruptionText: z.string().optional(),
    sourceModel: z.string().optional(),
  })
  .passthrough();

const semanticStepTokensSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cached: z.number().optional(),
  })
  .passthrough();

const semanticStepSchema = z
  .object({
    id: z.string(),
    type: z.enum(['thinking', 'tool_call', 'tool_result', 'output', 'subagent', 'interruption']),
    startTime: isoTimestampSchema,
    durationMs: z.number(),
    content: semanticStepContentSchema,
    tokens: semanticStepTokensSchema.optional(),
    estimatedTokens: z.number().optional(),
    sourceMessageId: z.string().optional(),
    context: z.enum(['main', 'subagent']),
  })
  .passthrough();

const turnSummarySchema = z
  .object({
    thinkingCount: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    subagentCount: z.number().int().nonnegative(),
    outputCount: z.number().int().nonnegative(),
  })
  .passthrough();

const deprecatedTurnSchema = z
  .object({
    id: z.string(),
    assistantMessageId: z.string(),
    model: z.string().optional(),
    timestamp: isoTimestampSchema,
    steps: z.array(semanticStepSchema),
    summary: turnSummarySchema,
    tokens: semanticStepTokensSchema.optional(),
    durationMs: z.number(),
  })
  .passthrough();

const chunkBaseShape = {
  id: z.string(),
  startTime: isoTimestampSchema,
  endTime: isoTimestampSchema,
  messages: z.array(serializedMessageSchema),
  metrics: chunkMetricsSchema,
};

const transcriptChunkSchema = z.discriminatedUnion('type', [
  z.object({ ...chunkBaseShape, type: z.literal('user') }).passthrough(),
  z
    .object({
      ...chunkBaseShape,
      type: z.literal('ai'),
      semanticSteps: z.array(semanticStepSchema),
      turns: z.array(deprecatedTurnSchema).optional(),
    })
    .passthrough(),
  z.object({ ...chunkBaseShape, type: z.literal('system') }).passthrough(),
  z.object({ ...chunkBaseShape, type: z.literal('compact') }).passthrough(),
]);

const phaseTokenBreakdownSchema = z
  .object({
    phaseNumber: z.number().int(),
    contribution: z.number(),
    peakTokens: z.number(),
    postCompaction: z.number().optional(),
    compactionMessageId: z.string().optional(),
  })
  .passthrough();

const unifiedMetricsSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    totalTokens: z.number(),
    totalContextConsumption: z.number(),
    compactionCount: z.number().int().nonnegative(),
    phaseBreakdowns: z.array(phaseTokenBreakdownSchema),
    visibleContextTokens: z.number(),
    totalContextTokens: z.number(),
    contextWindowTokens: z.number(),
    contextBreakdown: z
      .object({
        system: z.number(),
        conversation: z.number(),
        toolDefinitions: z.number(),
      })
      .passthrough()
      .optional(),
    costUsd: z.number(),
    nativeCost: z.number().optional(),
    primaryModel: z.string(),
    modelsUsed: z.array(z.string()).optional(),
    durationMs: z.number(),
    messageCount: z.number().int().nonnegative(),
    isOngoing: z.boolean(),
  })
  .passthrough();

type UnifiedMetricsWire = z.output<typeof unifiedMetricsSchema>;
type TranscriptChunkWire = z.output<typeof transcriptChunkSchema>;
type SerializedMessageWire = z.output<typeof serializedMessageSchema>;

interface TranscriptSummaryWithCursorWire {
  readonly [key: string]: unknown;
  sessionId: string;
  providerName: string;
  metrics: UnifiedMetricsWire;
  messageCount: number;
  isOngoing: boolean;
  cursor: string;
}

interface UnifiedChunkedResponseWire {
  readonly [key: string]: unknown;
  chunks: TranscriptChunkWire[];
  nextCursor: string | null;
  prevCursor: string | null;
  totalCount: number;
}

interface TranscriptTailDeltaWire {
  readonly [key: string]: unknown;
  kind: 'delta';
  cursor: string;
  replaceFromChunkId: string | null;
  replaceFromChunkIndex: number;
  deltaChunks: TranscriptChunkWire[];
  deltaMessages: SerializedMessageWire[];
  metrics: UnifiedMetricsWire;
  totalChunkCount: number;
  totalMessageCount: number;
}

const transcriptSummaryWithCursorSchema: z.ZodType<TranscriptSummaryWithCursorWire> = z
  .object({
    sessionId: uuidSchema,
    providerName: z.string(),
    metrics: unifiedMetricsSchema,
    messageCount: z.number().int().nonnegative(),
    isOngoing: z.boolean(),
    cursor: z.string().min(1),
  })
  .passthrough();

const unifiedChunkedResponseSchema: z.ZodType<UnifiedChunkedResponseWire> = z
  .object({
    chunks: z.array(transcriptChunkSchema),
    nextCursor: z.string().nullable(),
    prevCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative(),
  })
  .passthrough();

const transcriptSourceChangeKindSchema = z.enum([
  'cache-hit',
  'same-file-append',
  'file-replacement',
  'file-truncation',
  'same-file-rewrite',
  'db-update',
  'unknown-full-parse',
]);

const transcriptTailDeltaSchema: z.ZodType<TranscriptTailDeltaWire> = z
  .object({
    kind: z.literal('delta'),
    cursor: z.string().min(1),
    replaceFromChunkId: z.string().nullable(),
    replaceFromChunkIndex: z.number().int().nonnegative(),
    deltaChunks: z.array(transcriptChunkSchema),
    deltaMessages: z.array(serializedMessageSchema),
    metrics: unifiedMetricsSchema,
    totalChunkCount: z.number().int().nonnegative(),
    totalMessageCount: z.number().int().nonnegative(),
  })
  .passthrough();

const transcriptTailFullRefetchSchema = z
  .object({
    kind: z.literal('full-refetch-required'),
    sourceChangeKind: transcriptSourceChangeKindSchema,
  })
  .passthrough();

type TranscriptTailResponseWire =
  | z.output<typeof transcriptTailDeltaSchema>
  | z.output<typeof transcriptTailFullRefetchSchema>
  | null;

const transcriptTailResponseSchema: z.ZodType<TranscriptTailResponseWire> = z
  .union([transcriptTailDeltaSchema, transcriptTailFullRefetchSchema])
  .nullable();

const mobileChatAgentSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    type: z.literal('agent'),
    profileName: z.string().optional(),
    providerName: z.string().optional(),
    providerConfigName: z.string().optional(),
    online: z.boolean(),
    sessionId: uuidSchema.optional(),
    activityState: z.enum(['idle', 'busy']).nullable().optional(),
    latestMessageCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const mobileChatTeamSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    teamLeadAgentId: uuidSchema.nullable(),
    memberAgentIds: z.array(uuidSchema),
    memberCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const mobileChatProfileSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    familySlug: z.string().nullable().optional(),
  })
  .passthrough();

const mobileChatProviderConfigSchema = z
  .object({
    id: uuidSchema,
    profileId: uuidSchema,
    providerId: uuidSchema,
    providerName: z.string().optional(),
    name: z.string(),
    position: z.number().int(),
  })
  .passthrough();

const mobileChatCreatedAgentSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    profileId: uuidSchema,
    providerConfigId: uuidSchema,
    description: z.string().nullable(),
    teamId: uuidSchema.nullable(),
  })
  .passthrough();

const customPromptSummarySchema = z
  .object({
    id: uuidSchema,
    title: z.string(),
  })
  .passthrough();

const customPromptDetailSchema = customPromptSummarySchema.extend({ content: z.string() });

const sendMessageResultSchema = z
  .object({
    status: z.enum(['queued', 'delivered']),
    messageId: z.string().optional(),
    clientMessageId: uuidSchema.optional(),
  })
  .passthrough();

const pendingMobileMessageSchema = z
  .object({
    messageId: z.string(),
    clientMessageId: uuidSchema,
    text: z.string(),
    status: z.enum(['queued', 'delivered', 'failed', 'unconfirmed']),
    timestamp: z.number(),
    deliveredAt: z.number().optional(),
    failureCode: z
      .enum([
        'paste_not_confirmed',
        'no_active_session',
        'project_delivery_failed',
        'send_keys_failed',
        'tmux_error',
      ])
      .optional(),
  })
  .passthrough();

const lifecycleStartResultSchema = z
  .object({
    operationId: uuidSchema,
    status: z.enum(['launching', 'restarting', 'restoring']),
  })
  .passthrough();

const lifecycleOperationSchema = z
  .object({
    operationId: uuidSchema,
    type: z.enum(['launch', 'restart', 'restore']),
    agentId: uuidSchema.nullable(),
    sessionId: uuidSchema.nullable(),
    projectId: uuidSchema,
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .passthrough();

const askUserQuestionOptionSchema = z
  .object({
    label: z.string().min(1),
    description: z.string(),
  })
  .passthrough();

const askUserQuestionSchema = z
  .object({
    question: z.string().min(1),
    header: z.string().min(1),
    multiSelect: z.boolean(),
    options: z.array(askUserQuestionOptionSchema).min(1),
  })
  .passthrough();

const pendingAskUserQuestionSchema = z
  .object({
    toolUseId: z.string().min(1),
    questions: z.array(askUserQuestionSchema).min(1),
    createdAt: z.number(),
    expiresAt: z.number(),
  })
  .passthrough();

const sessionHistoryItemSchema = z
  .object({
    id: uuidSchema,
    providerSessionId: z.string().nullable(),
    providerNameAtLaunch: z.string().nullable(),
    status: z.enum(['stopped', 'failed']),
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
    lastActivityAt: isoTimestampSchema.nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    transcriptAvailable: z.boolean(),
    name: z.string().nullable(),
  })
  .passthrough();

const sessionHistoryResponseSchema = z
  .object({
    items: z.array(sessionHistoryItemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number().int().nonnegative(),
  })
  .passthrough();

const sessionSchema = z
  .object({
    id: uuidSchema,
    epicId: uuidSchema.nullable(),
    agentId: uuidSchema.nullable(),
    tmuxSessionId: z.string().nullable(),
    providerSessionId: z.string().nullable().optional(),
    providerNameAtLaunch: z.string().nullable().optional(),
    status: z.enum(['running', 'stopped', 'failed']),
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
    lastActivityAt: isoTimestampSchema.nullable().optional(),
    activityState: z.enum(['idle', 'busy']).nullable().optional(),
    busySince: isoTimestampSchema.nullable().optional(),
    transcriptPath: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .passthrough();

const deviceTrustResultSchema = z
  .object({
    kid: z.string().min(1),
    trust: z.enum(['unverified', 'verified', 'revoked']),
    verifiedVia: z.enum(['qr', 'email-tofu', 'safety-number']).optional(),
  })
  .passthrough();

const conditionalSeal = MOBILE_RPC_CRYPTO_MODES.conditionalSeal;
const plaintextBootstrap = MOBILE_RPC_CRYPTO_MODES.plaintextBootstrap;
const sealedOnly = MOBILE_RPC_CRYPTO_MODES.sealedOnly;
const passthrough = MOBILE_RPC_PARAMS_MODES.passthrough;
const strict = MOBILE_RPC_PARAMS_MODES.strict;
const facts = MOBILE_RPC_COMPATIBILITY_FACTS;

const boardCatalog = {
  'board.listWorkspaces': {
    paramsSchema: z.object({}).passthrough(),
    resultSchema: z.array(projectWorkspaceSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.listProjects': {
    paramsSchema: z.object({ workspaceId: uuidSchema.optional() }).passthrough(),
    resultSchema: z.array(projectSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.listStatuses': {
    paramsSchema: z.object({ projectId: uuidSchema }).passthrough(),
    resultSchema: z.array(statusWithCountSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.listParentEpics': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        type: z.enum(['active', 'archived', 'all']).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        limitPerParent: z.number().int().positive().optional(),
      })
      .passthrough(),
    resultSchema: parentEpicsResponseSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.listParentChildren': {
    paramsSchema: z
      .object({
        parentId: uuidSchema,
        statusId: uuidSchema.optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
    resultSchema: parentChildrenResponseSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.listEpicsByStatus': {
    paramsSchema: z
      .object({
        statusId: uuidSchema,
        projectId: uuidSchema.optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
    resultSchema: z.array(epicSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
    compatibility: [facts.projectIdDerivedFromStatus],
  },
  'board.listParentEpicsByStatus': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        statusId: uuidSchema,
        type: z.enum(['active', 'archived', 'all']).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
    resultSchema: parentEpicsByStatusResponseSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.getEpicDetail': {
    paramsSchema: z.object({ epicId: uuidSchema }).passthrough(),
    resultSchema: epicSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.updateEpicAssignment': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        epicId: uuidSchema,
        agentId: uuidSchema.nullable(),
        version: z.number().int().nonnegative(),
      })
      .passthrough(),
    resultSchema: epicSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.listEpicComments': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        epicId: uuidSchema,
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .passthrough(),
    resultSchema: epicCommentsPageSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.addEpicComment': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        epicId: uuidSchema,
        authorName: z.string().trim().min(1),
        content: z.string().trim().min(1),
      })
      .passthrough(),
    resultSchema: epicCommentSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'board.deleteEpicComment': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        epicId: uuidSchema,
        commentId: uuidSchema,
      })
      .passthrough(),
    resultSchema: z.object({ deleted: z.literal(true) }).passthrough(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
} as const satisfies Record<string, MobileRpcCatalogEntry>;

const chatReadCatalog = {
  'chat.listAgents': {
    paramsSchema: z.object({ projectId: uuidSchema }).passthrough(),
    resultSchema: z.array(mobileChatAgentSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.listTeams': {
    paramsSchema: z.object({ projectId: uuidSchema }).passthrough(),
    resultSchema: z.array(mobileChatTeamSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.listProfiles': {
    paramsSchema: z.object({ projectId: uuidSchema, teamId: uuidSchema.nullish() }).passthrough(),
    resultSchema: z.array(mobileChatProfileSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.listProfileConfigs': {
    paramsSchema: z.object({ projectId: uuidSchema, profileId: uuidSchema }).passthrough(),
    resultSchema: z.array(mobileChatProviderConfigSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.createTeamAgent': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        teamId: uuidSchema,
        name: z.string().trim().min(1),
        providerConfigId: uuidSchema,
        description: z.string().optional(),
      })
      .passthrough(),
    resultSchema: mobileChatCreatedAgentSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.createIndependentAgent': {
    paramsSchema: z
      .object({
        projectId: uuidSchema,
        name: z.string().trim().min(1),
        profileId: uuidSchema,
        providerConfigId: uuidSchema,
        description: z.string().optional(),
      })
      .passthrough(),
    resultSchema: mobileChatCreatedAgentSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.deleteAgent': {
    paramsSchema: z.object({ projectId: uuidSchema, agentId: uuidSchema }).passthrough(),
    resultSchema: z.object({ deleted: z.literal(true) }).passthrough(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.getTranscriptSummary': {
    paramsSchema: z.object({ sessionId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: transcriptSummaryWithCursorSchema as z.ZodType<TranscriptSummaryWithCursorWire>,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.getTranscriptChunks': {
    paramsSchema: z
      .object({
        sessionId: uuidSchema,
        projectId: uuidSchema,
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        direction: z.enum(['forward', 'backward']).optional(),
      })
      .passthrough(),
    resultSchema: unifiedChunkedResponseSchema as z.ZodType<UnifiedChunkedResponseWire>,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
    compatibility: [
      facts.transcriptIsoTimestampProjection,
      facts.deprecatedTranscriptTurnsPreserved,
    ],
  },
  'chat.getTranscriptTail': {
    paramsSchema: z
      .object({ sessionId: uuidSchema, projectId: uuidSchema, since: z.string().min(1) })
      .passthrough(),
    resultSchema: transcriptTailResponseSchema as z.ZodType<TranscriptTailResponseWire>,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
    compatibility: [
      facts.expiredCursorReturnsNull,
      facts.replaceFromChunkIdAuthoritative,
      facts.transcriptIsoTimestampProjection,
      facts.deprecatedTranscriptTurnsPreserved,
    ],
  },
} as const satisfies Record<string, MobileRpcCatalogEntry>;

const chatActionCatalog = {
  'chat.listCustomPrompts': {
    paramsSchema: z.object({ sessionId: uuidSchema, projectId: uuidSchema }).strict(),
    resultSchema: z.array(customPromptSummarySchema),
    paramsMode: strict,
    cryptoMode: conditionalSeal,
  },
  'chat.getCustomPrompt': {
    paramsSchema: z
      .object({ sessionId: uuidSchema, projectId: uuidSchema, promptId: uuidSchema })
      .strict(),
    resultSchema: customPromptDetailSchema,
    paramsMode: strict,
    cryptoMode: conditionalSeal,
  },
  'chat.sendMessage': {
    paramsSchema: z
      .object({
        agentId: uuidSchema,
        projectId: uuidSchema,
        text: z.string().trim().min(1),
        clientMessageId: uuidSchema.optional(),
      })
      .passthrough(),
    resultSchema: sendMessageResultSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
    compatibility: [facts.optionalClientMessageId],
  },
  'chat.getPendingMessages': {
    paramsSchema: z
      .object({
        agentId: uuidSchema,
        projectId: uuidSchema,
        clientMessageIds: z.array(uuidSchema).min(1).max(50),
      })
      .strict(),
    resultSchema: z.array(pendingMobileMessageSchema),
    paramsMode: strict,
    cryptoMode: conditionalSeal,
  },
  'chat.launchAgent': {
    paramsSchema: z.object({ agentId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: lifecycleStartResultSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.restartAgent': {
    paramsSchema: z.object({ agentId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: lifecycleStartResultSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.restoreSession': {
    paramsSchema: z.object({ sessionId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: lifecycleStartResultSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.terminateSession': {
    paramsSchema: z.object({ sessionId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: z.object({ status: z.literal('terminated') }).passthrough(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.getOperationStatus': {
    paramsSchema: z.object({ operationId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: lifecycleOperationSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.getAgentStatus': {
    paramsSchema: z.object({ agentId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: lifecycleOperationSchema.nullable(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.listPendingAskQuestions': {
    paramsSchema: z.object({ sessionId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: z.array(pendingAskUserQuestionSchema),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.listSessions': {
    paramsSchema: z
      .object({
        agentId: uuidSchema,
        projectId: uuidSchema,
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .passthrough(),
    resultSchema: sessionHistoryResponseSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.deleteSessionRecord': {
    paramsSchema: z.object({ sessionId: uuidSchema, projectId: uuidSchema }).passthrough(),
    resultSchema: z.object({ deleted: z.boolean() }).passthrough(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'chat.renameSession': {
    paramsSchema: z
      .object({
        sessionId: uuidSchema,
        projectId: uuidSchema,
        name: z.string().trim().max(120).nullable(),
      })
      .passthrough(),
    resultSchema: sessionSchema,
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
} as const satisfies Record<string, MobileRpcCatalogEntry>;

const terminalCatalog = {
  'terminal.viewport.subscribe': {
    paramsSchema: z
      .object({
        sessionId: uuidSchema,
        projectId: uuidSchema,
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
      })
      .passthrough(),
    resultSchema: z.object({ subscriptionId: z.string().min(1) }).passthrough(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
    compatibility: [facts.viewportDimensionsIgnored, facts.viewportRequiresTunnelV2],
  },
  'terminal.viewport.unsubscribe': {
    paramsSchema: z.object({ subscriptionId: z.string().min(1) }).passthrough(),
    resultSchema: z.object({ ok: z.boolean() }).passthrough(),
    paramsMode: passthrough,
    cryptoMode: conditionalSeal,
  },
  'terminal.sendKey': {
    paramsSchema: z
      .object({
        sessionId: uuidSchema,
        projectId: uuidSchema,
        key: z.enum([
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
        ]),
      })
      .strict(),
    resultSchema: z.object({ ok: z.literal(true) }).passthrough(),
    paramsMode: strict,
    cryptoMode: conditionalSeal,
  },
} as const satisfies Record<string, MobileRpcCatalogEntry>;

const e2eeCatalog = {
  'e2ee.adoptDeviceKey': {
    paramsSchema: z
      .object({
        kid: z.string().min(1),
        publicKeyB64: z.string().min(1),
        installId: z.string().max(100).optional(),
        label: z.string().max(120).optional(),
      })
      .passthrough(),
    resultSchema: deviceTrustResultSchema,
    paramsMode: passthrough,
    cryptoMode: plaintextBootstrap,
    compatibility: [
      facts.nonCanonicalInstallIdKeepsAppendBehavior,
      facts.trustImplementationValidatesKeyAndKid,
    ],
  },
  'e2ee.revokeDeviceKey': {
    paramsSchema: z.object({}).passthrough(),
    resultSchema: z
      .object({
        kid: z.string().min(1),
        removed: z.boolean(),
      })
      .passthrough(),
    paramsMode: passthrough,
    cryptoMode: sealedOnly,
    compatibility: [facts.revokeParamsIgnored, facts.revokeIdentityFromVerifiedSenderKid],
  },
  'e2ee.bindNotificationRoutingIdentity': {
    // RFC 7638 JWK thumbprint of the mobile notification routing key: 32-byte
    // SHA-256 digest, base64url-unpadded (43 chars).
    paramsSchema: z.object({ routingKid: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).passthrough(),
    resultSchema: z
      .object({
        kid: z.string().min(1),
        routingKid: z.string().min(1),
        bound: z.boolean(),
      })
      .passthrough(),
    paramsMode: passthrough,
    cryptoMode: sealedOnly,
    compatibility: [facts.bindIdentityFromVerifiedSenderKid],
  },
} as const satisfies Record<string, MobileRpcCatalogEntry>;

export const MOBILE_RPC_CATALOG: typeof boardCatalog &
  typeof chatReadCatalog &
  typeof chatActionCatalog &
  typeof terminalCatalog &
  typeof e2eeCatalog = {
  ...boardCatalog,
  ...chatReadCatalog,
  ...chatActionCatalog,
  ...terminalCatalog,
  ...e2eeCatalog,
};

export type MobileRpcMethod = keyof typeof MOBILE_RPC_CATALOG;

export const MOBILE_RPC_METHODS = [
  'board.listWorkspaces',
  'board.listProjects',
  'board.listStatuses',
  'board.listParentEpics',
  'board.listParentChildren',
  'board.listEpicsByStatus',
  'board.listParentEpicsByStatus',
  'board.getEpicDetail',
  'board.updateEpicAssignment',
  'board.listEpicComments',
  'board.addEpicComment',
  'board.deleteEpicComment',
  'chat.listAgents',
  'chat.listTeams',
  'chat.listProfiles',
  'chat.listProfileConfigs',
  'chat.createTeamAgent',
  'chat.createIndependentAgent',
  'chat.deleteAgent',
  'chat.getTranscriptSummary',
  'chat.getTranscriptChunks',
  'chat.getTranscriptTail',
  'chat.listCustomPrompts',
  'chat.getCustomPrompt',
  'chat.sendMessage',
  'chat.getPendingMessages',
  'chat.launchAgent',
  'chat.restartAgent',
  'chat.restoreSession',
  'chat.terminateSession',
  'chat.getOperationStatus',
  'chat.getAgentStatus',
  'chat.listPendingAskQuestions',
  'chat.listSessions',
  'chat.deleteSessionRecord',
  'chat.renameSession',
  'terminal.viewport.subscribe',
  'terminal.viewport.unsubscribe',
  'terminal.sendKey',
  'e2ee.adoptDeviceKey',
  'e2ee.revokeDeviceKey',
  'e2ee.bindNotificationRoutingIdentity',
] as const satisfies readonly MobileRpcMethod[];

export type MobileRpcParams<M extends MobileRpcMethod> = z.input<
  (typeof MOBILE_RPC_CATALOG)[M]['paramsSchema']
>;

export type MobileRpcResult<M extends MobileRpcMethod> = z.output<
  (typeof MOBILE_RPC_CATALOG)[M]['resultSchema']
>;

export function isMobileRpcMethod(value: unknown): value is MobileRpcMethod {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(MOBILE_RPC_CATALOG, value)
  );
}

export function getMobileRpcCryptoMode<M extends MobileRpcMethod>(
  method: M,
): (typeof MOBILE_RPC_CATALOG)[M]['cryptoMode'] {
  return MOBILE_RPC_CATALOG[method].cryptoMode;
}

export function getMobileRpcParamsSchema<M extends MobileRpcMethod>(
  method: M,
): (typeof MOBILE_RPC_CATALOG)[M]['paramsSchema'] {
  return MOBILE_RPC_CATALOG[method].paramsSchema;
}

export function getMobileRpcResultSchema<M extends MobileRpcMethod>(
  method: M,
): (typeof MOBILE_RPC_CATALOG)[M]['resultSchema'] {
  return MOBILE_RPC_CATALOG[method].resultSchema;
}
