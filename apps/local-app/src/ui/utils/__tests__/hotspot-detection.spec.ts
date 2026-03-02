import type { SerializedChunk, SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import type { DisplayItem } from '../ai-group-enhancer';
import {
  classifyDisplayItemHotspots,
  computeChunkHotspots,
  computeStepHotspotThreshold,
  DEFAULT_CONTEXT_WINDOW,
  filterChunksForHotspot,
} from '../hotspot-detection';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeChunk(
  id: string,
  type: 'ai' | 'user' | 'system' | 'compact',
  totalTokens: number,
): SerializedChunk {
  return {
    id,
    type,
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:01.000Z',
    messages: [],
    metrics: {
      inputTokens: totalTokens * 0.6,
      outputTokens: totalTokens * 0.4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens,
      messageCount: 1,
      durationMs: 1000,
      costUsd: 0.001,
    },
    ...(type === 'ai' ? { semanticSteps: [], turns: [] } : {}),
  } as SerializedChunk;
}

function aiChunk(id: string, totalTokens: number) {
  return makeChunk(id, 'ai', totalTokens);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeChunkHotspots', () => {
  it('returns empty for < 4 AI chunks', () => {
    const chunks = [aiChunk('a1', 100), aiChunk('a2', 200), aiChunk('a3', 300)];
    const result = computeChunkHotspots(chunks, 200_000);

    expect(result.hotChunkIds.size).toBe(0);
    expect(result.chunkStats.size).toBe(0);
  });

  it('returns empty for uniform distribution (IQR = 0)', () => {
    const chunks = [aiChunk('a1', 500), aiChunk('a2', 500), aiChunk('a3', 500), aiChunk('a4', 500)];
    const result = computeChunkHotspots(chunks, 200_000);

    expect(result.hotChunkIds.size).toBe(0);
    expect(result.chunkStats.size).toBe(0);
  });

  it('correctly identifies outlier chunks with default 1.5x multiplier', () => {
    // Values: [100, 200, 300, 400, 2000]
    // Sorted: [100, 200, 300, 400, 2000]
    // Q1 = percentile(0.25) = 200, Q3 = percentile(0.75) = 400
    // IQR = 200, Upper fence = 400 + 1.5 * 200 = 700
    // 2000 > 700 → hot
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 200),
      aiChunk('a3', 300),
      aiChunk('a4', 400),
      aiChunk('a5', 2000),
    ];
    const result = computeChunkHotspots(chunks, 200_000);

    expect(result.hotChunkIds.size).toBe(1);
    expect(result.hotChunkIds.has('a5')).toBe(true);
    expect(result.chunkStats.get('a5')!.severity).toBe('hot');
    expect(result.chunkStats.get('a1')!.severity).toBe('none');
    expect(result.chunkStats.get('a4')!.severity).toBe('none');
  });

  it('different multipliers affect threshold', () => {
    // Same data: Q1=200, Q3=400, IQR=200
    // With multiplier=0.5: fence = 400 + 0.5*200 = 500
    // 2000 > 500 → hot, but also check 400 ≤ 500 → none
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 200),
      aiChunk('a3', 300),
      aiChunk('a4', 400),
      aiChunk('a5', 2000),
    ];

    const loose = computeChunkHotspots(chunks, 200_000, { iqrMultiplier: 10 });
    // fence = 400 + 10*200 = 2400 → 2000 < 2400 → no hotspots
    expect(loose.hotChunkIds.size).toBe(0);
    expect(loose.chunkStats.get('a5')!.severity).toBe('none');

    const tight = computeChunkHotspots(chunks, 200_000, { iqrMultiplier: 0.5 });
    // fence = 400 + 0.5*200 = 500 → 2000 > 500 → hot
    expect(tight.hotChunkIds.size).toBe(1);
    expect(tight.hotChunkIds.has('a5')).toBe(true);
  });

  it('uses DEFAULT_CONTEXT_WINDOW fallback when contextWindowTokens is undefined', () => {
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 200),
      aiChunk('a3', 300),
      aiChunk('a4', 400),
      aiChunk('a5', 2000),
    ];
    const result = computeChunkHotspots(chunks, undefined);

    const entry = result.chunkStats.get('a5')!;
    expect(entry.contextPct).toBeCloseTo((2000 / DEFAULT_CONTEXT_WINDOW) * 100, 5);
  });

  it('contextPct is clamped — no NaN/Infinity', () => {
    const chunks = [
      aiChunk('a1', 0),
      aiChunk('a2', 100),
      aiChunk('a3', 200),
      aiChunk('a4', 300),
      aiChunk('a5', 500_000),
    ];
    const result = computeChunkHotspots(chunks, 200_000);

    // 0 tokens → 0%
    expect(result.chunkStats.get('a1')!.contextPct).toBe(0);
    // 500k tokens / 200k = 250% → clamped to 100
    expect(result.chunkStats.get('a5')!.contextPct).toBe(100);

    // Verify no NaN or Infinity
    for (const [, entry] of result.chunkStats) {
      expect(Number.isFinite(entry.contextPct)).toBe(true);
    }
  });

  it('uses 200k fallback when contextWindowTokens is 0', () => {
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 200),
      aiChunk('a3', 300),
      aiChunk('a4', 1000),
    ];
    const result = computeChunkHotspots(chunks, 0);

    const entry = result.chunkStats.get('a4')!;
    expect(entry.contextPct).toBeCloseTo((1000 / DEFAULT_CONTEXT_WINDOW) * 100, 5);
  });

  it('ignores non-AI chunks', () => {
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 200),
      aiChunk('a3', 300),
      aiChunk('a4', 2000),
      makeChunk('u1', 'user', 50000), // user — ignored
      makeChunk('s1', 'system', 99999), // system — ignored
    ];
    const result = computeChunkHotspots(chunks, 200_000);

    // Only 4 AI chunks processed
    expect(result.chunkStats.size).toBe(4);
    expect(result.chunkStats.has('u1')).toBe(false);
    expect(result.chunkStats.has('s1')).toBe(false);
  });

  it('populates chunkStats for all AI chunks regardless of severity', () => {
    const chunks = [aiChunk('a1', 100), aiChunk('a2', 200), aiChunk('a3', 300), aiChunk('a4', 400)];
    const result = computeChunkHotspots(chunks, 200_000);

    expect(result.chunkStats.size).toBe(4);
    for (const [, entry] of result.chunkStats) {
      expect(entry.totalTokens).toBeGreaterThanOrEqual(0);
      expect(entry.contextPct).toBeGreaterThanOrEqual(0);
      expect(['none', 'hot']).toContain(entry.severity);
    }
  });

  it('detects single extreme outlier in otherwise uniform data', () => {
    // Values: [500, 500, 500, 500, 10000]
    // Sorted: [500, 500, 500, 500, 10000]
    // Q1 = percentile(0.25) = 500, Q3 = percentile(0.75) = 500
    // IQR = 0 → returns empty (uniform with outlier still has IQR=0 among quartiles)
    // Need at least some spread in lower data for IQR > 0
    // Use: [100, 100, 100, 200, 10000]
    // Q1 = 100, Q3 = 200, IQR = 100, fence = 200 + 1.5*100 = 350
    // 10000 > 350 → hot
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 100),
      aiChunk('a3', 100),
      aiChunk('a4', 200),
      aiChunk('a5', 10000),
    ];
    const result = computeChunkHotspots(chunks, 200_000);

    expect(result.hotChunkIds.size).toBe(1);
    expect(result.hotChunkIds.has('a5')).toBe(true);
    expect(result.chunkStats.get('a5')!.severity).toBe('hot');
    // All other chunks are 'none'
    expect(result.chunkStats.get('a1')!.severity).toBe('none');
    expect(result.chunkStats.get('a4')!.severity).toBe('none');
  });

  it('handles exactly 4 AI chunks (minimum for IQR)', () => {
    // Values: [100, 200, 300, 5000]
    // Q1 = percentile(0.25) at index 0.75 = 100 + (200-100)*0.75 = 175
    // Q3 = percentile(0.75) at index 2.25 = 300 + (5000-300)*0.25 = 1475
    // IQR = 1300, fence = 1475 + 1.5*1300 = 3425
    // 5000 > 3425 → hot
    const chunks = [
      aiChunk('a1', 100),
      aiChunk('a2', 200),
      aiChunk('a3', 300),
      aiChunk('a4', 5000),
    ];
    const result = computeChunkHotspots(chunks, 200_000);

    expect(result.hotChunkIds.size).toBe(1);
    expect(result.hotChunkIds.has('a4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterChunksForHotspot
// ---------------------------------------------------------------------------

function userChunk(id: string) {
  return makeChunk(id, 'user', 0);
}

function systemChunk(id: string) {
  return makeChunk(id, 'system', 0);
}

function compactChunk(id: string) {
  return makeChunk(id, 'compact', 0);
}

describe('filterChunksForHotspot', () => {
  it('returns all chunks when hotChunkIds is empty', () => {
    const chunks = [userChunk('u1'), aiChunk('a1', 100), userChunk('u2'), aiChunk('a2', 200)];
    const result = filterChunksForHotspot(chunks, new Set());

    expect(result).toBe(chunks); // same reference
  });

  it('keeps hot AI chunks and their preceding user chunk', () => {
    // u1 → a1(normal) → u2 → a2(hot) → u3 → a3(normal)
    const chunks = [
      userChunk('u1'),
      aiChunk('a1', 100),
      userChunk('u2'),
      aiChunk('a2', 2000),
      userChunk('u3'),
      aiChunk('a3', 100),
    ];
    const result = filterChunksForHotspot(chunks, new Set(['a2']));

    expect(result.map((c) => c.id)).toEqual(['u2', 'a2']);
  });

  it('hides non-adjacent user chunks and system chunks', () => {
    // u1 → s1 → a1(normal) → u2 → s2 → a2(hot)
    const chunks = [
      userChunk('u1'),
      systemChunk('s1'),
      aiChunk('a1', 100),
      userChunk('u2'),
      systemChunk('s2'),
      aiChunk('a2', 2000),
    ];
    const result = filterChunksForHotspot(chunks, new Set(['a2']));

    // u2 is the nearest preceding user chunk (skips s2)
    expect(result.map((c) => c.id)).toEqual(['u2', 'a2']);
  });

  it('always keeps compact chunks', () => {
    const chunks = [
      compactChunk('c1'),
      userChunk('u1'),
      aiChunk('a1', 100),
      compactChunk('c2'),
      userChunk('u2'),
      aiChunk('a2', 2000),
    ];
    const result = filterChunksForHotspot(chunks, new Set(['a2']));

    expect(result.map((c) => c.id)).toEqual(['c1', 'c2', 'u2', 'a2']);
  });

  it('handles hot AI chunk with no preceding user chunk', () => {
    // a1(hot) is first — no user chunk before it
    const chunks = [aiChunk('a1', 2000), userChunk('u1'), aiChunk('a2', 100)];
    const result = filterChunksForHotspot(chunks, new Set(['a1']));

    expect(result.map((c) => c.id)).toEqual(['a1']);
  });

  it('deduplicates shared preceding user chunk for adjacent hot AI chunks', () => {
    // u1 → a1(hot) → a2(hot) — both walk back to u1
    const chunks = [userChunk('u1'), aiChunk('a1', 2000), aiChunk('a2', 3000)];
    const result = filterChunksForHotspot(chunks, new Set(['a1', 'a2']));

    expect(result.map((c) => c.id)).toEqual(['u1', 'a1', 'a2']);
  });

  it('keeps separate preceding user chunks for non-adjacent hot AI chunks', () => {
    // u1 → a1(hot) → u2 → a2(normal) → u3 → a3(hot)
    const chunks = [
      userChunk('u1'),
      aiChunk('a1', 2000),
      userChunk('u2'),
      aiChunk('a2', 100),
      userChunk('u3'),
      aiChunk('a3', 3000),
    ];
    const result = filterChunksForHotspot(chunks, new Set(['a1', 'a3']));

    expect(result.map((c) => c.id)).toEqual(['u1', 'a1', 'u3', 'a3']);
  });

  it('handles mixed sequence with compact + system + multiple hot chunks', () => {
    const chunks = [
      compactChunk('c1'),
      userChunk('u1'),
      systemChunk('s1'),
      aiChunk('a1', 100),
      userChunk('u2'),
      aiChunk('a2', 2000), // hot
      systemChunk('s2'),
      userChunk('u3'),
      aiChunk('a3', 100),
      compactChunk('c2'),
      userChunk('u4'),
      aiChunk('a4', 3000), // hot
    ];
    const result = filterChunksForHotspot(chunks, new Set(['a2', 'a4']));

    // c1 (compact), u2 (preceding a2), a2 (hot), c2 (compact), u4 (preceding a4), a4 (hot)
    expect(result.map((c) => c.id)).toEqual(['c1', 'u2', 'a2', 'c2', 'u4', 'a4']);
  });
});

// ---------------------------------------------------------------------------
// Step-level hotspot helpers
// ---------------------------------------------------------------------------

function makeStep(
  id: string,
  type: SerializedSemanticStep['type'],
  estimatedTokens: number,
  toolCallId?: string,
): SerializedSemanticStep {
  return {
    id,
    type,
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 100,
    content: { toolCallId },
    estimatedTokens,
    context: 'main',
  } as SerializedSemanticStep;
}

function aiChunkWithSteps(
  id: string,
  totalTokens: number,
  steps: SerializedSemanticStep[],
): SerializedChunk {
  return {
    ...makeChunk(id, 'ai', totalTokens),
    semanticSteps: steps,
  } as SerializedChunk;
}

function makeDisplayItem(
  type: DisplayItem['type'],
  stepId: string,
  estimatedTokens: number,
  linkedResultTokens?: number,
): DisplayItem {
  const step = makeStep(stepId, type === 'tool' ? 'tool_call' : type, estimatedTokens);
  const item: DisplayItem = { type, step };
  if (linkedResultTokens !== undefined) {
    item.linkedResult = makeStep(`${stepId}-result`, 'tool_result', linkedResultTokens);
  }
  return item;
}

// ---------------------------------------------------------------------------
// computeStepHotspotThreshold
// ---------------------------------------------------------------------------

describe('computeStepHotspotThreshold', () => {
  it('returns null for fewer than 4 non-zero steps', () => {
    const chunks = [
      aiChunkWithSteps('a1', 100, [
        makeStep('s1', 'thinking', 50),
        makeStep('s2', 'output', 30),
        makeStep('s3', 'thinking', 20),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks)).toBeNull();
  });

  it('returns null when IQR is 0 (uniform step tokens)', () => {
    const chunks = [
      aiChunkWithSteps('a1', 400, [
        makeStep('s1', 'thinking', 100),
        makeStep('s2', 'output', 100),
        makeStep('s3', 'thinking', 100),
        makeStep('s4', 'output', 100),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks)).toBeNull();
  });

  it('returns IQR upper fence for varied step tokens', () => {
    // Values: [100, 200, 300, 400, 2000]
    // Q1=200, Q3=400, IQR=200, fence = 400 + 1.5*200 = 700
    const chunks = [
      aiChunkWithSteps('a1', 3000, [
        makeStep('s1', 'thinking', 100),
        makeStep('s2', 'output', 200),
        makeStep('s3', 'thinking', 300),
        makeStep('s4', 'output', 400),
        makeStep('s5', 'thinking', 2000),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks)).toBe(700);
  });

  it('combines tool_call + tool_result tokens via toolCallId', () => {
    // tool_call(500) + tool_result(300) = 800
    // Values: [100, 200, 300, 800]
    // Q1 = percentile(0.25) at 0.75 = 100 + (200-100)*0.75 = 175
    // Q3 = percentile(0.75) at 2.25 = 300 + (800-300)*0.25 = 425
    // IQR = 250, fence = 425 + 1.5*250 = 800
    const chunks = [
      aiChunkWithSteps('a1', 1400, [
        makeStep('s1', 'thinking', 100),
        makeStep('s2', 'output', 200),
        makeStep('s3', 'thinking', 300),
        makeStep('s4', 'tool_call', 500, 'tc-1'),
        makeStep('s5', 'tool_result', 300, 'tc-1'),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks)).toBe(800);
  });

  it('skips steps with estimatedTokens === 0', () => {
    // Non-zero values: [100, 200, 300, 2000] — only 4 values
    const chunks = [
      aiChunkWithSteps('a1', 2600, [
        makeStep('s0', 'output', 0), // skipped
        makeStep('s1', 'thinking', 100),
        makeStep('s2', 'output', 200),
        makeStep('s3', 'thinking', 300),
        makeStep('s4', 'thinking', 2000),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks)).not.toBeNull();
  });

  it('collects steps across multiple chunks', () => {
    // Chunk 1: [100, 200], Chunk 2: [300, 2000]
    // Combined: [100, 200, 300, 2000]
    const chunks = [
      aiChunkWithSteps('a1', 300, [makeStep('s1', 'thinking', 100), makeStep('s2', 'output', 200)]),
      aiChunkWithSteps('a2', 2300, [
        makeStep('s3', 'thinking', 300),
        makeStep('s4', 'output', 2000),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks)).not.toBeNull();
  });

  it('ignores non-AI chunks', () => {
    const chunks = [
      aiChunkWithSteps('a1', 300, [makeStep('s1', 'thinking', 100), makeStep('s2', 'output', 200)]),
      makeChunk('u1', 'user', 5000), // ignored
    ];
    // Only 2 values — should return null
    expect(computeStepHotspotThreshold(chunks)).toBeNull();
  });

  it('respects custom IQR multiplier', () => {
    // Values: [100, 200, 300, 400, 2000]
    // Q1=200, Q3=400, IQR=200
    // multiplier=10: fence = 400 + 10*200 = 2400 → threshold = 2400
    const chunks = [
      aiChunkWithSteps('a1', 3000, [
        makeStep('s1', 'thinking', 100),
        makeStep('s2', 'output', 200),
        makeStep('s3', 'thinking', 300),
        makeStep('s4', 'output', 400),
        makeStep('s5', 'thinking', 2000),
      ]),
    ];
    expect(computeStepHotspotThreshold(chunks, { iqrMultiplier: 10 })).toBe(2400);
  });
});

// ---------------------------------------------------------------------------
// classifyDisplayItemHotspots
// ---------------------------------------------------------------------------

describe('classifyDisplayItemHotspots', () => {
  it('marks items above threshold as hot', () => {
    const items = [
      makeDisplayItem('thinking', 's1', 100),
      makeDisplayItem('output', 's2', 200),
      makeDisplayItem('thinking', 's3', 2000),
    ];
    // threshold = 500
    const result = classifyDisplayItemHotspots(items, 500);

    expect(result.get('s1')!.isHot).toBe(false);
    expect(result.get('s2')!.isHot).toBe(false);
    expect(result.get('s3')!.isHot).toBe(true);
  });

  it('computes percentOfChunk from rendered items', () => {
    // Total: 100 + 200 + 700 = 1000
    const items = [
      makeDisplayItem('thinking', 's1', 100),
      makeDisplayItem('output', 's2', 200),
      makeDisplayItem('thinking', 's3', 700),
    ];
    const result = classifyDisplayItemHotspots(items, 500);

    expect(result.get('s1')!.percentOfChunk).toBeCloseTo(10, 1);
    expect(result.get('s2')!.percentOfChunk).toBeCloseTo(20, 1);
    expect(result.get('s3')!.percentOfChunk).toBeCloseTo(70, 1);
  });

  it('combines tool_call + linkedResult tokens', () => {
    // tool: step(300) + linkedResult(400) = 700
    const items = [makeDisplayItem('thinking', 's1', 100), makeDisplayItem('tool', 's2', 300, 400)];
    // threshold = 500 → tool(700) > 500 → hot
    const result = classifyDisplayItemHotspots(items, 500);

    expect(result.get('s2')!.isHot).toBe(true);
    expect(result.get('s2')!.estimatedTokens).toBe(700);
  });

  it('handles empty displayItems', () => {
    const result = classifyDisplayItemHotspots([], 500);
    expect(result.size).toBe(0);
  });

  it('percentOfChunk is 0 when total rendered tokens is 0', () => {
    const items = [makeDisplayItem('thinking', 's1', 0)];
    const result = classifyDisplayItemHotspots(items, 500);

    expect(result.get('s1')!.percentOfChunk).toBe(0);
    expect(result.get('s1')!.isHot).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SubBSM regression guards (step-level)
// ---------------------------------------------------------------------------

describe('SubBSM regression guards (step-level)', () => {
  it('duplicate step IDs across chunks: per-card classification is independent', () => {
    // Both chunks use "step-0", "step-1" — non-unique across chunks.
    // computeStepHotspotThreshold aggregates all tokens globally.
    // classifyDisplayItemHotspots is called per-card on local displayItems.
    // Result: step-0 is hot in card B but NOT in card A despite the same ID.
    const chunk1Steps = [makeStep('step-0', 'thinking', 100), makeStep('step-1', 'output', 200)];
    const chunk2Steps = [makeStep('step-0', 'thinking', 3000), makeStep('step-1', 'output', 100)];
    const chunks = [
      aiChunkWithSteps('a1', 300, chunk1Steps),
      aiChunkWithSteps('a2', 3100, chunk2Steps),
    ];

    // Combined: [100, 200, 3000, 100] → Q1=100, Q3=900, IQR=800, fence=2100
    const threshold = computeStepHotspotThreshold(chunks);
    expect(threshold).not.toBeNull();

    // Per-card classification for card A — neither step is hot
    const card1Items: DisplayItem[] = [
      makeDisplayItem('thinking', 'step-0', 100),
      makeDisplayItem('output', 'step-1', 200),
    ];
    const card1Result = classifyDisplayItemHotspots(card1Items, threshold!);
    expect(card1Result.get('step-0')!.isHot).toBe(false);
    expect(card1Result.get('step-1')!.isHot).toBe(false);

    // Per-card classification for card B — step-0 is hot
    const card2Items: DisplayItem[] = [
      makeDisplayItem('thinking', 'step-0', 3000),
      makeDisplayItem('output', 'step-1', 100),
    ];
    const card2Result = classifyDisplayItemHotspots(card2Items, threshold!);
    expect(card2Result.get('step-0')!.isHot).toBe(true);
    expect(card2Result.get('step-1')!.isHot).toBe(false);
  });

  it('merged tool-call/result hotspot keyed by tool_call step ID only', () => {
    // A tool DisplayItem has step (tool_call) + linkedResult (tool_result).
    // The hotspot map should key by tool_call step ID — tool_result ID absent.
    const items: DisplayItem[] = [
      makeDisplayItem('thinking', 's1', 100),
      makeDisplayItem('tool', 's2', 300, 400), // combined: 700
    ];
    const result = classifyDisplayItemHotspots(items, 500);

    // tool_call step ID 's2' is in the map with combined tokens
    expect(result.has('s2')).toBe(true);
    expect(result.get('s2')!.isHot).toBe(true);
    expect(result.get('s2')!.estimatedTokens).toBe(700);

    // tool_result step ID 's2-result' is NOT in the map
    expect(result.has('s2-result')).toBe(false);

    // Only 2 entries total (one per display item)
    expect(result.size).toBe(2);
  });

  it('hidden last-output excluded from classification map', () => {
    // buildDisplayItems() removes the last output step from displayItems.
    // classifyDisplayItemHotspots only sees the remaining rendered items.
    // The hidden output must not appear in the result map.
    const displayItems: DisplayItem[] = [
      makeDisplayItem('thinking', 's1', 100),
      makeDisplayItem('thinking', 's2', 300),
      // s3 (output, 2000 tokens) was removed by buildDisplayItems as lastOutput
    ];

    const result = classifyDisplayItemHotspots(displayItems, 200);

    // Only rendered items in map — hidden s3 absent
    expect(result.size).toBe(2);
    expect(result.has('s1')).toBe(true);
    expect(result.has('s2')).toBe(true);
    expect(result.has('s3')).toBe(false);

    // percentOfChunk is based only on rendered items: s1(100) + s2(300) = 400
    expect(result.get('s1')!.percentOfChunk).toBeCloseTo(25, 1);
    expect(result.get('s2')!.percentOfChunk).toBeCloseTo(75, 1);
  });
});
