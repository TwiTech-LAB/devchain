/**
 * Layer: backend-integration
 * Justification: This in-process workflow is the cheapest layer that keeps the
 * real project communication, delivery, enqueue, pool, log/activity, and
 * notifier boundaries together, so dropping the disclosure policy at any
 * adapter boundary fails one observable-sink assertion.
 */

type CapturedLogger = {
  error: jest.Mock;
  warn: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
};

const mockStructuredLoggers = new Map<string, CapturedLogger>();

function mockStructuredLogger(name: string): CapturedLogger {
  let logger = mockStructuredLoggers.get(name);
  if (!logger) {
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
    mockStructuredLoggers.set(name, logger);
  }
  return logger;
}

jest.mock('../../common/logging/logger', () => ({
  createLogger: (name: string) => mockStructuredLogger(name),
}));

import { Logger } from '@nestjs/common';
import { resetEnvConfig } from '../../common/config/env.config';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { LegacyDeliveryFormatterAdapter } from '../agent-message-delivery/adapters/legacy-delivery-formatter.adapter';
import { DeliveryFailureNotifierService } from '../sessions/services/delivery-failure-notifier.service';
import { MessageActivityStreamService } from '../sessions/services/message-activity-stream.service';
import { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import { MessageLogService } from '../sessions/services/message-log.service';
import { SessionsMessagePoolService } from '../sessions/services/sessions-message-pool.service';
import { createMockAgent } from '../../../test/factories/agent';
import { createMockProject } from '../../../test/factories/project';
import { ProjectCommunicationService } from './project-communication.service';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CALLER_ID = 'source-owner';
const TARGET_OWNER_ID = 'target-owner';
const RAW_SENTINEL = 'tmux failed at /tmp/tmux-1000/default provider=example';

describe('project delivery failure redaction workflow', () => {
  let poolingEnabled: boolean;
  let projectCommunication: ProjectCommunicationService;
  let messageEnqueue: MessageEnqueueService;
  let pool: SessionsMessagePoolService;
  let terminalIO: {
    deliver: jest.Mock;
    deliverImmediate: jest.Mock;
  };
  let broadcaster: { broadcastEvent: jest.Mock };
  let nestLoggerError: jest.SpyInstance;

  const sourceProject = createMockProject({
    id: SOURCE_ID,
    name: 'Source Project',
    rootPath: '/private/source',
  });
  const targetProject = createMockProject({
    id: TARGET_ID,
    name: 'Target Project',
    rootPath: '/private/target',
  });
  const caller = createMockAgent({
    id: CALLER_ID,
    name: 'Source Owner',
    projectId: SOURCE_ID,
    isProjectOwner: true,
  });
  const targetOwner = createMockAgent({
    id: TARGET_OWNER_ID,
    name: 'Target Owner',
    projectId: TARGET_ID,
    isProjectOwner: true,
  });

  beforeEach(() => {
    poolingEnabled = true;
    mockStructuredLoggers.forEach((logger) => {
      logger.error.mockClear();
      logger.warn.mockClear();
      logger.info.mockClear();
      logger.debug.mockClear();
    });
    nestLoggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    process.env.DEVCHAIN_MODE = 'main';
    delete process.env.CONTAINER_PROJECT_ID;
    resetEnvConfig();

    const storage = {
      getAgent: jest.fn(async (agentId: string) => {
        if (agentId === CALLER_ID) return caller;
        if (agentId === TARGET_OWNER_ID) return targetOwner;
        throw new Error(`Unknown agent ${agentId}`);
      }),
      getProject: jest.fn(async (projectId: string) => {
        if (projectId === SOURCE_ID) return sourceProject;
        if (projectId === TARGET_ID) return targetProject;
        throw new Error(`Unknown project ${projectId}`);
      }),
      getProjectsByIdPrefix: jest.fn().mockResolvedValue([targetProject]),
      listProjectOwners: jest.fn().mockResolvedValue([targetOwner]),
    };
    const sessions = {
      listActiveSessions: jest.fn().mockResolvedValue([
        {
          id: 'target-session',
          agentId: TARGET_OWNER_ID,
          tmuxSessionId: 'tmux-target',
          status: 'running',
        },
        {
          id: 'source-session',
          agentId: CALLER_ID,
          tmuxSessionId: 'tmux-source',
          status: 'running',
        },
      ]),
    };
    const coordinator = {
      withAgentLock: jest
        .fn()
        .mockImplementation(async (_agentId: string, work: () => Promise<unknown>) => work()),
    };
    terminalIO = {
      deliver: jest.fn().mockRejectedValue(new Error(RAW_SENTINEL)),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'notice-nonce', retryCount: 0 }),
    };
    const settings = {
      getMessagePoolConfig: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 60_000,
        maxWaitMs: 120_000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
      getMessagePoolConfigForProject: jest.fn().mockImplementation(() => ({
        enabled: poolingEnabled,
        delayMs: 60_000,
        maxWaitMs: 120_000,
        maxMessages: 10,
        separator: '\n---\n',
      })),
    };
    broadcaster = { broadcastEvent: jest.fn() };
    const activityStream = new MessageActivityStreamService(broadcaster as never);
    const messageLog = new MessageLogService();
    const providerAdapterFactory = {
      getPostPasteDelayMsForAgent: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = new DeliveryFailureNotifierService(terminalIO as never, sessions as never);
    pool = new SessionsMessagePoolService(
      sessions as never,
      coordinator as never,
      terminalIO as never,
      settings as never,
      storage as never,
      activityStream,
      providerAdapterFactory as never,
      messageLog,
      notifier,
    );
    messageEnqueue = new MessageEnqueueService(pool);

    const delivery = new AgentMessageDeliveryService(
      {
        resolve: jest.fn(async (recipients: string[]) => ({ agentIds: recipients })),
      } as never,
      {
        ensureActiveSession: jest.fn().mockResolvedValue({
          sessionId: 'target-session',
          agentId: TARGET_OWNER_ID,
          projectId: TARGET_ID,
          status: 'running',
          tmuxSessionId: 'tmux-target',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: null,
        }),
      } as never,
      new LegacyDeliveryFormatterAdapter(),
      messageEnqueue,
      { deliverToGuest: jest.fn() } as never,
      { getActiveSession: jest.fn() } as never,
      { publish: jest.fn().mockResolvedValue('event-1') } as never,
    );
    projectCommunication = new ProjectCommunicationService(storage as never, delivery);
  });

  afterEach(async () => {
    await pool.flushAll();
    nestLoggerError.mockRestore();
    delete process.env.DEVCHAIN_MODE;
    delete process.env.CONTAINER_PROJECT_ID;
    resetEnvConfig();
  });

  it('redacts a pooling-disabled project failure at every observable sink', async () => {
    poolingEnabled = false;

    const result = await sendProjectMessage();
    const logEntry = pool.getMessageLog()[0];
    const failedActivity = failedActivityPayloads()[0];
    const observables = {
      result,
      logEntry,
      messageRead: pool.getMessageById(logEntry.id),
      failedActivity,
      structuredLogs: allStructuredLoggerCalls(),
      nestLogs: nestLoggerError.mock.calls,
    };

    expect(result).toMatchObject({
      result: {
        deliveryStatus: 'failed',
        error: { code: 'DELIVERY_FAILED' },
      },
    });
    expect(logEntry).toMatchObject({
      status: 'failed',
      error: 'DELIVERY_FAILED',
      failureCode: 'project_delivery_failed',
    });
    expect(failedActivity).toMatchObject({
      error: 'DELIVERY_FAILED',
      failureCode: 'project_delivery_failed',
    });
    expect(serializeObserved(observables)).not.toContain(RAW_SENTINEL);
    expect(serializeObserved(loggerCalls('SessionsMessagePoolService'))).toContain(
      'DELIVERY_FAILED',
    );
  });

  it('redacts a delayed pooled failure through flush and the source-owner notice', async () => {
    const enqueueResult = await sendProjectMessage();
    expect(enqueueResult).toMatchObject({ result: { deliveryStatus: 'queued' } });

    const flushResult = await pool.flushNow(TARGET_OWNER_ID);
    const logEntry = pool.getMessageLog()[0];
    const failedActivity = failedActivityPayloads()[0];
    const noticeText = terminalIO.deliverImmediate.mock.calls[0][1];
    const observables = {
      enqueueResult,
      flushResult,
      logEntry,
      messageRead: pool.getMessageById(logEntry.id),
      failedActivity,
      noticeText,
      structuredLogs: allStructuredLoggerCalls(),
      nestLogs: nestLoggerError.mock.calls,
    };

    expect(flushResult).toEqual({
      success: false,
      discardedCount: 1,
      reason: 'DELIVERY_FAILED',
    });
    expect(logEntry).toMatchObject({
      error: 'DELIVERY_FAILED',
      failureCode: 'project_delivery_failed',
    });
    expect(failedActivity).toMatchObject({
      error: 'DELIVERY_FAILED',
      failureCode: 'project_delivery_failed',
    });
    expect(noticeText).toContain('DELIVERY_FAILED');
    expect(noticeText).not.toContain(RAW_SENTINEL);
    expect(serializeObserved(observables)).not.toContain(RAW_SENTINEL);
    expect(serializeObserved(loggerCalls('SessionsMessagePoolService'))).toContain(
      'DELIVERY_FAILED',
    );
    expect(serializeObserved(loggerCalls('DeliveryFailureNotifier'))).toContain('DELIVERY_FAILED');
  });

  it('uses project-safe disclosure for shared mixed-batch and notifier surfaces', async () => {
    await messageEnqueue.enqueue([
      {
        agentId: TARGET_OWNER_ID,
        text: 'legacy message',
        source: 'legacy.manual',
        senderAgentId: CALLER_ID,
        projectId: TARGET_ID,
        agentName: targetOwner.name,
      },
    ]);
    await sendProjectMessage();

    const flushResult = await pool.flushNow(TARGET_OWNER_ID);
    const entries = pool.getMessageLog();
    const legacyEntry = entries.find((entry) => entry.source === 'legacy.manual');
    const projectEntry = entries.find((entry) => entry.source === 'mcp.send_message');
    const noticeText = terminalIO.deliverImmediate.mock.calls[0][1];

    expect(flushResult.reason).toBe('DELIVERY_FAILED');
    expect(legacyEntry).toMatchObject({ error: RAW_SENTINEL, failureCode: 'tmux_error' });
    expect(projectEntry).toMatchObject({
      error: 'DELIVERY_FAILED',
      failureCode: 'project_delivery_failed',
    });
    expect(
      failedActivityPayloads().find((payload) => payload.source === 'mcp.send_message'),
    ).toMatchObject({ error: 'DELIVERY_FAILED', failureCode: 'project_delivery_failed' });
    expect(noticeText).toContain('DELIVERY_FAILED');
    expect(noticeText).not.toContain(RAW_SENTINEL);
    expect(serializeObserved(loggerCalls('SessionsMessagePoolService'))).not.toContain(
      RAW_SENTINEL,
    );
    expect(serializeObserved(loggerCalls('DeliveryFailureNotifier'))).not.toContain(RAW_SENTINEL);
  });

  it('retains raw failure semantics for an all-legacy batch', async () => {
    await messageEnqueue.enqueue([
      {
        agentId: TARGET_OWNER_ID,
        text: 'legacy message',
        source: 'legacy.manual',
        senderAgentId: CALLER_ID,
        projectId: TARGET_ID,
        agentName: targetOwner.name,
      },
    ]);

    const flushResult = await pool.flushNow(TARGET_OWNER_ID);
    const logEntry = pool.getMessageLog()[0];
    const noticeText = terminalIO.deliverImmediate.mock.calls[0][1];

    expect(flushResult.reason).toBe(RAW_SENTINEL);
    expect(logEntry).toMatchObject({ error: RAW_SENTINEL, failureCode: 'tmux_error' });
    expect(failedActivityPayloads()[0]).toMatchObject({ error: RAW_SENTINEL });
    expect(noticeText).toContain(RAW_SENTINEL);
    expect(serializeObserved(loggerCalls('SessionsMessagePoolService'))).toContain(RAW_SENTINEL);
    expect(serializeObserved(loggerCalls('DeliveryFailureNotifier'))).toContain(RAW_SENTINEL);
  });

  function sendProjectMessage() {
    return projectCommunication.sendToProject({
      callerAgentId: CALLER_ID,
      recipientProjectId: TARGET_ID.slice(0, 8),
      message: 'cross-project message',
    });
  }

  function failedActivityPayloads(): Record<string, unknown>[] {
    return broadcaster.broadcastEvent.mock.calls
      .filter(([, type]) => type === 'failed')
      .map(([, , payload]) => payload as Record<string, unknown>);
  }

  function loggerCalls(name: string): unknown[] {
    const logger = mockStructuredLoggers.get(name);
    return logger
      ? [
          logger.error.mock.calls,
          logger.warn.mock.calls,
          logger.info.mock.calls,
          logger.debug.mock.calls,
        ]
      : [];
  }

  function allStructuredLoggerCalls(): unknown[] {
    return Array.from(mockStructuredLoggers.keys()).flatMap((name) => loggerCalls(name));
  }

  function serializeObserved(value: unknown): string {
    return JSON.stringify(value, (_key, nestedValue: unknown) =>
      nestedValue instanceof Error
        ? { name: nestedValue.name, message: nestedValue.message, stack: nestedValue.stack }
        : nestedValue,
    );
  }
});
