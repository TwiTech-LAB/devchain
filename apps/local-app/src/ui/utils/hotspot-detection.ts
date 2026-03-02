import type { SerializedChunk, SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import type { DisplayItem } from './ai-group-enhancer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HotspotSeverity = 'none' | 'hot';

export interface HotspotConfig {
  /** IQR multiplier for upper fence (default: 1.5 — standard Tukey fence) */
  iqrMultiplier: number;
}

export interface ChunkHotspotEntry {
  totalTokens: number;
  /** Percentage of context window consumed, clamped [0, 100] */
  contextPct: number;
  severity: HotspotSeverity;
}

export interface ChunkHotspotResult {
  hotChunkIds: Set<string>;
  chunkStats: Map<string, ChunkHotspotEntry>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const DEFAULT_CONFIG: HotspotConfig = { iqrMultiplier: 1.5 };

const EMPTY_RESULT: ChunkHotspotResult = {
  hotChunkIds: new Set(),
  chunkStats: new Map(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the value at a given percentile (0–1) using linear interpolation. */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  const k = (n - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Compute IQR-based hotspot detection for AI chunks.
 *
 * - Filters to AI chunks only
 * - Requires >= 4 AI chunks for meaningful IQR
 * - Returns empty if distribution is uniform (IQR = 0)
 */
/**
 * Filter chunks for hotspot display: keep hot AI chunks, their nearest
 * preceding user chunk, and compact summary chunks. Hides everything else.
 */
export function filterChunksForHotspot(
  chunks: SerializedChunk[],
  hotChunkIds: Set<string>,
): SerializedChunk[] {
  if (hotChunkIds.size === 0) return chunks;

  const keepIndices = new Set<number>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.type === 'ai' && hotChunkIds.has(chunk.id)) {
      keepIndices.add(i);
      // Walk backwards to find the nearest preceding user chunk
      for (let j = i - 1; j >= 0; j--) {
        if (chunks[j].type === 'user') {
          keepIndices.add(j);
          break;
        }
      }
    }
    // Always keep compact summaries (structural boundaries)
    if (chunk.type === 'compact') {
      keepIndices.add(i);
    }
  }

  return chunks.filter((_, i) => keepIndices.has(i));
}

export function computeChunkHotspots(
  chunks: SerializedChunk[],
  contextWindowTokens: number | undefined,
  config: HotspotConfig = DEFAULT_CONFIG,
): ChunkHotspotResult {
  const aiChunks = chunks.filter((c) => c.type === 'ai');
  if (aiChunks.length < 4) return EMPTY_RESULT;

  const values = aiChunks.map((c) => c.metrics.totalTokens);
  const sorted = [...values].sort((a, b) => a - b);

  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;

  if (iqr === 0) return EMPTY_RESULT;

  const upperFence = q3 + config.iqrMultiplier * iqr;
  const ctxWindow = contextWindowTokens || DEFAULT_CONTEXT_WINDOW;

  const hotChunkIds = new Set<string>();
  const chunkStats = new Map<string, ChunkHotspotEntry>();

  for (const chunk of aiChunks) {
    const totalTokens = chunk.metrics.totalTokens;
    const contextPct = Math.max(0, Math.min((totalTokens / ctxWindow) * 100, 100));
    const severity: HotspotSeverity = totalTokens > upperFence ? 'hot' : 'none';

    if (severity === 'hot') hotChunkIds.add(chunk.id);
    chunkStats.set(chunk.id, { totalTokens, contextPct, severity });
  }

  return { hotChunkIds, chunkStats };
}

// ---------------------------------------------------------------------------
// Step-level hotspot detection
// ---------------------------------------------------------------------------

export interface StepHotspotEntry {
  isHot: boolean;
  /** Percentage of rendered chunk tokens consumed by this display item, 0–100 */
  percentOfChunk: number;
  estimatedTokens: number;
}

/**
 * Compute a global IQR-based threshold from all steps' `estimatedTokens`
 * across all AI chunks. Tool_call + tool_result pairs are combined via
 * toolCallId pairing.
 *
 * Returns `null` when fewer than 4 non-zero step values exist or IQR = 0.
 */
export function computeStepHotspotThreshold(
  chunks: SerializedChunk[],
  config: HotspotConfig = DEFAULT_CONFIG,
): number | null {
  const values: number[] = [];

  for (const chunk of chunks) {
    if (chunk.type !== 'ai') continue;
    const steps = chunk.semanticSteps;
    if (!steps || steps.length === 0) continue;

    // Build a map of tool_result estimatedTokens keyed by toolCallId
    const toolResultTokens = new Map<string, number>();
    for (const step of steps) {
      if (step.type === 'tool_result' && step.content.toolCallId) {
        toolResultTokens.set(
          step.content.toolCallId,
          (toolResultTokens.get(step.content.toolCallId) ?? 0) + (step.estimatedTokens ?? 0),
        );
      }
    }

    for (const step of steps) {
      // Skip tool_result — its tokens are attributed to the tool_call entry
      if (step.type === 'tool_result') continue;

      let tokens = step.estimatedTokens ?? 0;

      if (step.type === 'tool_call' && step.content.toolCallId) {
        tokens += toolResultTokens.get(step.content.toolCallId) ?? 0;
      }

      if (tokens > 0) values.push(tokens);
    }
  }

  if (values.length < 4) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;

  if (iqr === 0) return null;

  return q3 + config.iqrMultiplier * iqr;
}

/**
 * Classify display items within a single AIGroupCard against a precomputed
 * global threshold. Returns a Map keyed by step ID.
 */
export function classifyDisplayItemHotspots(
  displayItems: DisplayItem[],
  threshold: number,
): Map<string, StepHotspotEntry> {
  const result = new Map<string, StepHotspotEntry>();

  // Compute combined tokens per display item and total rendered tokens
  const itemTokens: { id: string; tokens: number }[] = [];
  let totalRendered = 0;

  for (const item of displayItems) {
    const stepTokens = getDisplayItemTokens(item);
    itemTokens.push({ id: item.step.id, tokens: stepTokens });
    totalRendered += stepTokens;
  }

  for (const { id, tokens } of itemTokens) {
    const percentOfChunk =
      totalRendered > 0 ? Math.max(0, Math.min((tokens / totalRendered) * 100, 100)) : 0;

    result.set(id, {
      isHot: tokens > threshold,
      percentOfChunk,
      estimatedTokens: tokens,
    });
  }

  return result;
}

/** Combined estimated tokens for a display item (tool_call + linked result). */
function getDisplayItemTokens(item: DisplayItem): number {
  const stepTokens = (item.step as SerializedSemanticStep).estimatedTokens ?? 0;
  const resultTokens = item.linkedResult
    ? ((item.linkedResult as SerializedSemanticStep).estimatedTokens ?? 0)
    : 0;
  return stepTokens + resultTokens;
}
