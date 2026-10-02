import type { TranscriptTurnState } from '../../terminal/services/session-turn-signals';
import type { UnifiedMetrics } from '../dtos/unified-session.types';
import { readClaudeContinuation } from '../parsers/claude-turn-evidence';

const TURN_PROVIDERS = new Set(['claude', 'codex']);

/** Providers whose transcript records turn boundaries (see {@link transcriptTurnState}). */
export function hasTranscriptTurns(providerName: string): boolean {
  return TURN_PROVIDERS.has(providerName.toLowerCase());
}

/**
 * The parsed turn state for providers whose transcript records turn boundaries, else null.
 * Claude reads its carried turn evidence; Codex reports a turn end through
 * `task_complete`, `turn_complete` or `turn_aborted`, which its parser folds into
 * `metrics.isOngoing`.
 */
export function transcriptTurnState(
  providerName: string,
  metrics: UnifiedMetrics,
  continuationState: unknown,
): TranscriptTurnState | null {
  switch (providerName.toLowerCase()) {
    case 'claude':
      return readClaudeContinuation(continuationState)?.turn ?? null;
    case 'codex':
      return { open: metrics.isOngoing, atMs: null };
    default:
      return null;
  }
}
