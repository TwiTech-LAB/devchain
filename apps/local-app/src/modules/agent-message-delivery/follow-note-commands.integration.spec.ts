/**
 * Layer: backend-integration
 * Justification: the follow-note command rule lives in terminal delivery, but the
 * text it inspects is produced upstream by the formatter and the message pool. Only
 * the real chain (action or phone message → AMD → pool → TerminalIOService) shows
 * whether a command still reaches the pane without the note.
 */

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../common/logging/logger', () => ({
  createLogger: () => mockLogger,
}));

import { AgentMessageDeliveryService } from './agent-message-delivery.service';
import { LegacyDeliveryFormatterAdapter } from './adapters/legacy-delivery-formatter.adapter';
import type { DeliveryRecipientResolver } from './ports/delivery-recipient-resolver';
import { sendMessageAction } from '../subscribers/actions/send-message.action';
import type { ActionContext } from '../subscribers/actions/action.interface';
import { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import { SessionsMessagePoolService } from '../sessions/services/sessions-message-pool.service';
import { MessageLogService } from '../sessions/services/message-log.service';
import type { SessionsService } from '../sessions/services/sessions.service';
import type { SessionCoordinatorService } from '../sessions/services/session-coordinator.service';
import type { MessageActivityStreamService } from '../sessions/services/message-activity-stream.service';
import type { DeliveryFailureNotifierService } from '../sessions/services/delivery-failure-notifier.service';
import type { SessionLauncherFacade } from '../sessions/services/session-launcher-facade.service';
import type { ActiveSessionLookup } from '../sessions/services/active-session-lookup.service';
import type { SettingsService } from '../settings/services/settings.service';
import type { StorageService } from '../storage/interfaces/storage.interface';
import type { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import type { EventsService } from '../events/services/events.service';
import type { GuestDeliveryService } from '../terminal/services/guest-delivery.service';
import { HumanPromptStateService } from '../terminal/services/human-prompt-state.service';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { FOLLOW_NOTE } from '../../common/follow-note';
import { FakeProcessExecutor } from '../terminal/services/process-executor/fake-process-executor';
import { createMockSession } from '../../../test/factories/session';

const AGENT_ID = 'agent-1';
const PROJECT_ID = 'project-1';
const TMUX = 'tmux-1';

function buildChain(followNoteEnabled = true) {
  const executor = new FakeProcessExecutor();
  const humanPromptState = new HumanPromptStateService();
  const terminalIO = new TerminalIOService(
    executor,
    { publish: jest.fn() } as unknown as EventsService,
    humanPromptState,
    { getFollowNoteEnabled: () => followNoteEnabled } as unknown as SettingsService,
  );

  const activeSession = createMockSession({
    id: 'session-1',
    agentId: AGENT_ID,
    tmuxSessionId: TMUX,
    lastActivityAt: null,
    activityState: 'busy',
    busySince: new Date().toISOString(),
    transcriptPath: null,
    name: null,
  });
  const sessions = {
    listActiveSessions: jest.fn().mockResolvedValue([activeSession]),
    getActiveSessionForAgent: jest.fn().mockReturnValue(activeSession),
    getSession: jest.fn().mockReturnValue(activeSession),
  };
  const poolConfig = {
    enabled: true,
    delayMs: 10000,
    maxWaitMs: 30000,
    maxMessages: 10,
    separator: '\n---\n',
  };

  const pool = new SessionsMessagePoolService(
    sessions as unknown as SessionsService,
    {
      withAgentLock: jest.fn().mockImplementation(async (_id: string, fn: () => unknown) => fn()),
    } as unknown as SessionCoordinatorService,
    terminalIO,
    {
      getMessagePoolConfig: jest.fn().mockReturnValue(poolConfig),
      getMessagePoolConfigForProject: jest.fn().mockReturnValue(poolConfig),
    } as unknown as SettingsService,
    {
      getAgent: jest.fn().mockResolvedValue({ id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID }),
    } as unknown as StorageService,
    {
      broadcastEnqueued: jest.fn(),
      broadcastDelivered: jest.fn(),
      broadcastUnconfirmed: jest.fn(),
      broadcastFailed: jest.fn(),
      broadcastPoolsUpdated: jest.fn(),
    } as unknown as MessageActivityStreamService,
    {
      // A Claude agent: the provider that gets the follow note.
      getRuntimePromptBehaviorForAgent: jest
        .fn()
        .mockResolvedValue({ postPasteDelayMs: 0, followNote: true }),
    } as unknown as ProviderAdapterFactory,
    new MessageLogService(),
    {
      notifySendersOfFailure: jest.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryFailureNotifierService,
    humanPromptState,
  );

  const resolver: DeliveryRecipientResolver = {
    resolve: jest.fn().mockImplementation(async (ids: string[]) => ({ agentIds: ids })),
  };
  const amd = new AgentMessageDeliveryService(
    resolver,
    { ensureActiveSession: jest.fn() } as unknown as SessionLauncherFacade,
    new LegacyDeliveryFormatterAdapter(),
    new MessageEnqueueService(pool),
    {} as GuestDeliveryService,
    {
      getActiveSession: jest.fn().mockResolvedValue({ ...activeSession, projectId: PROJECT_ID }),
    } as unknown as ActiveSessionLookup,
    { publish: jest.fn() } as unknown as EventsService,
  );

  return { executor, pool, amd };
}

function runAutomation(amd: AgentMessageDeliveryService, text: string) {
  const context = {
    amd,
    storage: {},
    sessionId: 'session-1',
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    tmuxSessionName: TMUX,
    event: {
      eventName: 'terminal.watcher.triggered',
      projectId: PROJECT_ID,
      agentId: AGENT_ID,
      sessionId: 'session-1',
      occurredAt: new Date().toISOString(),
      payload: {},
    },
    logger: mockLogger,
  } as unknown as ActionContext;
  return sendMessageAction.execute(context, { text, deliveryMode: 'immediate' });
}

// Mirrors MobileChatRpcService's send for an unpaired (plain) phone message.
function sendPlainPhoneMessage(amd: AgentMessageDeliveryService, text: string) {
  return amd.deliver(
    [AGENT_ID],
    {
      kind: 'mcp.direct',
      body: text,
      source: 'mobile',
      projectId: PROJECT_ID,
      senderName: 'Mobile User',
      senderType: 'user',
      framing: 'plain',
    },
    { immediate: true, requireActiveSession: true },
  );
}

function paneWrites(executor: FakeProcessExecutor) {
  return executor.calls.filter((c) => c.argv[1] === 'paste-buffer' || c.argv[1] === 'send-keys');
}

function noteWrites(executor: FakeProcessExecutor) {
  return executor.calls.filter((c) => c.argv.includes(FOLLOW_NOTE));
}

describe('follow note for commands sent through DevChain', () => {
  let chain: ReturnType<typeof buildChain>;

  beforeEach(() => {
    chain = buildChain();
  });

  afterEach(async () => {
    await chain.pool.onModuleDestroy();
  });

  it.each([
    { source: 'automation', text: '/compact', enabled: true, notes: 0 },
    { source: 'automation', text: 'Please re-run the failing tests.', enabled: true, notes: 1 },
    { source: 'phone', text: '/compact', enabled: true, notes: 0 },
    { source: 'phone', text: 'How is the build going?', enabled: true, notes: 1 },
    { source: 'automation', text: 'Please re-run the failing tests.', enabled: false, notes: 0 },
  ])(
    '$source delivers $text with notes=$notes when enabled=$enabled',
    async ({ source, text, enabled, notes }) => {
      chain = buildChain(enabled);
      if (source === 'automation') {
        expect((await runAutomation(chain.amd, text)).success).toBe(true);
      } else {
        expect((await sendPlainPhoneMessage(chain.amd, text)).results[0]?.status).toBe('delivered');
      }
      expect(paneWrites(chain.executor).map((c) => c.argv[1])).toEqual(
        notes ? ['paste-buffer', 'send-keys', 'send-keys'] : ['paste-buffer', 'send-keys'],
      );
      expect(noteWrites(chain.executor)).toHaveLength(notes);
    },
  );
});
