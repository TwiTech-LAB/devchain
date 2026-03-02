/**
 * Unified Chunk & Semantic Step Types
 *
 * Provider-agnostic types for grouping messages into logical chunks
 * and extracting semantic steps from AI responses. These enrich
 * the Phase 1 flat message list for richer UI rendering.
 *
 * Metrics ownership: chunk builder computes per-chunk metrics only.
 * Session-level metrics are forwarded as-is from the adapter.
 */

import type { UnifiedMessage } from './unified-session.types';

// ---------------------------------------------------------------------------
// Chunk Metrics (per-chunk token sums)
// ---------------------------------------------------------------------------

/** Aggregated token metrics for a single chunk's messages */
export interface ChunkMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  messageCount: number;
  durationMs: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Semantic Step Types
// ---------------------------------------------------------------------------

export type UnifiedSemanticStepType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'output'
  | 'subagent'
  | 'interruption';

export interface UnifiedSemanticStepContent {
  thinkingText?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolCallId?: string;
  toolResultContent?: string | unknown[];
  isTruncated?: boolean;
  fullLength?: number;
  isError?: boolean;
  outputText?: string;
  subagentId?: string;
  subagentDescription?: string;
  interruptionText?: string;
  sourceModel?: string;
}

export interface UnifiedSemanticStep {
  id: string;
  type: UnifiedSemanticStepType;
  startTime: Date;
  durationMs: number;
  content: UnifiedSemanticStepContent;
  /** Provider-reported per-message usage snapshot (shared by all steps from same message). */
  tokens?: { input: number; output: number; cached?: number };
  /** Per-step heuristic token estimate (~chars/4). Content-based, not API-reported. */
  estimatedTokens?: number;
  sourceMessageId?: string;
  context: 'main' | 'subagent';
}

/**
 * @deprecated Use AIGroupCard with semanticSteps instead. Will be removed in cleanup epic.
 */
export interface TurnSummary {
  thinkingCount: number;
  toolCallCount: number;
  subagentCount: number;
  outputCount: number;
}

/**
 * @deprecated Use AIGroupCard with semanticSteps instead. Will be removed in cleanup epic.
 */
export interface UnifiedTurn {
  id: string;
  assistantMessageId: string;
  model?: string;
  timestamp: Date;
  steps: UnifiedSemanticStep[];
  summary: TurnSummary;
  tokens?: { input: number; output: number; cached?: number };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Chunk Types (discriminated union)
// ---------------------------------------------------------------------------

export type UnifiedChunkType = 'user' | 'ai' | 'system' | 'compact';

interface BaseChunk {
  id: string;
  type: UnifiedChunkType;
  startTime: Date;
  endTime: Date;
  messages: UnifiedMessage[];
  metrics: ChunkMetrics;
}

export interface UserChunk extends BaseChunk {
  type: 'user';
}

export interface AIChunk extends BaseChunk {
  type: 'ai';
  semanticSteps: UnifiedSemanticStep[];
  turns: UnifiedTurn[];
}

export interface SystemChunk extends BaseChunk {
  type: 'system';
}

export interface CompactChunk extends BaseChunk {
  type: 'compact';
}

export type UnifiedChunk = UserChunk | AIChunk | SystemChunk | CompactChunk;

// ---------------------------------------------------------------------------
// Message Classification
// ---------------------------------------------------------------------------

export type MessageCategory = 'user' | 'ai' | 'system' | 'compact' | 'hardNoise';

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

export function isUserChunk(chunk: UnifiedChunk): chunk is UserChunk {
  return chunk.type === 'user';
}

export function isAIChunk(chunk: UnifiedChunk): chunk is AIChunk {
  return chunk.type === 'ai';
}

export function isSystemChunk(chunk: UnifiedChunk): chunk is SystemChunk {
  return chunk.type === 'system';
}

export function isCompactChunk(chunk: UnifiedChunk): chunk is CompactChunk {
  return chunk.type === 'compact';
}
