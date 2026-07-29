import { MobileChatRpcService } from './mobile-chat-rpc.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import type { SessionReaderService } from '../../session-reader/services/session-reader.service';
import type { TranscriptWatcherService } from '../../session-reader/services/transcript-watcher.service';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { SessionsMessageLogReadFacade } from '../../sessions/services/sessions-message-log-read.facade';
import type { SessionLifecycleFacade } from '../../sessions/services/session-lifecycle-facade.service';
import type { TeamsService } from '../../teams/services/teams.service';
import type { PendingAskUserQuestionService } from '../../hooks/services/pending-ask-user-question.service';
import { LifecycleOperationTracker } from './lifecycle-operation-tracker';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors/error-types';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE_CODER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROFILE_REVIEWER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONFIG_CLAUDE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CONFIG_CODEX = '99999999-9999-4999-8999-999999999999';
const PROVIDER_CLAUDE = '12121212-1212-4212-8212-121212121212';
const PROVIDER_CODEX = '13131313-1313-4313-8313-131313131313';

function agent(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: AGENT_A,
    projectId: PROJECT_ID,
    profileId: PROFILE_CODER,
    providerConfigId: CONFIG_CLAUDE,
    modelOverride: null,
    name: 'Coder',
    description: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function activeSession(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    sessionId: SESSION_A,
    agentId: AGENT_A,
    projectId: PROJECT_ID,
    status: 'running',
    tmuxSessionId: 'tmux-1',
    startedAt: '2026-06-02T00:00:00.000Z',
    lastActivityAt: '2026-06-02T01:00:00.000Z',
    activityState: 'busy',
    name: 'sess',
    ...over,
  };
}

function build(overrides: {
  storage?: Partial<StorageService>;
  activeSessions?: Partial<ActiveSessionLookup>;
  sessionReader?: Partial<SessionReaderService>;
  transcriptWatcher?: Partial<TranscriptWatcherService>;
  agentMessageDelivery?: Partial<AgentMessageDeliveryService>;
  messageLogRead?: Partial<SessionsMessageLogReadFacade>;
  sessionLifecycle?: Partial<SessionLifecycleFacade>;
  teamsService?: Partial<TeamsService>;
  pendingAskUserQuestion?: Partial<PendingAskUserQuestionService>;
}) {
  const storage = {
    listAgents: jest.fn(),
    listProfileProviderConfigsByIds: jest.fn().mockResolvedValue([]),
    listProvidersByIds: jest.fn().mockResolvedValue([]),
    getAgentProfile: jest.fn(),
    getAgent: jest.fn(),
    ...overrides.storage,
  } as unknown as StorageService;
  const activeSessions = {
    listActiveSessions: jest.fn().mockResolvedValue([]),
    getSessionProjectScope: jest.fn(),
    getActiveSession: jest.fn(),
    ...overrides.activeSessions,
  } as unknown as ActiveSessionLookup;
  const sessionReader = {
    getTranscriptSummaryWithCursor: jest.fn(),
    getUnifiedTranscriptChunks: jest.fn(),
    getTranscriptTail: jest.fn(),
    ...overrides.sessionReader,
  } as unknown as SessionReaderService;
  const transcriptWatcher = {
    // Default: no cached count → field omitted. Tests that assert enrichment
    // override getLastKnownMessageCount explicitly.
    getLastKnownMessageCount: jest.fn().mockReturnValue(null),
    ...overrides.transcriptWatcher,
  } as unknown as TranscriptWatcherService;
  const agentMessageDelivery = {
    deliver: jest.fn(),
    ...overrides.agentMessageDelivery,
  } as unknown as AgentMessageDeliveryService;
  const messageLogRead = {
    queryPendingMobile: jest.fn().mockReturnValue([]),
    ...overrides.messageLogRead,
  } as unknown as SessionsMessageLogReadFacade;
  const sessionLifecycle = {
    launch: jest.fn(),
    restart: jest.fn(),
    restore: jest.fn(),
    terminate: jest.fn().mockResolvedValue(undefined),
    ...overrides.sessionLifecycle,
  } as unknown as SessionLifecycleFacade;
  const teamsService = {
    listTeamsWithMemberIds: jest.fn(),
    ...overrides.teamsService,
  } as unknown as TeamsService;
  const pendingAskUserQuestion = {
    // Default: no pending entries; clear is a no-op returning 0. Tests that
    // exercise listPendingAskQuestions / clear-on-send override these explicitly.
    getBySession: jest.fn().mockReturnValue([]),
    clearBySession: jest.fn().mockReturnValue(0),
    ...overrides.pendingAskUserQuestion,
  } as unknown as PendingAskUserQuestionService;
  const operationTracker = new LifecycleOperationTracker();
  const service = new MobileChatRpcService(
    storage,
    activeSessions,
    sessionReader,
    transcriptWatcher,
    agentMessageDelivery,
    messageLogRead,
    sessionLifecycle,
    operationTracker,
    teamsService,
    pendingAskUserQuestion,
  );
  return {
    service,
    storage,
    activeSessions,
    sessionReader,
    transcriptWatcher,
    agentMessageDelivery,
    messageLogRead,
    sessionLifecycle,
    operationTracker,
    teamsService,
    pendingAskUserQuestion,
  };
}

describe('MobileChatRpcService.listAgents', () => {
  it('returns agents enriched with provider, profile, and presence in one call', async () => {
    const { service, storage, activeSessions } = build({
      storage: {
        listAgents: jest.fn().mockResolvedValue({
          items: [
            agent({ id: AGENT_A, profileId: PROFILE_CODER, providerConfigId: CONFIG_CLAUDE }),
            agent({
              id: AGENT_B,
              name: 'Reviewer',
              profileId: PROFILE_REVIEWER,
              providerConfigId: CONFIG_CODEX,
            }),
          ],
          total: 2,
          limit: 100,
          offset: 0,
        }),
        listProfileProviderConfigsByIds: jest.fn().mockResolvedValue([
          { id: CONFIG_CLAUDE, providerId: PROVIDER_CLAUDE, name: 'c1' },
          { id: CONFIG_CODEX, providerId: PROVIDER_CODEX, name: 'c2' },
        ]),
        listProvidersByIds: jest.fn().mockResolvedValue([
          { id: PROVIDER_CLAUDE, name: 'claude' },
          { id: PROVIDER_CODEX, name: 'codex' },
        ]),
        getAgentProfile: jest
          .fn()
          .mockImplementation((id: string) =>
            Promise.resolve(
              id === PROFILE_CODER
                ? { id: PROFILE_CODER, name: 'Coder Profile' }
                : { id: PROFILE_REVIEWER, name: 'Reviewer Profile' },
            ),
          ),
      },
      activeSessions: {
        // only AGENT_A is online
        listActiveSessions: jest
          .fn()
          .mockResolvedValue([activeSession({ agentId: AGENT_A, activityState: 'busy' })]),
      },
    });

    const result = await service.listAgents({ projectId: PROJECT_ID });

    expect(result).toEqual([
      {
        id: AGENT_A,
        name: 'Coder',
        type: 'agent',
        profileName: 'Coder Profile',
        providerName: 'claude',
        providerConfigName: 'c1',
        online: true,
        sessionId: SESSION_A,
        activityState: 'busy',
      },
      {
        id: AGENT_B,
        name: 'Reviewer',
        type: 'agent',
        profileName: 'Reviewer Profile',
        providerName: 'codex',
        providerConfigName: 'c2',
        online: false,
      },
    ]);

    expect(storage.listAgents).toHaveBeenCalledWith(PROJECT_ID);
    expect(activeSessions.listActiveSessions).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('is project-scoped: only agents returned by storage.listAgents(projectId) appear', async () => {
    // storage.listAgents(projectId) only returns this project's agents; an agent
    // from another project is never in the source set, so it can't leak.
    const { service, storage } = build({
      storage: {
        listAgents: jest.fn().mockResolvedValue({
          items: [agent({ id: AGENT_A })],
          total: 1,
          limit: 100,
          offset: 0,
        }),
        listProfileProviderConfigsByIds: jest
          .fn()
          .mockResolvedValue([{ id: CONFIG_CLAUDE, providerId: PROVIDER_CLAUDE, name: 'c1' }]),
        listProvidersByIds: jest.fn().mockResolvedValue([{ id: PROVIDER_CLAUDE, name: 'claude' }]),
        getAgentProfile: jest.fn().mockResolvedValue({ id: PROFILE_CODER, name: 'Coder Profile' }),
      },
    });

    const result = await service.listAgents({ projectId: PROJECT_ID });

    expect(result.map((a) => a.id)).toEqual([AGENT_A]);
    expect(result.some((a) => a.id === AGENT_B)).toBe(false);
    expect(storage.listAgents).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('merges presence: offline agents report online:false with no session', async () => {
    const { service } = build({
      storage: {
        listAgents: jest.fn().mockResolvedValue({
          items: [agent({ id: AGENT_A, providerConfigId: null, profileId: null })],
          total: 1,
          limit: 100,
          offset: 0,
        }),
      },
      activeSessions: { listActiveSessions: jest.fn().mockResolvedValue([]) },
    });

    const result = await service.listAgents({ projectId: PROJECT_ID });

    expect(result).toEqual([{ id: AGENT_A, name: 'Coder', type: 'agent', online: false }]);
  });

  it('resolves providers without N+1 (one configs-by-ids + one providers-by-ids for the page)', async () => {
    const { service, storage } = build({
      storage: {
        listAgents: jest.fn().mockResolvedValue({
          items: [
            agent({ id: AGENT_A, providerConfigId: CONFIG_CLAUDE, profileId: PROFILE_CODER }),
            agent({ id: AGENT_B, providerConfigId: CONFIG_CLAUDE, profileId: PROFILE_CODER }),
          ],
          total: 2,
          limit: 100,
          offset: 0,
        }),
        listProfileProviderConfigsByIds: jest
          .fn()
          .mockResolvedValue([{ id: CONFIG_CLAUDE, providerId: PROVIDER_CLAUDE, name: 'c1' }]),
        listProvidersByIds: jest.fn().mockResolvedValue([{ id: PROVIDER_CLAUDE, name: 'claude' }]),
        getAgentProfile: jest.fn().mockResolvedValue({ id: PROFILE_CODER, name: 'Coder Profile' }),
      },
    });

    await service.listAgents({ projectId: PROJECT_ID });

    expect(storage.listProfileProviderConfigsByIds).toHaveBeenCalledTimes(1);
    // de-duplicated to the single distinct config id shared by both agents
    expect(storage.listProfileProviderConfigsByIds).toHaveBeenCalledWith([CONFIG_CLAUDE]);
    expect(storage.listProvidersByIds).toHaveBeenCalledTimes(1);
    expect(storage.listProvidersByIds).toHaveBeenCalledWith([PROVIDER_CLAUDE]);
    // one fetch per distinct profile (deduped), not per agent
    expect(storage.getAgentProfile).toHaveBeenCalledTimes(1);
  });

  it('skips provider/profile lookups entirely when there are no agents', async () => {
    const { service, storage } = build({
      storage: {
        listAgents: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      },
    });

    const result = await service.listAgents({ projectId: PROJECT_ID });

    expect(result).toEqual([]);
    expect(storage.listProfileProviderConfigsByIds).not.toHaveBeenCalled();
    expect(storage.listProvidersByIds).not.toHaveBeenCalled();
    expect(storage.getAgentProfile).not.toHaveBeenCalled();
  });

  it('tolerates a missing profile without failing the whole call', async () => {
    const { service } = build({
      storage: {
        listAgents: jest.fn().mockResolvedValue({
          items: [agent({ id: AGENT_A, profileId: PROFILE_CODER, providerConfigId: null })],
          total: 1,
          limit: 100,
          offset: 0,
        }),
        getAgentProfile: jest.fn().mockRejectedValue(new Error('profile gone')),
      },
    });

    const result = await service.listAgents({ projectId: PROJECT_ID });

    expect(result).toEqual([{ id: AGENT_A, name: 'Coder', type: 'agent', online: false }]);
  });

  describe('latestMessageCount enrichment (watcher cache)', () => {
    const SESSION_B = '22222222-2222-4222-8222-222222222222';

    it('surfaces the watcher-cached message count for online agents, including a genuine 0', async () => {
      const { service } = build({
        storage: {
          listAgents: jest.fn().mockResolvedValue({
            items: [
              agent({ id: AGENT_A, name: 'Coder', providerConfigId: null, profileId: null }),
              agent({ id: AGENT_B, name: 'Reviewer', providerConfigId: null, profileId: null }),
            ],
            total: 2,
            limit: 100,
            offset: 0,
          }),
        },
        activeSessions: {
          listActiveSessions: jest
            .fn()
            .mockResolvedValue([
              activeSession({ agentId: AGENT_A, sessionId: SESSION_A }),
              activeSession({ agentId: AGENT_B, sessionId: SESSION_B }),
            ]),
        },
        transcriptWatcher: {
          // SESSION_A → 5 (a real count); SESSION_B → 0 (a genuine empty count,
          // must round-trip as 0, not be omitted like a missing entry).
          getLastKnownMessageCount: jest.fn((sessionId: string) =>
            sessionId === SESSION_A ? 5 : 0,
          ),
        },
      });

      const result = await service.listAgents({ projectId: PROJECT_ID });

      expect(result).toEqual([
        {
          id: AGENT_A,
          name: 'Coder',
          type: 'agent',
          online: true,
          sessionId: SESSION_A,
          activityState: 'busy',
          latestMessageCount: 5,
        },
        {
          id: AGENT_B,
          name: 'Reviewer',
          type: 'agent',
          online: true,
          sessionId: SESSION_B,
          activityState: 'busy',
          latestMessageCount: 0,
        },
      ]);
    });

    it('omits latestMessageCount when the watcher has no entry for the session (null)', async () => {
      const { service } = build({
        storage: {
          listAgents: jest.fn().mockResolvedValue({
            items: [agent({ id: AGENT_A, name: 'Coder', providerConfigId: null, profileId: null })],
            total: 1,
            limit: 100,
            offset: 0,
          }),
        },
        activeSessions: {
          listActiveSessions: jest
            .fn()
            .mockResolvedValue([activeSession({ agentId: AGENT_A, sessionId: SESSION_A })]),
        },
        transcriptWatcher: { getLastKnownMessageCount: jest.fn().mockReturnValue(null) },
      });

      const result = await service.listAgents({ projectId: PROJECT_ID });

      // Field is absent (deep-equal) — no badge for a session the watcher doesn't know.
      expect(result).toEqual([
        {
          id: AGENT_A,
          name: 'Coder',
          type: 'agent',
          online: true,
          sessionId: SESSION_A,
          activityState: 'busy',
        },
      ]);
    });

    it('omits latestMessageCount and still returns when the watcher lookup throws', async () => {
      const { service } = build({
        storage: {
          listAgents: jest.fn().mockResolvedValue({
            items: [agent({ id: AGENT_A, name: 'Coder', providerConfigId: null, profileId: null })],
            total: 1,
            limit: 100,
            offset: 0,
          }),
        },
        activeSessions: {
          listActiveSessions: jest
            .fn()
            .mockResolvedValue([activeSession({ agentId: AGENT_A, sessionId: SESSION_A })]),
        },
        transcriptWatcher: {
          getLastKnownMessageCount: jest.fn().mockImplementation(() => {
            throw new Error('watcher exploded');
          }),
        },
      });

      // Best-effort: a per-agent lookup error never fails listAgents; field omitted.
      const result = await service.listAgents({ projectId: PROJECT_ID });

      expect(result).toEqual([
        {
          id: AGENT_A,
          name: 'Coder',
          type: 'agent',
          online: true,
          sessionId: SESSION_A,
          activityState: 'busy',
        },
      ]);
    });

    it('never adds latestMessageCount for offline agents and never consults the watcher', async () => {
      const { service, transcriptWatcher } = build({
        storage: {
          listAgents: jest.fn().mockResolvedValue({
            items: [agent({ id: AGENT_A, name: 'Coder', providerConfigId: null, profileId: null })],
            total: 1,
            limit: 100,
            offset: 0,
          }),
        },
        // No active sessions → AGENT_A is offline (no sessionId).
        activeSessions: { listActiveSessions: jest.fn().mockResolvedValue([]) },
        transcriptWatcher: { getLastKnownMessageCount: jest.fn().mockReturnValue(42) },
      });

      const result = await service.listAgents({ projectId: PROJECT_ID });

      expect(result).toEqual([{ id: AGENT_A, name: 'Coder', type: 'agent', online: false }]);
      expect(transcriptWatcher.getLastKnownMessageCount).not.toHaveBeenCalled();
    });
  });
});

describe('MobileChatRpcService transcript RPCs', () => {
  const scopeOk = { sessionId: SESSION_A, agentId: AGENT_A, projectId: PROJECT_ID };

  describe('ownership enforcement (session → agent → project)', () => {
    it('throws NotFoundError when the session does not exist — before any read', async () => {
      const { service, sessionReader, activeSessions } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.getTranscriptSummary({ sessionId: SESSION_A, projectId: PROJECT_ID }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(activeSessions.getSessionProjectScope).toHaveBeenCalledWith(SESSION_A);
      expect(sessionReader.getTranscriptSummaryWithCursor).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError with SESSION_PROJECT_MISMATCH for a cross-project session', async () => {
      const otherProject = '44444444-4444-4444-8444-444444444444';
      const { service, sessionReader } = build({
        activeSessions: {
          getSessionProjectScope: jest
            .fn()
            .mockResolvedValue({ ...scopeOk, projectId: otherProject }),
        },
      });

      const err = await service
        .getTranscriptChunks({ sessionId: SESSION_A, projectId: PROJECT_ID })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details).toMatchObject({ code: 'SESSION_PROJECT_MISMATCH' });
      expect(sessionReader.getUnifiedTranscriptChunks).not.toHaveBeenCalled();
    });

    it('enforces ownership on the tail path too', async () => {
      const { service, sessionReader } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.getTranscriptTail({ sessionId: SESSION_A, projectId: PROJECT_ID, since: 'abc' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(sessionReader.getTranscriptTail).not.toHaveBeenCalled();
    });
  });

  describe('getTranscriptSummary', () => {
    it('returns the cursor-bearing summary after the ownership check passes', async () => {
      const summary = { sessionId: SESSION_A, providerName: 'claude', cursor: 'CUR' };
      const { service, sessionReader } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
        sessionReader: {
          getTranscriptSummaryWithCursor: jest.fn().mockResolvedValue(summary),
        },
      });

      const result = await service.getTranscriptSummary({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
      });

      expect(result).toBe(summary);
      expect(sessionReader.getTranscriptSummaryWithCursor).toHaveBeenCalledWith(SESSION_A);
    });
  });

  describe('getTranscriptChunks', () => {
    it("defaults direction to 'backward' (last N) when none is provided", async () => {
      const { service, sessionReader } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
        sessionReader: {
          getUnifiedTranscriptChunks: jest
            .fn()
            .mockResolvedValue({ chunks: [], nextCursor: null, prevCursor: null, totalCount: 0 }),
        },
      });

      await service.getTranscriptChunks({ sessionId: SESSION_A, projectId: PROJECT_ID });

      expect(sessionReader.getUnifiedTranscriptChunks).toHaveBeenCalledWith(
        SESSION_A,
        undefined,
        undefined,
        'backward',
      );
    });

    it('passes through cursor, limit, and explicit direction', async () => {
      const { service, sessionReader } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
        sessionReader: {
          getUnifiedTranscriptChunks: jest
            .fn()
            .mockResolvedValue({ chunks: [], nextCursor: null, prevCursor: null, totalCount: 0 }),
        },
      });

      await service.getTranscriptChunks({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        cursor: 'chunk-5',
        limit: 10,
        direction: 'forward',
      });

      expect(sessionReader.getUnifiedTranscriptChunks).toHaveBeenCalledWith(
        SESSION_A,
        'chunk-5',
        10,
        'forward',
      );
    });
  });

  describe('getTranscriptTail', () => {
    it('delegates with the since cursor and propagates a null (expired) result', async () => {
      const { service, sessionReader } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
        sessionReader: { getTranscriptTail: jest.fn().mockResolvedValue(null) },
      });

      const result = await service.getTranscriptTail({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        since: 'CUR',
      });

      expect(result).toBeNull();
      expect(sessionReader.getTranscriptTail).toHaveBeenCalledWith(SESSION_A, 'CUR');
    });
  });
});

describe('MobileChatRpcService custom prompt RPCs', () => {
  const PROMPT_A = '14141414-1414-4414-8414-141414141414';
  const PROMPT_B = '15151515-1515-4515-8515-151515151515';
  const OTHER_PROJECT_ID = '16161616-1616-4616-8616-161616161616';
  const scopeOk = { sessionId: SESSION_A, agentId: AGENT_A, projectId: PROJECT_ID };
  const promptSummary = (id: string, tags: string[], projectId: string | null = PROJECT_ID) => ({
    id,
    projectId,
    title: 'Duplicate title',
    contentPreview: 'must not be returned',
    version: 1,
    tags,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  });

  it('lists only authorized Custom ids/titles in one bounded storage read', async () => {
    const { service, storage } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      storage: {
        listPrompts: jest.fn().mockResolvedValue({
          items: [
            promptSummary(PROMPT_A, ['type:custom']),
            promptSummary(PROMPT_B, ['TYPE:EXPERIMENTAL']),
            promptSummary('17171717-1717-4717-8717-171717171717', ['type:system']),
            promptSummary('18181818-1818-4818-8818-181818181818', []),
            promptSummary(
              '19191919-1919-4919-8919-191919191919',
              ['type:custom'],
              OTHER_PROJECT_ID,
            ),
          ],
          total: 5,
          limit: 10000,
          offset: 0,
        }),
      },
    });

    await expect(
      service.listCustomPrompts({ sessionId: SESSION_A, projectId: PROJECT_ID }),
    ).resolves.toEqual([
      { id: PROMPT_A, title: 'Duplicate title' },
      { id: PROMPT_B, title: 'Duplicate title' },
    ]);
    expect(storage.listPrompts).toHaveBeenCalledTimes(1);
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      limit: 10000,
      offset: 0,
    });
  });

  it('fails with a typed domain error instead of returning a truncated list', async () => {
    const { service } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      storage: {
        listPrompts: jest.fn().mockResolvedValue({
          items: [promptSummary(PROMPT_A, ['type:custom'])],
          total: 2,
          limit: 10000,
          offset: 0,
        }),
      },
    });

    const err = await service
      .listCustomPrompts({ sessionId: SESSION_A, projectId: PROJECT_ID })
      .catch((error) => error);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CUSTOM_PROMPT_LIST_TRUNCATED');
    expect((err as AppError).details).toEqual({
      total: 2,
      returned: 1,
    });
  });

  it('checks session/project ownership before listing prompts', async () => {
    const { service, storage } = build({
      activeSessions: {
        getSessionProjectScope: jest.fn().mockResolvedValue({
          ...scopeOk,
          projectId: OTHER_PROJECT_ID,
        }),
      },
      storage: { listPrompts: jest.fn() },
    });

    const err = await service
      .listCustomPrompts({ sessionId: SESSION_A, projectId: PROJECT_ID })
      .catch((error) => error);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).details).toMatchObject({
      code: 'SESSION_PROJECT_MISMATCH',
    });
    expect(storage.listPrompts).not.toHaveBeenCalled();
  });

  it('returns full content only after project and Custom type revalidation', async () => {
    const { service, storage } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      storage: {
        getPrompt: jest.fn().mockResolvedValue({
          ...promptSummary(PROMPT_A, ['type:custom']),
          content: 'full prompt body',
        }),
      },
    });

    await expect(
      service.getCustomPrompt({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        promptId: PROMPT_A,
      }),
    ).resolves.toEqual({
      id: PROMPT_A,
      title: 'Duplicate title',
      content: 'full prompt body',
    });
    expect(storage.getPrompt).toHaveBeenCalledWith(PROMPT_A);
  });

  it.each([
    ['cross-project', ['type:custom'], OTHER_PROJECT_ID],
    ['System', ['type:system'], PROJECT_ID],
    ['untyped', [], PROJECT_ID],
  ])('does not expose %s prompt content', async (_case, tags, promptProjectId) => {
    const { service } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      storage: {
        getPrompt: jest.fn().mockResolvedValue({
          ...promptSummary(PROMPT_A, tags, promptProjectId),
          content: 'secret prompt body',
        }),
      },
    });

    await expect(
      service.getCustomPrompt({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        promptId: PROMPT_A,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('revalidates the current type at selection time and rejects a Custom-to-System race', async () => {
    const { service } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      storage: {
        getPrompt: jest.fn().mockResolvedValue({
          ...promptSummary(PROMPT_A, ['type:system']),
          content: 'changed after list',
        }),
      },
    });

    await expect(
      service.getCustomPrompt({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        promptId: PROMPT_A,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('preserves the storage not-found result for a deleted prompt', async () => {
    const { service } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      storage: {
        getPrompt: jest.fn().mockRejectedValue(new NotFoundError('Prompt', PROMPT_A)),
      },
    });

    await expect(
      service.getCustomPrompt({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        promptId: PROMPT_A,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('MobileChatRpcService.sendMessage', () => {
  const runningSession = {
    sessionId: SESSION_A,
    agentId: AGENT_A,
    projectId: PROJECT_ID,
    status: 'running',
    tmuxSessionId: 'tmux-1',
    startedAt: '2026-06-02T00:00:00.000Z',
    lastActivityAt: null,
    activityState: null,
    name: null,
  };

  function buildSend(over: {
    agent?: Record<string, unknown> | null;
    active?: unknown;
    deliver?: unknown;
    /** Entries returned by pendingAskUserQuestion.getBySession (default: none). */
    pending?: unknown[];
  }) {
    return build({
      storage: {
        getAgent: jest
          .fn()
          .mockResolvedValue(over.agent ?? { id: AGENT_A, projectId: PROJECT_ID, name: 'Coder' }),
      },
      activeSessions: {
        getActiveSession: jest
          .fn()
          .mockResolvedValue(over.active === undefined ? runningSession : over.active),
      },
      agentMessageDelivery: {
        deliver: jest
          .fn()
          .mockResolvedValue(
            over.deliver ?? { status: 'queued', results: [{ agentId: AGENT_A, status: 'queued' }] },
          ),
      },
      ...(over.pending !== undefined
        ? { pendingAskUserQuestion: { getBySession: jest.fn().mockReturnValue(over.pending) } }
        : {}),
    });
  }

  it('delivers thread-free (mcp.direct) by agent UUID and returns queued', async () => {
    const { service, agentMessageDelivery } = buildSend({});

    const result = await service.sendMessage({
      agentId: AGENT_A,
      projectId: PROJECT_ID,
      text: 'hello agent',
    });

    expect(result).toEqual({ status: 'queued' });
    expect(agentMessageDelivery.deliver).toHaveBeenCalledTimes(1);
    const [recipients, message, policy] = (agentMessageDelivery.deliver as jest.Mock).mock.calls[0];
    // recipient is the agent UUID (not the name) — passthrough resolver keys on agent_id
    expect(recipients).toEqual([AGENT_A]);
    // thread-free: mcp.direct with NO threadId, senderType user
    expect(message).toMatchObject({
      kind: 'mcp.direct',
      body: 'hello agent',
      source: 'mobile',
      projectId: PROJECT_ID,
      senderType: 'user',
      // plain framing: the human user's turn is delivered as raw text with NO
      // agent-oriented banner (regression guard that mobile stays thread-free + plain)
      framing: 'plain',
    });
    expect(message.threadId).toBeUndefined();
    expect(message.framing).toBe('plain');
    // deliver-only: immediate + requireActiveSession (no auto-launch)
    expect(policy).toEqual({ immediate: true, requireActiveSession: true });
  });

  it('maps a delivered outcome to status:delivered', async () => {
    const { service } = buildSend({
      deliver: { status: 'delivered', results: [{ agentId: AGENT_A, status: 'delivered' }] },
    });

    const result = await service.sendMessage({
      agentId: AGENT_A,
      projectId: PROJECT_ID,
      text: 'hi',
    });

    expect(result).toEqual({ status: 'delivered' });
  });

  it('hard-errors SESSION_NOT_RUNNING and never delivers when no active session', async () => {
    const { service, agentMessageDelivery } = buildSend({ active: null });

    const err = await service
      .sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'hi' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SESSION_NOT_RUNNING');
    expect((err as AppError).statusCode).toBe(409);
    expect(agentMessageDelivery.deliver).not.toHaveBeenCalled();
  });

  it('surfaces SESSION_NOT_RUNNING when the deliver race fails (requireActiveSession guard)', async () => {
    const { service } = buildSend({
      deliver: {
        status: 'failed',
        results: [{ agentId: AGENT_A, status: 'failed', error: 'SESSION_NOT_RUNNING' }],
      },
    });

    const err = await service
      .sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'hi' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SESSION_NOT_RUNNING');
  });

  it('rejects a cross-project agent with ForbiddenError before any delivery', async () => {
    const { service, agentMessageDelivery, activeSessions } = buildSend({
      agent: { id: AGENT_A, projectId: '44444444-4444-4444-8444-444444444444', name: 'Coder' },
    });

    const err = await service
      .sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'hi' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).details).toMatchObject({ code: 'AGENT_PROJECT_MISMATCH' });
    expect(activeSessions.getActiveSession).not.toHaveBeenCalled();
    expect(agentMessageDelivery.deliver).not.toHaveBeenCalled();
  });

  describe('picker dismissal (preKeys)', () => {
    const pendingEntry = {
      projectId: PROJECT_ID,
      agentId: AGENT_A,
      sessionId: SESSION_A,
      claudeSessionId: 'cc-1',
      toolUseId: 'tu-1',
      questions: [],
      createdAt: 0,
      expiresAt: 0,
      status: 'pending' as const,
    };

    it('sends ESC before the answer paste when a question is pending for the session', async () => {
      const { service, agentMessageDelivery } = buildSend({ pending: [pendingEntry] });

      await service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'Red' });

      const [, , policy] = (agentMessageDelivery.deliver as jest.Mock).mock.calls[0];
      expect(policy).toMatchObject({
        immediate: true,
        requireActiveSession: true,
        preKeys: ['Escape'],
      });
      expect(policy.preDelayMs).toBeGreaterThan(0);
    });

    it('does NOT send preKeys when no question is pending (plain chat)', async () => {
      const { service, agentMessageDelivery } = buildSend({ pending: [] });

      await service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'just chatting' });

      const [, , policy] = (agentMessageDelivery.deliver as jest.Mock).mock.calls[0];
      expect(policy.preKeys).toBeUndefined();
      expect(policy).toEqual({ immediate: true, requireActiveSession: true });
    });
  });

  describe('clear-on-send (pending AskUserQuestion)', () => {
    it('clears the session pending entry after a successful delivery', async () => {
      const { service, pendingAskUserQuestion } = buildSend({
        deliver: { status: 'delivered', results: [{ agentId: AGENT_A, status: 'delivered' }] },
      });

      await service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'answer' });

      expect(pendingAskUserQuestion.clearBySession).toHaveBeenCalledWith(SESSION_A);
    });

    it('clears on a queued (unconfirmed) outcome too — the RPC still succeeded', async () => {
      // buildSend's default deliver mock returns status 'queued' (unconfirmed);
      // that is a non-throwing success, so the pending entry is still cleared.
      const { service, pendingAskUserQuestion } = buildSend({});

      await service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'answer' });

      expect(pendingAskUserQuestion.clearBySession).toHaveBeenCalledWith(SESSION_A);
    });

    it('does NOT clear when delivery failed (SESSION_NOT_RUNNING race)', async () => {
      const { service, pendingAskUserQuestion } = buildSend({
        deliver: {
          status: 'failed',
          results: [{ agentId: AGENT_A, status: 'failed', error: 'SESSION_NOT_RUNNING' }],
        },
      });

      await expect(
        service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'answer' }),
      ).rejects.toBeInstanceOf(AppError);
      expect(pendingAskUserQuestion.clearBySession).not.toHaveBeenCalled();
    });

    it('does NOT clear when there is no active session (pre-check throws)', async () => {
      const { service, pendingAskUserQuestion } = buildSend({ active: null });

      await expect(
        service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'answer' }),
      ).rejects.toBeInstanceOf(AppError);
      expect(pendingAskUserQuestion.clearBySession).not.toHaveBeenCalled();
    });

    it('does NOT clear for a cross-project agent (rejected before delivery)', async () => {
      const { service, pendingAskUserQuestion } = buildSend({
        agent: { id: AGENT_A, projectId: '44444444-4444-4444-8444-444444444444', name: 'Coder' },
      });

      await expect(
        service.sendMessage({ agentId: AGENT_A, projectId: PROJECT_ID, text: 'answer' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(pendingAskUserQuestion.clearBySession).not.toHaveBeenCalled();
    });
  });

  describe('clientMessageId / messageId threading', () => {
    const CLIENT_MSG_ID = '10101010-1010-4010-8010-101010101010';
    const LOG_ENTRY_ID = '20202020-2020-4020-8020-202020202020';

    it('threads clientMessageId into the delivery message and echoes messageId + clientMessageId', async () => {
      const { service, agentMessageDelivery } = buildSend({
        deliver: {
          status: 'delivered',
          results: [{ agentId: AGENT_A, status: 'delivered', messageId: LOG_ENTRY_ID }],
        },
      });

      const result = await service.sendMessage({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
        text: 'idempotent hi',
        clientMessageId: CLIENT_MSG_ID,
      });

      expect(result).toEqual({
        status: 'delivered',
        messageId: LOG_ENTRY_ID,
        clientMessageId: CLIENT_MSG_ID,
      });
      const [, message] = (agentMessageDelivery.deliver as jest.Mock).mock.calls[0];
      expect(message.clientMessageId).toBe(CLIENT_MSG_ID);
    });

    it('omits messageId/clientMessageId when the caller sends neither (desktop-compatible shape)', async () => {
      const { service, agentMessageDelivery } = buildSend({});

      const result = await service.sendMessage({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
        text: 'legacy send',
      });

      expect(result).toEqual({ status: 'queued' });
      const [, message] = (agentMessageDelivery.deliver as jest.Mock).mock.calls[0];
      expect(message.clientMessageId).toBeUndefined();
    });
  });
});

describe('MobileChatRpcService.getPendingMessages', () => {
  const CLIENT_MSG_ID = '10101010-1010-4010-8010-101010101010';

  it('authorizes the agent against the project, then delegates to the read facade', async () => {
    const rows = [
      {
        messageId: '20202020-2020-4020-8020-202020202020',
        clientMessageId: CLIENT_MSG_ID,
        text: 'hi',
        status: 'delivered' as const,
        timestamp: 123,
        deliveredAt: 456,
      },
    ];
    const { service, storage, messageLogRead } = build({
      storage: { getAgent: jest.fn().mockResolvedValue(agent({})) },
      messageLogRead: { queryPendingMobile: jest.fn().mockReturnValue(rows) },
    });

    const result = await service.getPendingMessages({
      agentId: AGENT_A,
      projectId: PROJECT_ID,
      clientMessageIds: [CLIENT_MSG_ID],
    });

    expect(result).toBe(rows);
    expect(storage.getAgent).toHaveBeenCalledWith(AGENT_A);
    expect(messageLogRead.queryPendingMobile).toHaveBeenCalledWith(AGENT_A, PROJECT_ID, [
      CLIENT_MSG_ID,
    ]);
  });

  it('rejects a cross-project agent with AGENT_PROJECT_MISMATCH before reading the log', async () => {
    const { service, messageLogRead } = build({
      storage: {
        getAgent: jest
          .fn()
          .mockResolvedValue(agent({ projectId: '44444444-4444-4444-8444-444444444444' })),
      },
    });

    const err = await service
      .getPendingMessages({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
        clientMessageIds: [CLIENT_MSG_ID],
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).details).toMatchObject({ code: 'AGENT_PROJECT_MISMATCH' });
    expect(messageLogRead.queryPendingMobile).not.toHaveBeenCalled();
  });
});

describe('MobileChatRpcService.listPendingAskQuestions', () => {
  const scopeOk = { sessionId: SESSION_A, agentId: AGENT_A, projectId: PROJECT_ID };

  it('returns the session pending entries serialized to the wire item shape', async () => {
    const createdAt = 1_700_000_000_000;
    const expiresAt = createdAt + 30 * 60 * 1000;
    const { service, pendingAskUserQuestion } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      pendingAskUserQuestion: {
        getBySession: jest.fn().mockReturnValue([
          {
            projectId: PROJECT_ID,
            agentId: AGENT_A,
            sessionId: SESSION_A,
            claudeSessionId: 'claude-1',
            toolUseId: 'toolu_1',
            questions: [
              {
                question: 'Pick one',
                header: 'Choice',
                multiSelect: false,
                options: [{ label: 'A', description: 'first' }],
              },
            ],
            createdAt,
            expiresAt,
            status: 'pending',
          },
        ]),
      },
    });

    const result = await service.listPendingAskQuestions({
      sessionId: SESSION_A,
      projectId: PROJECT_ID,
    });

    expect(pendingAskUserQuestion.getBySession).toHaveBeenCalledWith(SESSION_A);
    // Wire shape: only toolUseId + normalized questions + timestamps. The internal
    // claudeSessionId / status / projectId / sessionId must NOT leak.
    expect(result).toEqual([
      {
        toolUseId: 'toolu_1',
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            multiSelect: false,
            options: [{ label: 'A', description: 'first' }],
          },
        ],
        createdAt,
        expiresAt,
      },
    ]);
  });

  it('returns [] when the session has no pending entries', async () => {
    const { service, pendingAskUserQuestion } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
    });

    const result = await service.listPendingAskQuestions({
      sessionId: SESSION_A,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual([]);
    expect(pendingAskUserQuestion.getBySession).toHaveBeenCalledWith(SESSION_A);
  });

  it('throws ForbiddenError (SESSION_PROJECT_MISMATCH) for a cross-project session before consulting the store', async () => {
    const otherProject = '44444444-4444-4444-8444-444444444444';
    const { service, pendingAskUserQuestion } = build({
      activeSessions: {
        getSessionProjectScope: jest
          .fn()
          .mockResolvedValue({ ...scopeOk, projectId: otherProject }),
      },
    });

    const err = await service
      .listPendingAskQuestions({ sessionId: SESSION_A, projectId: PROJECT_ID })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).details).toMatchObject({ code: 'SESSION_PROJECT_MISMATCH' });
    expect(pendingAskUserQuestion.getBySession).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for an unknown session before consulting the store', async () => {
    const { service, pendingAskUserQuestion } = build({
      activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(null) },
    });

    await expect(
      service.listPendingAskQuestions({ sessionId: SESSION_A, projectId: PROJECT_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(pendingAskUserQuestion.getBySession).not.toHaveBeenCalled();
  });
});

describe('MobileChatRpcService lifecycle RPCs', () => {
  // Let fire-and-forget runOperation .then/.catch settle before asserting tracker state.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const agentInProject = { id: AGENT_A, projectId: PROJECT_ID, name: 'Coder' };
  const scopeOk = { sessionId: SESSION_A, agentId: AGENT_A, projectId: PROJECT_ID };

  describe('launchAgent', () => {
    it('returns launching immediately and the tracker reaches succeeded with the new session', async () => {
      const { service, operationTracker, sessionLifecycle } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        activeSessions: { getActiveSession: jest.fn().mockResolvedValue(null) },
        sessionLifecycle: { launch: jest.fn().mockResolvedValue({ id: 'new-session-id' }) },
      });

      const result = await service.launchAgent({ agentId: AGENT_A, projectId: PROJECT_ID });

      expect(result.status).toBe('launching');
      expect(result.operationId).toBeTruthy();
      // returns BEFORE the pipeline finishes (not awaited)
      expect(sessionLifecycle.launch).toHaveBeenCalledWith(AGENT_A, PROJECT_ID);

      await flush();
      const op = operationTracker.get(result.operationId);
      expect(op).toMatchObject({
        type: 'launch',
        status: 'succeeded',
        sessionId: 'new-session-id',
        agentId: AGENT_A,
      });
    });

    it('records failure with the domain error code when the launch pipeline rejects', async () => {
      const { service, operationTracker } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        activeSessions: { getActiveSession: jest.fn().mockResolvedValue(null) },
        sessionLifecycle: {
          launch: jest
            .fn()
            .mockRejectedValue(new ConflictError('boom', { code: 'INVALID_SESSION_STATE' })),
        },
      });

      const { operationId } = await service.launchAgent({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
      });
      await flush();

      expect(operationTracker.get(operationId)).toMatchObject({
        status: 'failed',
        errorCode: 'INVALID_SESSION_STATE',
      });
    });

    it('rejects (ConflictError SESSION_ALREADY_RUNNING) without creating an op when already running', async () => {
      const { service, sessionLifecycle } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        activeSessions: {
          getActiveSession: jest.fn().mockResolvedValue({ sessionId: SESSION_A }),
        },
      });

      const err = await service
        .launchAgent({ agentId: AGENT_A, projectId: PROJECT_ID })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).details).toMatchObject({ code: 'SESSION_ALREADY_RUNNING' });
      expect(sessionLifecycle.launch).not.toHaveBeenCalled();
    });

    it('rejects a cross-project agent before launching', async () => {
      const { service, sessionLifecycle } = build({
        storage: {
          getAgent: jest.fn().mockResolvedValue({ id: AGENT_A, projectId: 'other', name: 'Coder' }),
        },
      });

      const err = await service
        .launchAgent({ agentId: AGENT_A, projectId: PROJECT_ID })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details).toMatchObject({ code: 'AGENT_PROJECT_MISMATCH' });
      expect(sessionLifecycle.launch).not.toHaveBeenCalled();
    });
  });

  describe('restartAgent', () => {
    it('returns restarting and the tracker reaches succeeded', async () => {
      const { service, operationTracker, sessionLifecycle } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        sessionLifecycle: { restart: jest.fn().mockResolvedValue({ id: 'restarted-session' }) },
      });

      const result = await service.restartAgent({ agentId: AGENT_A, projectId: PROJECT_ID });
      expect(result.status).toBe('restarting');
      expect(sessionLifecycle.restart).toHaveBeenCalledWith(AGENT_A, PROJECT_ID);

      await flush();
      expect(operationTracker.get(result.operationId)).toMatchObject({
        type: 'restart',
        status: 'succeeded',
        sessionId: 'restarted-session',
      });
    });
  });

  describe('restoreSession', () => {
    it('treats an already-running agent as success without invoking restore (STATUS_RUNNING)', async () => {
      const { service, operationTracker, sessionLifecycle } = build({
        activeSessions: {
          getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk),
          getActiveSession: jest.fn().mockResolvedValue({ sessionId: 'running-session' }),
        },
        sessionLifecycle: { restore: jest.fn() },
      });

      const result = await service.restoreSession({ sessionId: SESSION_A, projectId: PROJECT_ID });
      expect(result.status).toBe('restoring');

      await flush();
      expect(sessionLifecycle.restore).not.toHaveBeenCalled();
      expect(operationTracker.get(result.operationId)).toMatchObject({
        type: 'restore',
        status: 'succeeded',
        sessionId: 'running-session',
      });
    });

    it('maps a restore ConflictError code (PROVIDER_MISMATCH) onto the operation', async () => {
      const { service, operationTracker } = build({
        activeSessions: {
          getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk),
          getActiveSession: jest.fn().mockResolvedValue(null),
        },
        sessionLifecycle: {
          restore: jest
            .fn()
            .mockRejectedValue(new ConflictError('mismatch', { code: 'PROVIDER_MISMATCH' })),
        },
      });

      const { operationId } = await service.restoreSession({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
      });
      await flush();

      expect(operationTracker.get(operationId)).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_MISMATCH',
      });
    });

    it('rejects unknown session (NotFound) and cross-project session (Forbidden)', async () => {
      const unknown = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(null) },
      });
      await expect(
        unknown.service.restoreSession({ sessionId: SESSION_A, projectId: PROJECT_ID }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const cross = build({
        activeSessions: {
          getSessionProjectScope: jest.fn().mockResolvedValue({ ...scopeOk, projectId: 'other' }),
        },
      });
      const err = await cross.service
        .restoreSession({ sessionId: SESSION_A, projectId: PROJECT_ID })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details).toMatchObject({ code: 'SESSION_PROJECT_MISMATCH' });
    });
  });

  describe('terminateSession (synchronous, idempotent)', () => {
    it('terminates an owned session', async () => {
      const { service, sessionLifecycle } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(scopeOk) },
      });

      const result = await service.terminateSession({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
      });
      expect(result).toEqual({ status: 'terminated' });
      expect(sessionLifecycle.terminate).toHaveBeenCalledWith(SESSION_A);
    });

    it('is idempotent for an unknown session (no terminate call)', async () => {
      const { service, sessionLifecycle } = build({
        activeSessions: { getSessionProjectScope: jest.fn().mockResolvedValue(null) },
      });

      const result = await service.terminateSession({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
      });
      expect(result).toEqual({ status: 'terminated' });
      expect(sessionLifecycle.terminate).not.toHaveBeenCalled();
    });

    it('rejects a cross-project session', async () => {
      const { service, sessionLifecycle } = build({
        activeSessions: {
          getSessionProjectScope: jest.fn().mockResolvedValue({ ...scopeOk, projectId: 'other' }),
        },
      });

      const err = await service
        .terminateSession({ sessionId: SESSION_A, projectId: PROJECT_ID })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(sessionLifecycle.terminate).not.toHaveBeenCalled();
    });
  });

  describe('getOperationStatus', () => {
    it('returns the tracked operation for the owning project', async () => {
      const { service, operationTracker } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        activeSessions: { getActiveSession: jest.fn().mockResolvedValue(null) },
        sessionLifecycle: { launch: jest.fn().mockResolvedValue({ id: 's' }) },
      });
      const { operationId } = await service.launchAgent({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
      });

      const op = await service.getOperationStatus({ operationId, projectId: PROJECT_ID });
      expect(op.operationId).toBe(operationId);
      expect(op.type).toBe('launch');
      void operationTracker;
    });

    it('throws NotFound for an unknown operationId', async () => {
      const { service } = build({});
      await expect(
        service.getOperationStatus({
          operationId: '00000000-0000-4000-8000-000000000000',
          projectId: PROJECT_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects a cross-project operation with ForbiddenError and does not leak the record', async () => {
      const otherProject = '44444444-4444-4444-8444-444444444444';
      const { service } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        activeSessions: { getActiveSession: jest.fn().mockResolvedValue(null) },
        sessionLifecycle: { launch: jest.fn().mockResolvedValue({ id: 's' }) },
      });
      const { operationId } = await service.launchAgent({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
      });

      const err = await service
        .getOperationStatus({ operationId, projectId: otherProject })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details).toMatchObject({
        code: 'OPERATION_PROJECT_MISMATCH',
        operationId,
        projectId: otherProject,
      });
    });
  });

  describe('getAgentStatus', () => {
    it('returns the latest tracked operation for an in-project agent', async () => {
      const { service } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
        activeSessions: { getActiveSession: jest.fn().mockResolvedValue(null) },
        sessionLifecycle: { launch: jest.fn().mockResolvedValue({ id: 's' }) },
      });
      const { operationId } = await service.launchAgent({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
      });

      const status = await service.getAgentStatus({ agentId: AGENT_A, projectId: PROJECT_ID });
      expect(status).not.toBeNull();
      expect(status?.operationId).toBe(operationId);
      expect(status?.type).toBe('launch');
      expect(status?.agentId).toBe(AGENT_A);
    });

    it('returns null for a known in-project agent with no tracked operation', async () => {
      const { service } = build({
        storage: { getAgent: jest.fn().mockResolvedValue(agentInProject) },
      });
      await expect(
        service.getAgentStatus({ agentId: AGENT_A, projectId: PROJECT_ID }),
      ).resolves.toBeNull();
    });

    it('rejects a cross-project agent with ForbiddenError before consulting the tracker', async () => {
      const otherProject = '44444444-4444-4444-8444-444444444444';
      const { service, storage } = build({
        storage: {
          getAgent: jest
            .fn()
            .mockResolvedValue({ id: AGENT_A, projectId: otherProject, name: 'Coder' }),
        },
      });

      const err = await service
        .getAgentStatus({ agentId: AGENT_A, projectId: PROJECT_ID })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details).toMatchObject({ code: 'AGENT_PROJECT_MISMATCH' });
      expect((storage.getAgent as jest.Mock).mock.calls).toHaveLength(1);
    });
  });
});

describe('MobileChatRpcService.listTeams', () => {
  it('returns teams with lead + ordered memberAgentIds + memberCount, scoped by projectId', async () => {
    const { service, teamsService } = build({
      teamsService: {
        listTeamsWithMemberIds: jest.fn().mockResolvedValue([
          {
            id: 'team-a',
            name: 'Alpha',
            teamLeadAgentId: 'lead-1',
            memberAgentIds: ['lead-1', 'member-2', 'member-3'],
          },
        ]),
      },
    });

    const result = await service.listTeams({ projectId: PROJECT_ID });

    expect(teamsService.listTeamsWithMemberIds).toHaveBeenCalledWith(PROJECT_ID);
    expect(result).toEqual([
      {
        id: 'team-a',
        name: 'Alpha',
        teamLeadAgentId: 'lead-1',
        memberAgentIds: ['lead-1', 'member-2', 'member-3'],
        memberCount: 3,
      },
    ]);
  });

  it('returns [] for a project with no teams', async () => {
    const { service, teamsService } = build({
      teamsService: { listTeamsWithMemberIds: jest.fn().mockResolvedValue([]) },
    });

    const result = await service.listTeams({ projectId: PROJECT_ID });

    expect(result).toEqual([]);
    expect(teamsService.listTeamsWithMemberIds).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('preserves multi-team membership (an agent in two teams appears in both) and insertion order', async () => {
    // Mirrors the web sidebar: each section is built from its own members with no
    // cross-team dedup, so a shared agent legitimately appears under both teams.
    const { service } = build({
      teamsService: {
        listTeamsWithMemberIds: jest.fn().mockResolvedValue([
          {
            id: 'team-x',
            name: 'X',
            teamLeadAgentId: 'lead-1',
            memberAgentIds: ['lead-1', 'shared-agent'],
          },
          {
            id: 'team-y',
            name: 'Y',
            teamLeadAgentId: null,
            memberAgentIds: ['shared-agent', 'other-agent'],
          },
        ]),
      },
    });

    const result = await service.listTeams({ projectId: PROJECT_ID });

    expect(result).toEqual([
      {
        id: 'team-x',
        name: 'X',
        teamLeadAgentId: 'lead-1',
        memberAgentIds: ['lead-1', 'shared-agent'],
        memberCount: 2,
      },
      {
        id: 'team-y',
        name: 'Y',
        teamLeadAgentId: null,
        memberAgentIds: ['shared-agent', 'other-agent'],
        memberCount: 2,
      },
    ]);
  });

  it('includes teams with no members (memberAgentIds: [], memberCount: 0) — client decides to omit', async () => {
    const { service } = build({
      teamsService: {
        listTeamsWithMemberIds: jest
          .fn()
          .mockResolvedValue([
            { id: 'empty-team', name: 'Empty', teamLeadAgentId: null, memberAgentIds: [] },
          ]),
      },
    });

    const result = await service.listTeams({ projectId: PROJECT_ID });

    expect(result).toEqual([
      {
        id: 'empty-team',
        name: 'Empty',
        teamLeadAgentId: null,
        memberAgentIds: [],
        memberCount: 0,
      },
    ]);
  });

  describe('chat.listSessions', () => {
    it('delegates to SessionLifecycleFacade.listAgentHistory and returns the history DTO', async () => {
      const history = {
        items: [{ id: SESSION_A }],
        nextCursor: 'NEXT',
        hasMore: true,
        total: 1,
      };
      const listAgentHistory = jest.fn().mockResolvedValue(history);
      const { service } = build({ sessionLifecycle: { listAgentHistory } });

      const result = await service.listSessions({
        agentId: AGENT_A,
        projectId: PROJECT_ID,
        cursor: 'CUR',
        limit: 50,
      });

      expect(listAgentHistory).toHaveBeenCalledWith(AGENT_A, PROJECT_ID, 'CUR', 50);
      expect(result).toEqual(history);
    });

    it('defaults the page size to 20 when limit is omitted', async () => {
      const listAgentHistory = jest
        .fn()
        .mockResolvedValue({ items: [], nextCursor: null, hasMore: false, total: 0 });
      const { service } = build({ sessionLifecycle: { listAgentHistory } });

      await service.listSessions({ agentId: AGENT_A, projectId: PROJECT_ID });

      expect(listAgentHistory).toHaveBeenCalledWith(AGENT_A, PROJECT_ID, undefined, 20);
    });
  });

  describe('chat.deleteSessionRecord', () => {
    it('delegates to SessionLifecycleFacade.deleteSessionRecord', async () => {
      const deleteSessionRecord = jest.fn().mockResolvedValue({ deleted: true });
      const { service } = build({ sessionLifecycle: { deleteSessionRecord } });

      const result = await service.deleteSessionRecord({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
      });

      expect(deleteSessionRecord).toHaveBeenCalledWith(SESSION_A, PROJECT_ID);
      expect(result).toEqual({ deleted: true });
    });

    it('propagates a STATUS_RUNNING ConflictError from the facade', async () => {
      const deleteSessionRecord = jest
        .fn()
        .mockRejectedValue(
          new ConflictError('Cannot delete a running session', { code: 'STATUS_RUNNING' }),
        );
      const { service } = build({ sessionLifecycle: { deleteSessionRecord } });

      await expect(
        service.deleteSessionRecord({ sessionId: SESSION_A, projectId: PROJECT_ID }),
      ).rejects.toMatchObject({ code: 'conflict', details: { code: 'STATUS_RUNNING' } });
    });
  });

  describe('chat.renameSession', () => {
    it('delegates to SessionLifecycleFacade.renameSession with the trimmed name', async () => {
      const renameSession = jest.fn().mockResolvedValue({ id: SESSION_A, name: 'My Session' });
      const { service } = build({ sessionLifecycle: { renameSession } });

      const result = await service.renameSession({
        sessionId: SESSION_A,
        projectId: PROJECT_ID,
        name: 'My Session',
      });

      expect(renameSession).toHaveBeenCalledWith(SESSION_A, PROJECT_ID, 'My Session');
      expect(result).toMatchObject({ name: 'My Session' });
    });

    it('passes null through to clear the name', async () => {
      const renameSession = jest.fn().mockResolvedValue({ id: SESSION_A, name: null });
      const { service } = build({ sessionLifecycle: { renameSession } });

      await service.renameSession({ sessionId: SESSION_A, projectId: PROJECT_ID, name: null });

      expect(renameSession).toHaveBeenCalledWith(SESSION_A, PROJECT_ID, null);
    });
  });
});

const TEAM_A = '21212121-2121-4121-8121-212121212121';
const OTHER_PROJECT = '31313131-3131-4131-8131-313131313131';

function makeProfile(id: string, name: string, projectId: string = PROJECT_ID) {
  return {
    id,
    projectId,
    name,
    familySlug: null,
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('MobileChatRpcService.listProfiles', () => {
  it("teamId given → the team's linked profiles (facade), resolved + in facade order", async () => {
    const { service, teamsService, storage } = build({
      teamsService: {
        listLinkedProfileIdsForTeam: jest.fn().mockResolvedValue([PROFILE_REVIEWER, PROFILE_CODER]),
      },
      storage: {
        listAgentProfiles: jest.fn().mockResolvedValue({
          items: [makeProfile(PROFILE_CODER, 'Coder'), makeProfile(PROFILE_REVIEWER, 'Reviewer')],
        }),
      },
    });

    const out = await service.listProfiles({ projectId: PROJECT_ID, teamId: TEAM_A });

    expect(teamsService.listLinkedProfileIdsForTeam).toHaveBeenCalledWith(PROJECT_ID, TEAM_A);
    expect(storage.listAgentProfiles).toHaveBeenCalledWith({ projectId: PROJECT_ID, limit: 1000 });
    expect(out).toEqual([
      { id: PROFILE_REVIEWER, name: 'Reviewer', familySlug: null },
      { id: PROFILE_CODER, name: 'Coder', familySlug: null },
    ]);
  });

  it('no teamId → the standalone (unlinked) set', async () => {
    const { service, teamsService } = build({
      teamsService: { listUnlinkedProfileIds: jest.fn().mockResolvedValue([PROFILE_CODER]) },
      storage: {
        listAgentProfiles: jest
          .fn()
          .mockResolvedValue({ items: [makeProfile(PROFILE_CODER, 'Coder')] }),
      },
    });

    const out = await service.listProfiles({ projectId: PROJECT_ID });

    expect(teamsService.listUnlinkedProfileIds).toHaveBeenCalledWith(PROJECT_ID);
    expect(out).toEqual([{ id: PROFILE_CODER, name: 'Coder', familySlug: null }]);
  });

  it('null teamId is treated as no team (standalone set)', async () => {
    const { service, teamsService } = build({
      teamsService: { listUnlinkedProfileIds: jest.fn().mockResolvedValue([]) },
    });

    await service.listProfiles({ projectId: PROJECT_ID, teamId: null });

    expect(teamsService.listUnlinkedProfileIds).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('drops a profile id that does not resolve within the project (defense-in-depth)', async () => {
    const { service } = build({
      teamsService: {
        listUnlinkedProfileIds: jest
          .fn()
          .mockResolvedValue([PROFILE_CODER, '00000000-0000-4000-8000-000000000000']),
      },
      storage: {
        listAgentProfiles: jest
          .fn()
          .mockResolvedValue({ items: [makeProfile(PROFILE_CODER, 'Coder')] }),
      },
    });

    const out = await service.listProfiles({ projectId: PROJECT_ID });

    expect(out).toEqual([{ id: PROFILE_CODER, name: 'Coder', familySlug: null }]);
  });

  it('propagates the facade rejection for a cross-project teamId (no profile fetch)', async () => {
    const listAgentProfiles = jest.fn();
    const { service } = build({
      teamsService: {
        listLinkedProfileIdsForTeam: jest.fn().mockRejectedValue(
          new ForbiddenError('Team does not belong to the requested project', {
            code: 'TEAM_PROJECT_MISMATCH',
          }),
        ),
      },
      storage: { listAgentProfiles },
    });

    await expect(
      service.listProfiles({ projectId: PROJECT_ID, teamId: TEAM_A }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(listAgentProfiles).not.toHaveBeenCalled();
  });

  it('empty id set → [] without resolving profiles', async () => {
    const listAgentProfiles = jest.fn();
    const { service } = build({
      teamsService: { listUnlinkedProfileIds: jest.fn().mockResolvedValue([]) },
      storage: { listAgentProfiles },
    });

    expect(await service.listProfiles({ projectId: PROJECT_ID })).toEqual([]);
    expect(listAgentProfiles).not.toHaveBeenCalled();
  });
});

// ---- T2: chat.createTeamAgent / createIndependentAgent / deleteAgent ----

describe('MobileChatRpcService.createTeamAgent', () => {
  it('delegates to the facade and maps the created agent with its teamId', async () => {
    const createTeamAgentForChat = jest
      .fn()
      .mockResolvedValue(agent({ id: AGENT_A, name: 'New Member', description: 'd' }));
    const { service } = build({ teamsService: { createTeamAgentForChat } });

    const out = await service.createTeamAgent({
      projectId: PROJECT_ID,
      teamId: TEAM_A,
      name: 'New Member',
      providerConfigId: CONFIG_CLAUDE,
    });

    expect(createTeamAgentForChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        teamId: TEAM_A,
        name: 'New Member',
        providerConfigId: CONFIG_CLAUDE,
      }),
    );
    expect(out).toEqual({
      id: AGENT_A,
      name: 'New Member',
      profileId: PROFILE_CODER,
      providerConfigId: CONFIG_CLAUDE,
      description: 'd',
      teamId: TEAM_A,
    });
  });
});

describe('MobileChatRpcService.createIndependentAgent', () => {
  it('delegates to the facade and maps the result with teamId: null', async () => {
    const createIndependentAgentForChat = jest
      .fn()
      .mockResolvedValue(agent({ id: AGENT_A, name: 'Solo', description: null }));
    const { service } = build({ teamsService: { createIndependentAgentForChat } });

    const out = await service.createIndependentAgent({
      projectId: PROJECT_ID,
      name: 'Solo',
      profileId: PROFILE_CODER,
      providerConfigId: CONFIG_CLAUDE,
    });

    expect(createIndependentAgentForChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        name: 'Solo',
        profileId: PROFILE_CODER,
        providerConfigId: CONFIG_CLAUDE,
      }),
    );
    expect(out).toEqual({
      id: AGENT_A,
      name: 'Solo',
      profileId: PROFILE_CODER,
      providerConfigId: CONFIG_CLAUDE,
      description: null,
      teamId: null,
    });
  });
});

describe('MobileChatRpcService.deleteAgent', () => {
  it('project-guards FIRST, then delegates, and returns { deleted: true }', async () => {
    const deleteAgentForChat = jest.fn().mockResolvedValue(undefined);
    const { service } = build({
      storage: { getAgent: jest.fn().mockResolvedValue(agent({ id: AGENT_A })) },
      teamsService: { deleteAgentForChat },
    });

    const out = await service.deleteAgent({ projectId: PROJECT_ID, agentId: AGENT_A });

    expect(deleteAgentForChat).toHaveBeenCalledWith({ projectId: PROJECT_ID, agentId: AGENT_A });
    expect(out).toEqual({ deleted: true });
  });

  it('rejects a cross-project agentId (AGENT_PROJECT_MISMATCH) before delegating', async () => {
    const deleteAgentForChat = jest.fn();
    const { service } = build({
      storage: {
        getAgent: jest.fn().mockResolvedValue(agent({ id: AGENT_A, projectId: OTHER_PROJECT })),
      },
      teamsService: { deleteAgentForChat },
    });

    await expect(
      service.deleteAgent({ projectId: PROJECT_ID, agentId: AGENT_A }),
    ).rejects.toMatchObject({ details: { code: 'AGENT_PROJECT_MISMATCH' } });
    expect(deleteAgentForChat).not.toHaveBeenCalled();
  });
});

describe('MobileChatRpcService.listProfileConfigs', () => {
  function makeConfig(over: Partial<Record<string, unknown>>): Record<string, unknown> {
    return {
      id: CONFIG_CLAUDE,
      profileId: PROFILE_CODER,
      providerId: PROVIDER_CLAUDE,
      providerName: 'claude',
      name: 'Claude cfg',
      description: null,
      options: null,
      env: null,
      position: 0,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...over,
    };
  }

  it('returns ALL of the profile configs (DEC-1) mapped to the result type', async () => {
    const { service, storage } = build({
      storage: {
        getAgentProfile: jest.fn().mockResolvedValue(makeProfile(PROFILE_CODER, 'Coder')),
        listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([
          makeConfig({
            id: CONFIG_CLAUDE,
            providerId: PROVIDER_CLAUDE,
            providerName: 'claude',
            name: 'Claude cfg',
            position: 0,
          }),
          makeConfig({
            id: CONFIG_CODEX,
            providerId: PROVIDER_CODEX,
            providerName: 'codex',
            name: 'Codex cfg',
            position: 1,
          }),
        ]),
      },
    });

    const out = await service.listProfileConfigs({
      projectId: PROJECT_ID,
      profileId: PROFILE_CODER,
    });

    expect(storage.listProfileProviderConfigsByProfile).toHaveBeenCalledWith(PROFILE_CODER);
    expect(out).toEqual([
      {
        id: CONFIG_CLAUDE,
        profileId: PROFILE_CODER,
        providerId: PROVIDER_CLAUDE,
        providerName: 'claude',
        name: 'Claude cfg',
        position: 0,
      },
      {
        id: CONFIG_CODEX,
        profileId: PROFILE_CODER,
        providerId: PROVIDER_CODEX,
        providerName: 'codex',
        name: 'Codex cfg',
        position: 1,
      },
    ]);
  });

  it('rejects a cross-project profileId BEFORE reading configs (security boundary)', async () => {
    const listConfigs = jest.fn();
    const { service } = build({
      storage: {
        getAgentProfile: jest
          .fn()
          .mockResolvedValue(makeProfile(PROFILE_CODER, 'Coder', OTHER_PROJECT)),
        listProfileProviderConfigsByProfile: listConfigs,
      },
    });

    await expect(
      service.listProfileConfigs({ projectId: PROJECT_ID, profileId: PROFILE_CODER }),
    ).rejects.toMatchObject({ details: { code: 'PROFILE_PROJECT_MISMATCH' } });
    expect(listConfigs).not.toHaveBeenCalled();
  });

  it('propagates NotFoundError for an unknown profileId', async () => {
    const { service } = build({
      storage: {
        getAgentProfile: jest
          .fn()
          .mockRejectedValue(new NotFoundError('AgentProfile', PROFILE_CODER)),
      },
    });

    await expect(
      service.listProfileConfigs({ projectId: PROJECT_ID, profileId: PROFILE_CODER }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
