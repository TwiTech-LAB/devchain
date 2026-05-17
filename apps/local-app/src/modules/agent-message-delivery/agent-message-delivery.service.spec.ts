/**
 * Smoke tests for AgentMessageDeliveryService public facade.
 *
 * Layer: module-unit
 * Justification: Tests the facade's orchestration logic via injected port mocks.
 */

import { AgentMessageDeliveryService } from './agent-message-delivery.service';
import type { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import type { SessionLauncherFacade } from '../sessions/services/session-launcher-facade.service';
import type { GuestDeliveryService } from '../terminal/services/guest-delivery.service';
import type { DeliveryRecipientResolver } from './ports/delivery-recipient-resolver';
import type { DeliveryFormatter } from './ports/delivery-formatter';
import type { DeliveryMessage, DeliveryPolicy } from './dtos/delivery.types';

function buildService() {
  const resolver: jest.Mocked<DeliveryRecipientResolver> = {
    resolve: jest.fn().mockResolvedValue({ agentIds: ['agent-1'] }),
  };
  const launcher: jest.Mocked<Pick<SessionLauncherFacade, 'ensureActiveSession'>> = {
    ensureActiveSession: jest.fn().mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      projectId: 'project-1',
      status: 'running',
      tmuxSessionId: 'tmux-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: null,
    }),
  };
  const formatter: jest.Mocked<DeliveryFormatter> = {
    format: jest
      .fn()
      .mockImplementation((msg: DeliveryMessage) => `[formatted:${msg.kind}] ${msg.body}`),
  };
  const messageEnqueue: jest.Mocked<Pick<MessageEnqueueService, 'enqueue'>> = {
    enqueue: jest.fn().mockResolvedValue([{ agentId: 'agent-1', status: 'queued', poolSize: 1 }]),
  };
  const guestDelivery: jest.Mocked<Pick<GuestDeliveryService, 'deliverToGuest'>> = {
    deliverToGuest: jest.fn().mockResolvedValue({ delivered: true }),
  };
  const service = new AgentMessageDeliveryService(
    resolver,
    launcher as SessionLauncherFacade,
    formatter,
    messageEnqueue as MessageEnqueueService,
    guestDelivery as GuestDeliveryService,
  );

  return { service, resolver, launcher, formatter, messageEnqueue, guestDelivery };
}

describe('AgentMessageDeliveryService', () => {
  describe('deliver()', () => {
    it('resolves recipients, ensures sessions, formats, and enqueues', async () => {
      const { service, resolver, launcher, formatter, messageEnqueue } = buildService();

      const message: DeliveryMessage = {
        kind: 'mcp.direct',
        body: 'Hello',
        source: 'test',
        projectId: 'project-1',
        senderName: 'Alpha',
        threadId: 'thread-1',
      };
      const policy: DeliveryPolicy = { submitKeys: ['Enter'] };

      const outcome = await service.deliver(['agent-1'], message, policy);

      expect(resolver.resolve).toHaveBeenCalledWith(['agent-1'], { threadId: 'thread-1' });
      expect(launcher.ensureActiveSession).toHaveBeenCalledWith('agent-1', 'project-1');
      expect(formatter.format).toHaveBeenCalledWith(message);
      expect(messageEnqueue.enqueue).toHaveBeenCalledWith([
        expect.objectContaining({
          agentId: 'agent-1',
          text: '[formatted:mcp.direct] Hello',
          source: 'test',
          submitKeys: ['Enter'],
          projectId: 'project-1',
        }),
      ]);
      expect(outcome.status).toBe('queued');
      expect(outcome.results).toHaveLength(1);
    });

    it('returns delivered status for empty recipient list', async () => {
      const { service, resolver } = buildService();
      resolver.resolve.mockResolvedValue({ agentIds: [] });

      const outcome = await service.deliver(
        [],
        { kind: 'mcp.direct', body: 'x', source: 'test', projectId: 'p1', senderName: 'A' },
        {},
      );

      expect(outcome.status).toBe('delivered');
      expect(outcome.results).toHaveLength(0);
    });

    it('returns failed when session launch fails', async () => {
      const { service, launcher } = buildService();
      launcher.ensureActiveSession.mockRejectedValue(new Error('Binary not found'));

      const outcome = await service.deliver(
        ['agent-1'],
        { kind: 'mcp.direct', body: 'x', source: 'test', projectId: 'p1', senderName: 'A' },
        {},
      );

      expect(outcome.status).toBe('failed');
      expect(outcome.results[0].error).toBe('Binary not found');
    });

    it('handles partial failures across multiple recipients', async () => {
      const { service, resolver, launcher, messageEnqueue } = buildService();
      resolver.resolve.mockResolvedValue({ agentIds: ['agent-1', 'agent-2'] });
      launcher.ensureActiveSession.mockResolvedValue({
        sessionId: 'session-1',
        agentId: 'agent-1',
        projectId: 'p1',
        status: 'running',
        tmuxSessionId: 'tmux-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: null,
      });
      messageEnqueue.enqueue
        .mockResolvedValueOnce([{ agentId: 'agent-1', status: 'delivered' }])
        .mockResolvedValueOnce([{ agentId: 'agent-2', status: 'failed', error: 'No session' }]);

      const outcome = await service.deliver(
        ['agent-1', 'agent-2'],
        { kind: 'mcp.direct', body: 'x', source: 'test', projectId: 'p1', senderName: 'A' },
        {},
      );

      expect(outcome.status).toBe('partial');
      expect(outcome.results[0].status).toBe('delivered');
      expect(outcome.results[1].status).toBe('failed');
    });

    it('passes immediate policy to pool', async () => {
      const { service, messageEnqueue } = buildService();

      await service.deliver(
        ['agent-1'],
        { kind: 'mcp.direct', body: 'urgent', source: 'test', projectId: 'p1', senderName: 'A' },
        { immediate: true },
      );

      expect(messageEnqueue.enqueue).toHaveBeenCalledWith([
        expect.objectContaining({ immediate: true }),
      ]);
    });

    it('invokes formatter.format() for mcp.direct kind', async () => {
      const { service, formatter, messageEnqueue } = buildService();

      await service.deliver(
        ['agent-1'],
        {
          kind: 'mcp.direct',
          body: 'hi',
          source: 'test',
          projectId: 'p1',
          senderName: 'Alpha',
          senderType: 'agent',
        },
        {},
      );

      expect(formatter.format).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'mcp.direct', body: 'hi', senderName: 'Alpha' }),
      );
      expect(messageEnqueue.enqueue).toHaveBeenCalledWith([
        expect.objectContaining({ agentId: 'agent-1', text: '[formatted:mcp.direct] hi' }),
      ]);
    });

    it('invokes formatter.format() for mcp.thread kind', async () => {
      const { service, formatter, messageEnqueue } = buildService();

      await service.deliver(
        ['agent-1'],
        {
          kind: 'mcp.thread',
          body: 'msg',
          source: 'test',
          projectId: 'p1',
          senderName: 'Alpha',
          threadId: 't1',
          messageId: 'm1',
        },
        { immediate: true },
      );

      expect(formatter.format).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'mcp.thread', threadId: 't1', messageId: 'm1' }),
      );
      expect(messageEnqueue.enqueue).toHaveBeenCalledWith([
        expect.objectContaining({ agentId: 'agent-1', text: '[formatted:mcp.thread] msg' }),
      ]);
    });

    it('invokes formatter.format() for chat.user kind', async () => {
      const { service, formatter, messageEnqueue } = buildService();

      await service.deliver(
        ['agent-1'],
        {
          kind: 'chat.user',
          body: 'hello',
          source: 'chat.message',
          projectId: 'p1',
          senderName: 'User',
          senderType: 'user',
          threadId: 't1',
          messageId: 'm1',
        },
        {},
      );

      expect(formatter.format).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'chat.user', senderType: 'user', senderName: 'User' }),
      );
      expect(messageEnqueue.enqueue).toHaveBeenCalledWith([
        expect.objectContaining({ agentId: 'agent-1', text: '[formatted:chat.user] hello' }),
      ]);
    });

    it('delivers guest messages through GuestDeliveryService', async () => {
      const { service, guestDelivery } = buildService();

      const result = await service.deliverToGuest('guest-tmux', 'hello', ['Escape']);

      expect(result).toEqual({ delivered: true });
      expect(guestDelivery.deliverToGuest).toHaveBeenCalledWith({ name: 'guest-tmux' }, 'hello', {
        submitKeys: ['Escape'],
      });
    });
  });
});
