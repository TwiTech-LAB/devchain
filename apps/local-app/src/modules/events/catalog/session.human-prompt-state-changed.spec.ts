import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  emitHumanPromptStateChangedBarrier,
  sessionHumanPromptStateChangedEvent,
} from './session.human-prompt-state-changed';

describe('session.human-prompt-state-changed', () => {
  it.each(['draft_active', 'awaiting_stable_idle'] as const)(
    'accepts the typed %s payload',
    (phase) => {
      expect(
        sessionHumanPromptStateChangedEvent.schema.parse({
          sessionId: 'session-1',
          tmuxSessionName: 'tmux-session-1',
          generation: 2,
          phase,
        }),
      ).toEqual({
        sessionId: 'session-1',
        tmuxSessionName: 'tmux-session-1',
        generation: 2,
        phase,
      });
    },
  );

  it('awaits asynchronous listeners as a correctness barrier', async () => {
    const eventEmitter = new EventEmitter2();
    let release!: () => void;
    const listener = new Promise<void>((resolve) => {
      release = resolve;
    });
    eventEmitter.on(sessionHumanPromptStateChangedEvent.name, () => listener);

    let settled = false;
    const barrier = emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: 'tmux-session-1',
      generation: 1,
      phase: 'draft_active',
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await barrier;
    expect(settled).toBe(true);
  });
});
