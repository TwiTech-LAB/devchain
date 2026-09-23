/**
 * Shared incremental-merge primitives used by BOTH the parsed cache
 * ({@link SessionCacheService}) and the watcher's metrics-only lane
 * ({@link TranscriptWatcherService}). Keeping the fold decision and the metric
 * merge in one place is what guarantees a lane pass and a cached body-path
 * append produce identical metrics for the same bytes.
 *
 * The cache runs these over the full merged message array; the lane runs them
 * over a small transient slice plus an O(1) tail descriptor and running values,
 * so neither retains message bodies just to keep the two paths in agreement.
 */
import type { UnifiedMessage, UnifiedMetrics } from '../dtos/unified-session.types';
import type { TailDescriptor } from '../adapters/session-reader-adapter.interface';
import { estimateVisibleFromMessages } from '../adapters/utils/estimate-content-tokens';
import { isToolResultOnlyMessage } from '../adapters/utils/tool-result-fold';

export type { TailDescriptor };

/** Project a message onto the fields the boundary fold needs. */
export function describeTail(message: UnifiedMessage | undefined): TailDescriptor | undefined {
  if (!message) return undefined;
  return {
    role: message.role,
    isSidechain: message.isSidechain,
    stopReason: message.stopReason ?? null,
    isCompactSummary: message.isCompactSummary ?? false,
  };
}

export interface LeadingContinuationFold {
  /** Number of LEADING slice messages that fold onto the prior tail (zero net-new each). */
  foldCount: number;
  /**
   * True iff the run consumed the WHOLE slice (folds happened, nothing left over) — a tail
   * mutation that adds no new message, which the watcher surfaces as an in-place tail replace.
   */
  tailMutatedWithoutNewMessage: boolean;
  /** Descriptor of the merged tail AFTER applying this slice (drives the next fold). */
  newTail: TailDescriptor | undefined;
}

/**
 * Decide how many LEADING messages of an incremental slice continue the prior tail's turn.
 *
 * An incremental slice parsed from a byteOffset can begin with content whose assistant turn
 * started in a PRIOR slice (the parser's parse-local fold has no target across the boundary).
 * The run consumes a message when it is EITHER a tool-result-only entry OR a continuation
 * assistant, and STOPS at the first turn boundary: a real user prompt, an `isCompactSummary`
 * entry, a sidechain mismatch vs the tail, or (over-merge guard) a further assistant when the
 * tail already reads `stopReason === 'end_turn'`. This mirrors the per-provider parser
 * coalescing so the incremental path never inflates `messageCount`.
 *
 * Pure and body-free: it reads only the tail DESCRIPTOR and the slice messages, so the cache
 * (tail = last cached message) and the lane (tail = carried descriptor) share one decision.
 */
export function computeLeadingContinuationFold(
  tail: TailDescriptor | undefined,
  newMessages: readonly UnifiedMessage[],
): LeadingContinuationFold {
  if (!tail || tail.role !== 'assistant' || newMessages.length === 0) {
    return {
      foldCount: 0,
      tailMutatedWithoutNewMessage: false,
      newTail: newMessages.length > 0 ? describeTail(newMessages[newMessages.length - 1]) : tail,
    };
  }

  let foldCount = 0;
  let tailStopReason = tail.stopReason;
  while (foldCount < newMessages.length) {
    const m = newMessages[foldCount];
    if (m.isSidechain !== tail.isSidechain) break; // sidechain transition → new context
    if (m.isCompactSummary) break; // compaction boundary
    const isToolResult = isToolResultOnlyMessage(m);
    const isContinuationAssistant = m.role === 'assistant';
    if (!isToolResult && !isContinuationAssistant) break; // real user prompt → new turn
    // A completed turn does not continue into a new assistant.
    if (isContinuationAssistant && tailStopReason === 'end_turn') break;
    if (isContinuationAssistant) tailStopReason = m.stopReason ?? null;
    foldCount += 1;
  }

  const remaining = newMessages.length - foldCount;
  const newTail: TailDescriptor =
    remaining > 0
      ? describeTail(newMessages[newMessages.length - 1])!
      : // Whole slice folded onto the cached tail: still that assistant, stop reason advanced.
        {
          role: 'assistant',
          isSidechain: tail.isSidechain,
          stopReason: tailStopReason,
          isCompactSummary: false,
        };

  return {
    foldCount,
    tailMutatedWithoutNewMessage: foldCount > 0 && remaining === 0,
    newTail,
  };
}

/**
 * The three merged-array-derived inputs {@link mergeMetrics} needs beyond the two metric
 * objects. The cache computes them from the full merged message array; the lane keeps them
 * as O(1) running values. See {@link deriveMergeInputsFromMessages} for the messages form.
 */
export interface MergeDerivedInputs {
  messageCount: number;
  /** Visible-context tokens in MERGE terms: content after the last compact summary, which is
   * itself excluded (see {@link estimateVisibleFromMessages}). */
  visibleContextTokens: number;
  durationMs: number;
}

/** Compute {@link MergeDerivedInputs} from the full merged message array (cache path). */
export function deriveMergeInputsFromMessages(
  existing: UnifiedMetrics,
  allMessages: UnifiedMessage[],
): MergeDerivedInputs {
  let durationMs = existing.durationMs;
  if (allMessages.length >= 2) {
    durationMs =
      allMessages[allMessages.length - 1].timestamp.getTime() - allMessages[0].timestamp.getTime();
  }
  return {
    messageCount: allMessages.length,
    visibleContextTokens: estimateVisibleFromMessages(allMessages),
    durationMs,
  };
}

/**
 * Merge existing session metrics with an incremental slice's metrics.
 *
 * Token totals and cost are additive. Latest-state fields (isOngoing, primaryModel,
 * totalContextTokens, contextWindowTokens) come from the slice, except that a slice with no
 * model keeps the known `primaryModel` and `contextWindowTokens` (a tool-result/synthetic
 * slice reports `''` plus the parser's default window; neither may replace a known value).
 * Compaction fields (`totalContextConsumption`, `compactionCount`, `phaseBreakdowns`) are kept
 * from the existing metrics — they cannot be computed incrementally and refresh on full reparse.
 * `messageCount`, `visibleContextTokens`, and `durationMs` come from {@link MergeDerivedInputs}.
 */
export function mergeMetrics(
  existing: UnifiedMetrics,
  incremental: UnifiedMetrics,
  derived: MergeDerivedInputs,
): UnifiedMetrics {
  const inputTokens = existing.inputTokens + incremental.inputTokens;
  const outputTokens = existing.outputTokens + incremental.outputTokens;
  const cacheReadTokens = existing.cacheReadTokens + incremental.cacheReadTokens;
  const cacheCreationTokens = existing.cacheCreationTokens + incremental.cacheCreationTokens;
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  const modelsSet = new Set<string>();
  if (existing.primaryModel) modelsSet.add(existing.primaryModel);
  if (incremental.primaryModel) modelsSet.add(incremental.primaryModel);
  if (existing.modelsUsed) existing.modelsUsed.forEach((m) => modelsSet.add(m));
  if (incremental.modelsUsed) incremental.modelsUsed.forEach((m) => modelsSet.add(m));
  const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

  const sliceHasModel = Boolean(incremental.primaryModel);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costUsd: existing.costUsd + incremental.costUsd,
    primaryModel: sliceHasModel ? incremental.primaryModel : existing.primaryModel,
    modelsUsed,
    isOngoing: incremental.isOngoing,
    visibleContextTokens: derived.visibleContextTokens,
    totalContextTokens:
      incremental.totalContextTokens > 0
        ? incremental.totalContextTokens
        : existing.totalContextTokens,
    contextWindowTokens:
      sliceHasModel || !existing.primaryModel
        ? (incremental.contextWindowTokens ?? existing.contextWindowTokens)
        : existing.contextWindowTokens,
    messageCount: derived.messageCount,
    durationMs: derived.durationMs,
    totalContextConsumption: existing.totalContextConsumption,
    compactionCount: existing.compactionCount,
    phaseBreakdowns: existing.phaseBreakdowns,
  };
}
