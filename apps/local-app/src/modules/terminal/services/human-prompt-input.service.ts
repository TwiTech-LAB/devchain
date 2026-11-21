import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { waitWithSignal } from '../../../common/wait-with-signal';
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
  | { kind: 'image-paste'; signal?: AbortSignal }
  | { kind: 'form-send'; submitted: () => boolean; signal?: AbortSignal }
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
  readonly disposedSignal?: AbortSignal;
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

    const imageInput = input.kind === 'image-paste' || input.kind === 'form-send';
    const signal = imageInput ? input.signal : undefined;
    signal?.throwIfAborted();
    const imageStartsDraft =
      imageInput && this.humanPromptState.getState(tmuxSessionName).phase !== 'draft_active';
    const state = this.humanPromptState.recordPromptText(
      tmuxSessionName,
      input.kind === 'text' ? input.characterCount : undefined,
      true,
    );
    let value: T;
    try {
      const activation = this.publish(session, state, signal);
      await (signal ? waitWithSignal(activation, signal) : activation);
      signal?.throwIfAborted();
      session.signalInput();
      value = await write();
    } catch (error) {
      // Image delivery returns an explicit uncertain outcome once a write is possible.
      // A rejection here can therefore release just this unexecuted reservation.
      if (imageInput && !session.disposedSignal?.aborted) {
        this.humanPromptState.confirmPromptTextWritten(tmuxSessionName, state.generation);
        if (imageStartsDraft)
          await this.publishIfAccepted(
            session,
            this.humanPromptState.transitionToAwaiting(
              tmuxSessionName,
              state.generation,
              false,
              'unwritten',
            ),
            signal,
          );
      }
      throw error;
    }
    this.humanPromptState.confirmPromptTextWritten(tmuxSessionName, state.generation);
    if (input.kind === 'submit-text' || (input.kind === 'form-send' && input.submitted())) {
      await this.publishIfAccepted(
        session,
        this.humanPromptState.transitionToAwaiting(tmuxSessionName, state.generation),
        signal,
      );
    }
    return value;
  }

  private async publishIfAccepted(
    session: PromptInputSession,
    result: PromptAwaitingTransitionResult | PromptControlInputResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!result.accepted) return;
    const published = this.publish(session, result.state);
    if (!signal) return published;
    // The state transition must reach listeners even if the client stops waiting for its receipt.
    try {
      await waitWithSignal(published, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  private publish(
    session: PromptInputSession,
    state: DraftActiveHumanPromptState | AwaitingStableIdleHumanPromptState,
    signal?: AbortSignal,
  ): Promise<void> {
    return emitHumanPromptStateChangedBarrier(
      this.eventEmitter,
      {
        sessionId: session.sessionId,
        tmuxSessionName: session.tmuxSessionName,
        generation: state.generation,
        phase: state.phase,
      },
      signal,
    );
  }
}
