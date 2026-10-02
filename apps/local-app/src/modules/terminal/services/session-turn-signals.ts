/**
 * In-process turn signals that drive busy/idle in {@link TerminalActivityService}. They are not
 * catalog events: nothing outside the activity state machine consumes them, and its result is
 * published as `session.activity.changed`.
 */

/** A provider hook marked a turn boundary (`UserPromptSubmit` opens, `Stop` ends). */
export const SESSION_TURN_HOOK_SIGNAL = 'session.turn.hook';

export interface SessionTurnHookSignal {
  sessionId: string;
  providerName: string;
  kind: 'prompt-submitted' | 'stopped';
  /** When the provider fired the hook (relay clock), else when DevChain received it. */
  firedAtMs: number;
}

/** The transcript watcher finished a pass over a session's transcript. */
export const SESSION_TRANSCRIPT_TURN_SIGNAL = 'session.turn.transcript';

/** Whether a transcript's latest turn is open, and when the evidence was written. */
export interface TranscriptTurnState {
  open: boolean;
  /** Epoch ms of the evidence entry; null when the provider's evidence carries no time. */
  atMs: number | null;
}

export interface SessionTranscriptTurnSignal {
  sessionId: string;
  providerName: string;
  /** The transcript's turn state; null when the transcript holds no turn evidence. */
  turn: TranscriptTurnState | null;
  /** The pass read new transcript content. */
  grew: boolean;
}
