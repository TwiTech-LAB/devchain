import type { TokenUsage, UnifiedMessage, UnifiedMetrics } from '../../dtos/unified-session.types';

/**
 * Unified assistant-turn coalescer — the SINGLE SOURCE OF TRUTH for collapsing consecutive
 * same-context assistant messages into one conversational turn, applied centrally at the
 * cache choke-point (`SessionCacheService.getOrParse`) so EVERY provider gets identical
 * behavior. A tool-using exchange = 2 messages (1 user + 1 assistant) on every provider, no
 * matter how many tool steps/rounds happened inside; RENDERING is unchanged (all steps still
 * display — only the COUNT collapses).
 *
 * CONTINUATION CONTRACT (fail-safe): a consecutive assistant merges onto the preceding
 * assistant ONLY when the preceding turn carries an EXPLICIT continuation signal —
 * `stopReason === 'tool_use'`. `undefined` / `'end_turn'` / any unknown value is a turn
 * BOUNDARY. This is deliberately fail-safe: a future provider that does not declare a
 * continuation signal can never over-merge; it must opt in by setting `stopReason === 'tool_use'`
 * on its continuation steps. Additional boundaries: a real (non-merged) USER message, an
 * `isCompactSummary` entry, and an `isSidechain` mismatch.
 *
 * Codex caveat: the Codex parser NEVER sets `stopReason`, so the full-array pass relies on
 * BOTH (a) the `undefined → boundary` fail-safe AND (b) the Codex parser already coalescing a
 * turn into one message (so it never emits consecutive assistants). This asymmetry vs Claude —
 * which DOES set `stopReason` (`'end_turn'` vs `'tool_use'`) — is intentional: the pass is a
 * safety net for providers (e.g. OpenCode) that emit one message per tool STEP without
 * parser-level coalescing.
 *
 * The function is PURE: it never mutates the input session or any input message object (turns
 * that are merged are folded into a fresh clone). Idempotency — `coalesce(coalesce(x))` deep-
 * equals `coalesce(x)` — is the safety contract for the whole feature: a once-coalesced turn
 * carries the LAST step's `stopReason`, so a second pass finds nothing further to merge.
 */

/** The one explicit continuation signal that keeps an assistant turn OPEN for a merge. */
const CONTINUATION_STOP_REASON = 'tool_use';

export interface CoalesceTurnsResult {
  messages: UnifiedMessage[];
  /** Metrics with `messageCount` recomputed to `messages.length` (the invariant co-located
   *  with the op). All other fields pass through unchanged — coalescing preserves every
   *  content block and timestamp, so token/duration/visible metrics are invariant under it. */
  metrics: UnifiedMetrics;
}

/**
 * Additive token-usage merge (undefined-safe). The ONE usage-merge primitive shared by this
 * coalescer and the cache-boundary fold (`session-cache.service.ts`), so the live/incremental
 * path and the full-array pass never drift.
 */
export function sumTokenUsage(
  target: TokenUsage | undefined,
  addition: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!addition) return target;
  if (!target) return { ...addition };
  return {
    input: target.input + addition.input,
    output: target.output + addition.output,
    cacheRead: target.cacheRead + addition.cacheRead,
    cacheCreation: target.cacheCreation + addition.cacheCreation,
  };
}

/**
 * THE merge primitive: fold `source`'s parts onto an assistant `target` turn. MUTATES
 * `target`, which the caller MUST own (a clone — never a cached or input message object).
 * Concatenates `content` + `toolCalls` + `toolResults`; when `source` is an assistant
 * continuation it also SUMS usage (so per-chunk token metrics don't undercount the merged
 * turn), advances the persisted completion signal (`stopReason`) to the latest response, and
 * adopts the model if the target lacked one. Shared by `coalesceAssistantTurns` (full-array
 * pass) and `foldLeadingContinuationIntoCachedTail` (delta path) so both fold identically.
 */
export function foldTurnParts(target: UnifiedMessage, source: UnifiedMessage): void {
  target.content.push(...source.content);
  target.toolCalls.push(...source.toolCalls);
  target.toolResults.push(...source.toolResults);
  if (source.role === 'assistant') {
    target.usage = sumTokenUsage(target.usage, source.usage);
    target.stopReason = source.stopReason ?? null;
    target.lastEntryAtMs = source.lastEntryAtMs ?? source.timestamp.getTime();
    if (source.model && !target.model) target.model = source.model;
  }
}

/** Shallow clone with the part-arrays copied — safe to fold INTO without mutating the
 *  original (the purity contract). */
function cloneForMerge(msg: UnifiedMessage): UnifiedMessage {
  return {
    ...msg,
    content: [...msg.content],
    toolCalls: [...msg.toolCalls],
    toolResults: [...msg.toolResults],
  };
}

/**
 * Coalesce consecutive same-context assistant turns across the FULL message array. See the
 * file header for the continuation contract + idempotency guarantee. Returns the coalesced
 * messages and metrics with `messageCount` recomputed.
 */
export function coalesceAssistantTurns(session: {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
}): CoalesceTurnsResult {
  const out: UnifiedMessage[] = [];
  // The OPEN assistant turn a following continuation may fold onto: the last appended
  // assistant whose explicit signal is `stopReason === 'tool_use'`. Null after any boundary
  // (real user, compaction summary, sidechain change, or a completed/unknown-signal turn).
  let openTurn: UnifiedMessage | null = null;
  // True once `openTurn` is OUR clone — so we fold into the clone, never the input object.
  let openTurnOwned = false;
  // True once at least one merge happened — lets us return the ORIGINAL array reference on a
  // true no-op (so the caller can cheaply detect "nothing changed" and skip rewrapping).
  let merged = false;

  for (const msg of session.messages) {
    const mergeable =
      openTurn !== null &&
      msg.role === 'assistant' &&
      !msg.isCompactSummary &&
      msg.isSidechain === openTurn.isSidechain;

    if (mergeable) {
      // Lazily clone the open turn the first time we fold onto it (purity): an unmerged run
      // leaves the input objects untouched, so Claude/Codex output is reference-identical.
      if (!openTurnOwned) {
        const clone = cloneForMerge(openTurn as UnifiedMessage);
        out[out.length - 1] = clone;
        openTurn = clone;
        openTurnOwned = true;
      }
      foldTurnParts(openTurn as UnifiedMessage, msg);
      merged = true;
      // The merged turn adopts the continuation's signal: it stays OPEN only if that step is
      // itself a `tool_use` continuation; otherwise the turn is now closed.
      if ((openTurn as UnifiedMessage).stopReason !== CONTINUATION_STOP_REASON) {
        openTurn = null;
        openTurnOwned = false;
      }
      continue;
    }

    // Boundary or new turn: append as-is, and (re)open a turn iff this is an OPEN assistant.
    out.push(msg);
    if (
      msg.role === 'assistant' &&
      !msg.isCompactSummary &&
      msg.stopReason === CONTINUATION_STOP_REASON
    ) {
      openTurn = msg;
      openTurnOwned = false;
    } else {
      openTurn = null;
      openTurnOwned = false;
    }
  }

  // On a true no-op return the ORIGINAL array reference (not a fresh copy) so a caller can
  // detect "nothing coalesced" by identity and avoid rebuilding the session.
  const messages = merged ? out : session.messages;
  return {
    messages,
    // Recompute messageCount = messages.length (co-located invariant). totalContextTokens is
    // preserved as the last-step snapshot (NOT summed); duration/visible/token metrics are
    // invariant under coalescing (same blocks + timestamps), so they pass through unchanged.
    metrics: { ...session.metrics, messageCount: messages.length },
  };
}
