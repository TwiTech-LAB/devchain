import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { SessionsDeliveryModule } from '../sessions-delivery.module';
import { SessionsModule } from '../sessions.module';
import { SessionsReadModule } from '../sessions-read.module';
import { TerminalDeliveryModule } from '../../terminal/terminal-delivery.module';
import { MessageEnqueueService } from './message-enqueue.service';
import { SessionLauncherFacade } from './session-launcher-facade.service';
import { SessionsMessagePoolService } from './sessions-message-pool.service';

describe('MessageEnqueueService', () => {
  let moduleRef: TestingModule;
  let pool: jest.Mocked<Pick<SessionsMessagePoolService, 'enqueue' | 'flushNow' | 'getPoolStats'>>;
  let service: MessageEnqueueService;

  beforeEach(async () => {
    pool = {
      enqueue: jest.fn(),
      flushNow: jest.fn(),
      getPoolStats: jest.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        MessageEnqueueService,
        {
          provide: SessionsMessagePoolService,
          useValue: pool,
        },
      ],
    }).compile();

    service = moduleRef.get(MessageEnqueueService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('delegates enqueue calls and returns one result per message', async () => {
    pool.enqueue
      .mockResolvedValueOnce({ status: 'queued', poolSize: 1 })
      .mockResolvedValueOnce({ status: 'delivered' });

    const submitKeys = ['Enter', 'C-m'] as const;

    await expect(
      service.enqueue([
        {
          agentId: 'agent-1',
          text: 'hello',
          source: 'test',
          submitKeys,
          senderAgentId: 'sender-1',
          immediate: false,
          projectId: 'project-1',
          agentName: 'Agent One',
        },
        {
          agentId: 'agent-2',
          text: 'world',
          source: 'test',
          immediate: true,
        },
      ]),
    ).resolves.toEqual([
      { agentId: 'agent-1', status: 'queued', poolSize: 1 },
      { agentId: 'agent-2', status: 'delivered' },
    ]);

    expect(pool.enqueue).toHaveBeenNthCalledWith(1, 'agent-1', 'hello', {
      source: 'test',
      submitKeys: ['Enter', 'C-m'],
      senderAgentId: 'sender-1',
      immediate: false,
      projectId: 'project-1',
      agentName: 'Agent One',
    });
    expect(pool.enqueue).toHaveBeenNthCalledWith(2, 'agent-2', 'world', {
      source: 'test',
      submitKeys: undefined,
      senderAgentId: undefined,
      immediate: true,
      projectId: undefined,
      agentName: undefined,
    });
    expect(pool.enqueue.mock.calls[0][2]?.submitKeys).not.toBe(submitKeys);
  });

  it('does not swallow enqueue rejections', async () => {
    pool.enqueue.mockRejectedValue(new Error('pool failed'));

    await expect(
      service.enqueue([{ agentId: 'agent-1', text: 'hello', source: 'test' }]),
    ).rejects.toThrow('pool failed');
  });

  it('delegates flush and hides the pool result', async () => {
    pool.flushNow.mockResolvedValue({ success: true, deliveredCount: 1 });

    await expect(service.flush('agent-1')).resolves.toBeUndefined();

    expect(pool.flushNow).toHaveBeenCalledWith('agent-1');
  });

  it('adapts pool stats to read-only facade status', () => {
    pool.getPoolStats.mockReturnValue([
      { agentId: 'agent-1', messageCount: 2, waitingMs: 50 },
      { agentId: 'agent-2', messageCount: 1, waitingMs: 10 },
    ]);

    expect(service.getPoolStatus()).toEqual({
      agentCount: 2,
      totalMessages: 3,
      pools: [
        { agentId: 'agent-1', messageCount: 2, waitingMs: 50 },
        { agentId: 'agent-2', messageCount: 1, waitingMs: 10 },
      ],
    });
  });
});

describe('SessionsDeliveryModule', () => {
  it('imports SessionsModule and exports narrow delivery facades', () => {
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SessionsDeliveryModule) as unknown[]) ?? [];
    const providers =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SessionsDeliveryModule) as unknown[]) ?? [];
    const exports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SessionsDeliveryModule) as unknown[]) ?? [];

    expect(imports[0]).toBe(SessionsReadModule);
    expect(imports[1]).toBe(SessionsModule);
    expect(imports[2]).toBe(TerminalDeliveryModule);
    expect(providers).toEqual([MessageEnqueueService, SessionLauncherFacade]);
    expect(exports).toEqual([MessageEnqueueService, SessionLauncherFacade]);
    expect(exports).not.toEqual(expect.arrayContaining([SessionsMessagePoolService]));
  });
});
