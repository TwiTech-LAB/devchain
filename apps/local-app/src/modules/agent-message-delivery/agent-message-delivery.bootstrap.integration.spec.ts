/**
 * Bootstrap integration test - AMD module DI validation.
 *
 * Layer: backend-integration
 * Justification: Verifies AgentMessageDeliveryModule wires the Track 7B
 * facades directly instead of legacy ModuleRef adapters.
 */

import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentMessageDeliveryService } from './agent-message-delivery.service';
import { AgentMessageDeliveryModule } from './agent-message-delivery.module';
import { ChatMessageDeliverySubscriber } from './subscribers/chat-message-delivery.subscriber';
import { MessageEnqueueService } from '../sessions/services/message-enqueue.service';
import { SessionLauncherFacade } from '../sessions/services/session-launcher-facade.service';
import { GuestDeliveryService } from '../terminal/services/guest-delivery.service';
import { EventsCoreModule } from '../events/events-core.module';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsReadModule } from '../sessions/sessions-read.module';
import { SessionsDeliveryModule } from '../sessions/sessions-delivery.module';
import { TerminalDeliveryModule } from '../terminal/terminal-delivery.module';

describe('AgentMessageDeliveryModule bootstrap', () => {
  let moduleRef: TestingModule;
  let sessionLauncher: jest.Mocked<Pick<SessionLauncherFacade, 'ensureActiveSession'>>;
  let messageEnqueue: jest.Mocked<Pick<MessageEnqueueService, 'enqueue'>>;
  let guestDelivery: jest.Mocked<Pick<GuestDeliveryService, 'deliverToGuest'>>;

  beforeEach(async () => {
    sessionLauncher = {
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
    messageEnqueue = {
      enqueue: jest.fn().mockResolvedValue([{ agentId: 'agent-1', status: 'queued' }]),
    };
    guestDelivery = {
      deliverToGuest: jest.fn().mockResolvedValue({ delivered: true }),
    };

    moduleRef = await Test.createTestingModule({
      imports: [AgentMessageDeliveryModule],
    })
      .overrideProvider(SessionLauncherFacade)
      .useValue(sessionLauncher)
      .overrideProvider(MessageEnqueueService)
      .useValue(messageEnqueue)
      .overrideProvider(GuestDeliveryService)
      .useValue(guestDelivery)
      .compile();
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('compiles AMD module and resolves its public providers', () => {
    expect(moduleRef.get(AgentMessageDeliveryService)).toBeInstanceOf(AgentMessageDeliveryService);
    expect(moduleRef.get(ChatMessageDeliverySubscriber)).toBeInstanceOf(
      ChatMessageDeliverySubscriber,
    );
  });

  it('imports only the final narrow module set', () => {
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AgentMessageDeliveryModule) as unknown[]) ?? [];

    expect(imports).toEqual([
      EventsCoreModule,
      StorageModule,
      SettingsModule,
      SessionsReadModule,
      SessionsDeliveryModule,
      TerminalDeliveryModule,
    ]);
  });

  it('delivers via facade providers without legacy adapter ports', async () => {
    const service = moduleRef.get(AgentMessageDeliveryService);

    await expect(
      service.deliver(
        ['agent-1'],
        {
          kind: 'mcp.direct',
          body: 'hello',
          source: 'test',
          projectId: 'project-1',
          senderName: 'Tester',
        },
        { immediate: true },
      ),
    ).resolves.toMatchObject({
      status: 'queued',
      results: [{ agentId: 'agent-1', status: 'queued' }],
    });

    expect(sessionLauncher.ensureActiveSession).toHaveBeenCalledWith('agent-1', 'project-1');
    expect(messageEnqueue.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        agentId: 'agent-1',
        text: expect.stringContaining('hello'),
        immediate: true,
      }),
    ]);
  });

  it('delivers guest messages through GuestDeliveryService facade', async () => {
    const service = moduleRef.get(AgentMessageDeliveryService);

    await expect(service.deliverToGuest('tmux-guest', 'hello', ['Enter'])).resolves.toEqual({
      delivered: true,
    });

    expect(guestDelivery.deliverToGuest).toHaveBeenCalledWith({ name: 'tmux-guest' }, 'hello', {
      submitKeys: ['Enter'],
    });
  });
});
