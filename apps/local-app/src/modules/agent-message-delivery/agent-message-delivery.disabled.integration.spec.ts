/**
 * Layer: backend-integration
 * Justification: the races are between the delivery service's flag check, the pool's admission
 * and dispatch, the terminal's first write and the Disable steps in the lifecycle facade. Only
 * the real delivery service, enqueue service, pool, message log, coordinator, facade and
 * terminal service show whether a raced message reaches the pane. The process executor records
 * the tmux commands instead of running them; sessions and storage are small fakes whose state
 * the test changes at the paused points.
 */

jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

import { AgentMessageDeliveryService } from './agent-message-delivery.service';
import { LegacyDeliveryFormatterAdapter } from './adapters/legacy-delivery-formatter.adapter';
import { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import { SessionsMessagePoolService } from '../sessions/services/sessions-message-pool.service';
import { SessionCoordinatorService } from '../sessions/services/session-coordinator.service';
import { SessionLifecycleFacade } from '../sessions/services/session-lifecycle-facade.service';
import { MessageLogService } from '../sessions/services/message-log.service';
import { HumanPromptStateService } from '../terminal/services/human-prompt-state.service';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { CliForegroundExecutor } from '../terminal/services/process-executor/fake-process-executor';
import { createMockSession } from '../../../test/factories/session';

const AGENT_ID = 'agent-1';
const PROJECT_ID = 'project-1';

type Session = ReturnType<typeof createMockSession>;

function session(id: string): Session {
  return createMockSession({ id, agentId: AGENT_ID, tmuxSessionId: `tmux-${id}` });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function buildChain(poolEnabled = true) {
  const state = { disabled: false, activeSession: session('original') as Session | null };
  const poolConfig = {
    enabled: poolEnabled,
    delayMs: 10_000,
    maxWaitMs: 30_000,
    maxMessages: 10,
    separator: '\n---\n',
  };
  const storage = {
    isAgentDisabled: () => state.disabled,
    getAgent: async () => ({ id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID }),
  };
  let stopGate: Promise<void> = Promise.resolve();
  const sessions = {
    listActiveSessions: async () => (state.activeSession ? [state.activeSession] : []),
    getActiveSessionForAgent: () => state.activeSession,
    getSession: () => state.activeSession,
    terminateSession: async () => {
      await stopGate;
      state.activeSession = null;
    },
  };
  const executor = new CliForegroundExecutor();
  const humanPromptState = new HumanPromptStateService();
  const terminalIO = new TerminalIOService(
    executor,
    { publish: jest.fn() } as never,
    humanPromptState,
    { getFollowNoteEnabled: () => false } as never,
  );
  let behaviorGate: Promise<void> = Promise.resolve();
  const coordinator = new SessionCoordinatorService();
  const pool = new SessionsMessagePoolService(
    sessions as never,
    coordinator,
    terminalIO,
    {
      getMessagePoolConfig: () => poolConfig,
      getMessagePoolConfigForProject: () => poolConfig,
    } as never,
    storage as never,
    {
      broadcastEnqueued: jest.fn(),
      broadcastDelivered: jest.fn(),
      broadcastUnconfirmed: jest.fn(),
      broadcastFailed: jest.fn(),
      broadcastPoolsUpdated: jest.fn(),
    } as never,
    {
      getRuntimePromptBehaviorForAgent: async () => {
        await behaviorGate;
        return { postPasteDelayMs: 0 };
      },
    } as never,
    new MessageLogService(),
    { notifySendersOfFailure: jest.fn().mockResolvedValue(undefined) } as never,
    humanPromptState,
  );
  const facade = new SessionLifecycleFacade(
    {} as never,
    sessions as never,
    {} as never,
    coordinator,
    pool,
  );
  const ensureActiveSession = jest.fn(async () => state.activeSession);
  const amd = new AgentMessageDeliveryService(
    { resolve: async (ids: string[]) => ({ agentIds: ids }) } as never,
    { ensureActiveSession } as never,
    new LegacyDeliveryFormatterAdapter(),
    new MessageEnqueueService(pool),
    {} as never,
    {} as never,
    { publish: jest.fn() } as never,
    storage as never,
  );
  /** Disable as TeamsService runs it: the flag write, then the facade's stop. */
  const disable = () => {
    state.disabled = true;
    return facade.stopDisabledAgent(AGENT_ID, { source: 'web-api', reason: 'user-requested' });
  };
  /** Holds the next delivery after its first check, at the session it resolved. */
  const holdNextDelivery = () => {
    let resume!: () => void;
    const resolved = state.activeSession;
    ensureActiveSession.mockImplementationOnce(
      () => new Promise<Session | null>((done) => (resume = () => done(resolved))),
    );
    return () => resume();
  };
  /** Holds the pool's dispatch preparation (the provider read before the terminal call). */
  const holdDispatchPreparation = () => {
    const gate = deferred();
    behaviorGate = gate.promise;
    return gate.resolve;
  };
  /** Delays the session stop that follows Disable. */
  const delayStop = () => {
    const gate = deferred();
    stopGate = gate.promise;
    return gate.resolve;
  };
  const paneWrites = () =>
    executor.calls.filter((c) => c.argv[1] === 'paste-buffer' || c.argv[1] === 'send-keys');
  return {
    state,
    pool,
    amd,
    disable,
    holdNextDelivery,
    holdDispatchPreparation,
    delayStop,
    paneWrites,
  };
}

const message = {
  kind: 'pooled' as const,
  body: 'Please review',
  source: 'test',
  projectId: PROJECT_ID,
  senderName: 'System',
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('message delivery to an agent that is disabled during delivery', () => {
  let chain: ReturnType<typeof buildChain>;

  afterEach(async () => {
    await chain.pool.onModuleDestroy();
  });

  it('refuses a delivery that passed its check before Disable and queues nothing', async () => {
    chain = buildChain();
    const resume = chain.holdNextDelivery();

    const delivery = chain.amd.deliver([AGENT_ID], message);
    await settle();
    await chain.disable();
    resume();

    await expect(delivery).resolves.toEqual({
      status: 'failed',
      results: [{ agentId: AGENT_ID, status: 'failed', error: 'AGENT_DISABLED' }],
    });
    expect(chain.pool.getPoolStats()).toEqual([]);
    expect(chain.pool.getMessageLog({ agentId: AGENT_ID })).toEqual([]);
  });

  it('refuses a delivery held across Disable, Enable and a replacement session', async () => {
    chain = buildChain();
    const resume = chain.holdNextDelivery();

    const delivery = chain.amd.deliver([AGENT_ID], message);
    await settle();
    await chain.disable();
    chain.state.disabled = false;
    chain.state.activeSession = session('replacement');
    resume();

    await expect(delivery).resolves.toMatchObject({
      results: [{ agentId: AGENT_ID, status: 'failed', error: 'AGENT_DISABLED' }],
    });
    expect(chain.pool.getPoolStats()).toEqual([]);
    expect(chain.pool.getMessageLog({ agentId: AGENT_ID })).toEqual([]);
    expect(chain.paneWrites()).toEqual([]);
  });

  it('does not flush a pending message to the original session after the flag commits', async () => {
    chain = buildChain();
    await expect(chain.amd.deliver([AGENT_ID], message)).resolves.toMatchObject({
      status: 'queued',
    });

    chain.state.disabled = true;
    const flush = await chain.pool.flushNow(AGENT_ID);

    expect(flush).toMatchObject({ success: false, reason: 'AGENT_DISABLED' });
    expect(chain.paneWrites()).toEqual([]);
    expect(chain.pool.getPoolStats()).toEqual([]);
    expect(chain.pool.getMessageLog({ agentId: AGENT_ID })).toEqual([
      expect.objectContaining({ status: 'failed', error: 'AGENT_DISABLED' }),
    ]);
  });

  it('fails a message queued before Disable so no later session receives it', async () => {
    chain = buildChain();
    await expect(chain.amd.deliver([AGENT_ID], message)).resolves.toMatchObject({
      status: 'queued',
    });

    await chain.disable();

    expect(chain.pool.getPoolStats()).toEqual([]);
    expect(chain.pool.getMessageLog({ agentId: AGENT_ID })).toEqual([
      expect.objectContaining({ status: 'failed', error: 'AGENT_DISABLED' }),
    ]);
  });

  describe('Disable while dispatch preparation is paused, with the old session present', () => {
    it('writes nothing for a pooled flush and fails the batch', async () => {
      chain = buildChain();
      await chain.pool.enqueue(AGENT_ID, 'Pooled', { source: 'test', projectId: PROJECT_ID });
      const resumePreparation = chain.holdDispatchPreparation();
      const releaseStop = chain.delayStop();

      const flush = chain.pool.flushNow(AGENT_ID);
      await settle();
      const stop = chain.disable();
      resumePreparation();

      await expect(flush).resolves.toMatchObject({ success: false, reason: 'AGENT_DISABLED' });
      expect(chain.state.activeSession).not.toBeNull();
      releaseStop();
      await stop;
      expect(chain.paneWrites()).toEqual([]);
      expect(chain.pool.getMessageLog({ agentId: AGENT_ID })).toEqual([
        expect.objectContaining({ status: 'failed', error: 'AGENT_DISABLED' }),
      ]);
    });

    it.each([
      { name: 'immediate send', poolEnabled: true, deliveryMode: 'immediate' as const },
      { name: 'confirmed send with pooling off', poolEnabled: false, deliveryMode: undefined },
    ])('writes nothing for an $name and returns AGENT_DISABLED', async (variant) => {
      chain = buildChain(variant.poolEnabled);
      const resumePreparation = chain.holdDispatchPreparation();
      const releaseStop = chain.delayStop();

      const send = chain.pool.enqueue(AGENT_ID, 'Now', {
        source: 'test',
        projectId: PROJECT_ID,
        deliveryMode: variant.deliveryMode,
        preKeys: ['Escape'],
      });
      await settle();
      const stop = chain.disable();
      resumePreparation();

      await expect(send).resolves.toMatchObject({ status: 'failed', error: 'AGENT_DISABLED' });
      expect(chain.state.activeSession).not.toBeNull();
      releaseStop();
      await stop;
      expect(chain.paneWrites()).toEqual([]);
      expect(chain.pool.getMessageLog({ agentId: AGENT_ID })).toEqual([
        expect.objectContaining({ status: 'failed', error: 'AGENT_DISABLED' }),
      ]);
    });
  });
});
