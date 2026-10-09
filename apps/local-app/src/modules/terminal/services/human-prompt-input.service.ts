import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { emitHumanPromptStateChangedBarrier } from '../../events/catalog/session.human-prompt-state-changed';
import {
  HumanPromptStateService,
  type AwaitingStableIdleHumanPromptState,
  type DraftActiveHumanPromptState,
  type PromptAwaitingTransitionResult,
  type PromptControlInputResult,
} from './human-prompt-state.service';

export type PromptInput =
  | { kind: 'text'; characterCount?: number }
  | { kind: 'paste' }
  | { kind: 'submit-text' }
  | {
      kind: 'control';
      tmuxKey: string;
      expectedGeneration: number | null;
      providerName?: string | null;
    };

interface PromptInputSession {
  readonly sessionId: string;
  readonly tmuxSessionName: string;
  signalInput(): void;
}

@Injectable()
export class HumanPromptInputService {
  constructor(
    private readonly humanPromptState: HumanPromptStateService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Observe before any liveness await so a delayed key cannot clear a newer draft.
  observe(tmuxSessionName: string): number | null {
    const state = this.humanPromptState.getState(tmuxSessionName);
    return state.phase === 'draft_active' ? state.generation : null;
  }

  async run<T>(
    session: PromptInputSession,
    input: PromptInput,
    write: () => Promise<T>,
  ): Promise<T> {
    const { tmuxSessionName } = session;
    if (input.kind === 'control') {
      session.signalInput();
      const value = await write();
      if (input.expectedGeneration !== null) {
        await this.publishIfAccepted(
          session,
          input.tmuxKey === 'Enter'
            ? this.humanPromptState.transitionToAwaiting(tmuxSessionName, input.expectedGeneration)
            : this.humanPromptState.recordControlInput(
                tmuxSessionName,
                input.expectedGeneration,
                input.tmuxKey,
                input.providerName,
              ),
        );
      }
      return value;
    }

    const state = this.humanPromptState.recordPromptText(
      tmuxSessionName,
      input.kind === 'text' ? input.characterCount : undefined,
      true,
    );
    await this.publish(session, state);
    session.signalInput();
    const value = await write();
    this.humanPromptState.confirmPromptTextWritten(tmuxSessionName, state.generation);
    if (input.kind === 'submit-text') {
      await this.publishIfAccepted(
        session,
        this.humanPromptState.transitionToAwaiting(tmuxSessionName, state.generation),
      );
    }
    return value;
  }

  private async publishIfAccepted(
    session: PromptInputSession,
    result: PromptAwaitingTransitionResult | PromptControlInputResult,
  ): Promise<void> {
    if (result.accepted) await this.publish(session, result.state);
  }

  private publish(
    session: PromptInputSession,
    state: DraftActiveHumanPromptState | AwaitingStableIdleHumanPromptState,
  ): Promise<void> {
    return emitHumanPromptStateChangedBarrier(this.eventEmitter, {
      sessionId: session.sessionId,
      tmuxSessionName: session.tmuxSessionName,
      generation: state.generation,
      phase: state.phase,
    });
  }
}
