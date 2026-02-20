import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import {
  WORKTREE_CHANGED_EVENT,
  WorktreeChangedEvent,
} from '../../orchestrator/worktrees/events/worktree.events';

@Injectable()
export class WorktreeBroadcasterSubscriber {
  private readonly logger = new Logger(WorktreeBroadcasterSubscriber.name);

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
  ) {}

  @OnEvent(WORKTREE_CHANGED_EVENT, { async: true })
  async handleWorktreeChanged(payload: WorktreeChangedEvent): Promise<void> {
    try {
      this.terminalGateway.broadcastEvent('worktrees', 'changed', {});
      this.logger.debug(
        { worktreeId: payload.worktreeId },
        'Broadcasted worktree changed event via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, worktreeId: payload.worktreeId },
        'Failed to broadcast worktree changed event',
      );
    }
  }
}
