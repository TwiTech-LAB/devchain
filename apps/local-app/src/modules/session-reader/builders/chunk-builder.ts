/**
 * Chunk Builder
 *
 * Classifies UnifiedMessage[] into logical chunks (user/ai/system/compact)
 * for richer UI rendering. Hard noise messages are filtered out entirely.
 *
 * Algorithm: iterate messages, buffer consecutive AI messages, flush the
 * buffer when a non-AI message is encountered. Each non-AI message creates
 * its own chunk.
 *
 * Metrics: computes per-chunk token sums only. Session-level metrics are
 * forwarded as-is from the adapter (no recomputation).
 */

import type { UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk, ChunkMetrics, MessageCategory } from '../dtos/unified-chunk.types';
import { extractSemanticSteps } from './semantic-step-extractor';
import { buildTurns } from './turn-builder';

// ---------------------------------------------------------------------------
// Hard-noise detection tags
// ---------------------------------------------------------------------------

const HARD_NOISE_TAGS = ['<local-command-caveat>', '<system-reminder>'];

const SYSTEM_OUTPUT_TAG = '<local-command-stdout>';

// ---------------------------------------------------------------------------
// Message Classification
// ---------------------------------------------------------------------------

/**
 * Classify a single message into one of the 5 categories.
 * Checked in priority order: hardNoise → compact → system → user → ai.
 */
export function classifyMessage(msg: UnifiedMessage): MessageCategory {
  if (isHardNoise(msg)) return 'hardNoise';
  if (isCompactMessage(msg)) return 'compact';
  if (isSystemMessage(msg)) return 'system';
  if (msg.role === 'user' && msg.toolResults.length > 0) return 'ai';
  if (isUserChunkMessage(msg)) return 'user';
  return 'ai';
}

/** Hard noise: system-generated metadata that should always be filtered */
function isHardNoise(msg: UnifiedMessage): boolean {
  // System role + isMeta is always hard noise
  if (msg.role === 'system' && msg.isMeta) return true;

  // User messages containing only hard noise tags
  if (msg.role === 'user' && msg.isMeta) {
    const text = getTextContent(msg);
    if (HARD_NOISE_TAGS.some((tag) => text.includes(tag))) return true;
  }

  return false;
}

/** Compact summary boundary messages */
function isCompactMessage(msg: UnifiedMessage): boolean {
  return msg.isCompactSummary === true;
}

/** System messages: command output wrapped in <local-command-stdout> */
function isSystemMessage(msg: UnifiedMessage): boolean {
  if (msg.role !== 'user') return false;
  const text = getTextContent(msg);
  return text.includes(SYSTEM_OUTPUT_TAG);
}

/** Real user input that starts a new chunk (excludes meta/system/compact) */
function isUserChunkMessage(msg: UnifiedMessage): boolean {
  if (msg.role !== 'user') return false;
  if (msg.isMeta) return false;
  if (msg.isCompactSummary) return false;
  const text = getTextContent(msg);
  if (text.includes(SYSTEM_OUTPUT_TAG)) return false;
  return true;
}

/** Extract concatenated text content from a message */
function getTextContent(msg: UnifiedMessage): string {
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}

// ---------------------------------------------------------------------------
// Chunk Building
// ---------------------------------------------------------------------------

/**
 * Build semantic chunks from a flat message list.
 *
 * Filters to main-thread messages only (non-sidechain).
 * Hard noise is silently dropped. Consecutive AI messages are grouped
 * into a single AIChunk. User, system, and compact messages each create
 * their own chunk.
 */
export function buildChunks(messages: UnifiedMessage[]): UnifiedChunk[] {
  const mainMessages = messages.filter((m) => !m.isSidechain);

  const chunks: UnifiedChunk[] = [];
  let aiBuffer: UnifiedMessage[] = [];
  let chunkIndex = 0;

  const flushAiBuffer = () => {
    if (aiBuffer.length === 0) return;
    const steps = extractSemanticSteps(aiBuffer);
    const turns = buildTurns(steps, aiBuffer);
    chunks.push({
      id: `chunk-${chunkIndex++}`,
      type: 'ai',
      startTime: aiBuffer[0].timestamp,
      endTime: aiBuffer[aiBuffer.length - 1].timestamp,
      messages: aiBuffer,
      metrics: computeChunkMetrics(aiBuffer),
      semanticSteps: steps,
      turns,
    });
    aiBuffer = [];
  };

  for (const msg of mainMessages) {
    const category = classifyMessage(msg);

    if (category === 'hardNoise') continue;

    if (category === 'ai') {
      aiBuffer.push(msg);
      continue;
    }

    // Non-AI message: flush any buffered AI messages first
    flushAiBuffer();

    chunks.push({
      id: `chunk-${chunkIndex++}`,
      type: category,
      startTime: msg.timestamp,
      endTime: msg.timestamp,
      messages: [msg],
      metrics: computeChunkMetrics([msg]),
    } as UnifiedChunk);
  }

  // Flush remaining AI buffer
  flushAiBuffer();

  return chunks;
}

// ---------------------------------------------------------------------------
// Per-Chunk Metrics
// ---------------------------------------------------------------------------

/**
 * Compute token metrics for a chunk's messages.
 * Sums usage from each message that has token data.
 */
export function computeChunkMetrics(messages: UnifiedMessage[]): ChunkMetrics {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const msg of messages) {
    if (msg.usage) {
      inputTokens += msg.usage.input;
      outputTokens += msg.usage.output;
      cacheReadTokens += msg.usage.cacheRead;
      cacheCreationTokens += msg.usage.cacheCreation;
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  const durationMs =
    messages.length > 0
      ? messages[messages.length - 1].timestamp.getTime() - messages[0].timestamp.getTime()
      : 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    messageCount: messages.length,
    durationMs,
    costUsd: 0, // Cost calculation deferred to pricing service
  };
}
