import { Test, TestingModule } from '@nestjs/testing';
import { WorktreeBroadcasterSubscriber } from './worktree-broadcaster.subscriber';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { WorktreeChangedEvent } from '../../orchestrator/worktrees/events/worktree.events';

describe('WorktreeBroadcasterSubscriber', () => {
  let subscriber: WorktreeBroadcasterSubscriber;
  let mockTerminalGateway: { broadcastEvent: jest.Mock };

  beforeEach(async () => {
    mockTerminalGateway = {
      broadcastEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorktreeBroadcasterSubscriber,
        {
          provide: TerminalGateway,
          useValue: mockTerminalGateway,
        },
      ],
    }).compile();

    subscriber = module.get<WorktreeBroadcasterSubscriber>(WorktreeBroadcasterSubscriber);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('broadcasts worktrees changed event via TerminalGateway', async () => {
    const payload: WorktreeChangedEvent = { worktreeId: 'wt-123' };

    await subscriber.handleWorktreeChanged(payload);

    expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith('worktrees', 'changed', {});
    expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(1);
  });

  it('handles errors gracefully', async () => {
    mockTerminalGateway.broadcastEvent.mockImplementation(() => {
      throw new Error('Broadcast failed');
    });

    const payload: WorktreeChangedEvent = { worktreeId: 'wt-123' };

    await expect(subscriber.handleWorktreeChanged(payload)).resolves.not.toThrow();
  });
});
