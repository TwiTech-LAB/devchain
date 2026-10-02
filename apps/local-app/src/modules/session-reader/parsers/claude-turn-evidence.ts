/**
 * Claude turn state from ordered main-thread transcript evidence: whether the latest turn is
 * still open (busy) or ended (idle), and when that evidence was written. Busy/idle activity and
 * `metrics.isOngoing` both read it.
 */
import type { UnifiedMessage } from '../dtos/unified-session.types';

export interface ClaudeTurnEvidence {
  open: boolean;
  /** Epoch ms of the transcript entry that set the state. */
  atMs: number;
}

/** The Claude adapter's continuation state between incremental parses. */
export interface ClaudeContinuationState {
  turn: ClaudeTurnEvidence | null;
}

const INTERRUPTION = /\[Request interrupted by user(?: for tool use)?\]/;
/** A built-in slash command (`/model`, `/compact`, ...) finished without an assistant turn. */
const LOCAL_COMMAND_RESULT = /<local-command-(?:stdout|stderr)>/;
/** Slash-command echo and caveat entries that open nothing by themselves. */
const COMMAND_METADATA = /^\s*<(?:command-name|command-message|command-args|local-command-caveat)>/;

/**
 * The turn evidence of one transcript entry, before any fold: `true` opens a turn, `false` ends
 * it, `null` says nothing (sidechain, metadata, tool-result plumbing).
 */
export function classifyClaudeTurnEntry(message: UnifiedMessage): boolean | null {
  if (message.isSidechain) return null;
  if (message.role === 'assistant') {
    return message.stopReason === null || message.stopReason === undefined
      ? true
      : message.stopReason === 'tool_use';
  }
  if (message.role !== 'user' || message.isMeta || message.isCompactSummary) return null;

  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  if (INTERRUPTION.test(text) || LOCAL_COMMAND_RESULT.test(text)) return false;
  if (COMMAND_METADATA.test(text)) return null;
  const opensTurn = message.content.some(
    (block) => (block.type === 'text' && block.text.trim().length > 0) || block.type === 'image',
  );
  return opensTurn ? true : null;
}

/**
 * The latest turn evidence in a parsed message list, scanning back from the end. A folded
 * assistant message carries the stop reason of its last entry, so it is dated by that entry
 * too: the same time an incremental parse stamps on it.
 */
export function claudeTurnFromMessages(messages: UnifiedMessage[]): ClaudeTurnEvidence | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const open = classifyClaudeTurnEntry(message);
    if (open !== null) {
      return { open, atMs: message.lastEntryAtMs ?? message.timestamp.getTime() };
    }
  }
  return null;
}

export function readClaudeContinuation(state: unknown): ClaudeContinuationState | undefined {
  if (typeof state !== 'object' || state === null || !('turn' in state)) return undefined;
  const turn = (state as { turn: unknown }).turn;
  if (turn === null) return { turn: null };
  if (
    typeof turn === 'object' &&
    typeof (turn as ClaudeTurnEvidence).open === 'boolean' &&
    typeof (turn as ClaudeTurnEvidence).atMs === 'number'
  ) {
    return { turn: turn as ClaudeTurnEvidence };
  }
  return undefined;
}
