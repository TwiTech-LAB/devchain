import { Injectable, Logger } from '@nestjs/common';
import { SubagentLocator, type SubagentFileInfo } from './subagent-locator.service';
import { SessionCacheService } from './session-cache.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { UnifiedSession, UnifiedProcess } from '../dtos/unified-session.types';
import type { SessionReaderAdapter } from '../adapters/session-reader-adapter.interface';

/** Overlap threshold for parallel execution detection (ms) */
const PARALLEL_OVERLAP_THRESHOLD_MS = 100;

/** Default concurrency for parsing subagent files */
const DEFAULT_CONCURRENCY = 24;

/** Content marker for warmup agents */
const WARMUP_CONTENT = 'Warmup';

/** A parsed subagent file with metadata used during resolution */
interface ParsedSubagent {
  fileInfo: SubagentFileInfo;
  session: UnifiedSession;
  /** sourceToolUseId from the first user message (if present) */
  sourceToolUseId: string | null;
  /** Whether this is a warmup agent */
  isWarmup: boolean;
}

/** A Task tool call extracted from the parent session */
interface TaskToolCall {
  toolCallId: string;
  description?: string;
  subagentType?: string;
  /** Message timestamp for ordering */
  timestamp: Date;
}

/**
 * Resolves subagent JSONL files to parent session Task tool calls.
 *
 * Resolution uses a 3-tier matching strategy:
 * 1. **Result-based**: Match sourceToolUseId from subagent's first user entry
 *    to parent's Task tool_use ID (primary, most reliable)
 * 2. **Description-based**: Match agent file identifiers to task descriptions
 *    containing team member patterns (e.g., "name@team")
 * 3. **Positional fallback**: Sequential matching without wrap-around
 *
 * After matching, detects parallel execution (100ms overlap threshold)
 * and filters out warmup agents.
 */
@Injectable()
export class SubagentResolver {
  private readonly logger = new Logger(SubagentResolver.name);

  constructor(
    private readonly locator: SubagentLocator,
    private readonly cacheService: SessionCacheService,
    private readonly adapterFactory: SessionReaderAdapterFactory,
  ) {}

  /**
   * Resolve subagent files for a parent session.
   *
   * @param parentSession - The parsed parent session
   * @param parentFilePath - Absolute path to the parent session file
   * @param providerName - Provider name for adapter lookup
   * @returns Array of resolved processes (warmup agents excluded)
   */
  async resolve(
    parentSession: UnifiedSession,
    parentFilePath: string,
    providerName: string,
  ): Promise<UnifiedProcess[]> {
    // 1. Locate subagent files
    const fileInfos = await this.locator.locate(parentFilePath);
    if (fileInfos.length === 0) {
      this.logger.debug({ parentFilePath }, 'No subagent files found');
      return [];
    }

    // 2. Get adapter for parsing
    const adapter = this.adapterFactory.getAdapter(providerName);
    if (!adapter) {
      this.logger.warn(
        { providerName },
        'No adapter found for provider — cannot parse subagent files',
      );
      return [];
    }

    // 3. Parse all subagent files concurrently (with concurrency limit)
    const parsed = await this.parseSubagentFiles(fileInfos, adapter);

    // 4. Filter out warmup agents
    const nonWarmup = parsed.filter((p) => !p.isWarmup);
    const warmupCount = parsed.length - nonWarmup.length;
    if (warmupCount > 0) {
      this.logger.debug({ warmupCount }, 'Filtered out warmup agents');
    }

    // 5. Extract Task tool calls from parent session
    const taskCalls = this.extractTaskToolCalls(parentSession);
    if (taskCalls.length === 0) {
      this.logger.debug({ parentFilePath }, 'No Task tool calls found in parent session');
      return [];
    }

    // 6. Match subagent files to Task tool calls (3-tier)
    const matched = this.matchSubagentsToTasks(nonWarmup, taskCalls);

    // 7. Detect parallel execution
    this.markParallelExecution(matched);

    return matched;
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse subagent files with bounded concurrency.
   * Missing/corrupt files are logged and skipped.
   */
  private async parseSubagentFiles(
    fileInfos: SubagentFileInfo[],
    adapter: SessionReaderAdapter,
  ): Promise<ParsedSubagent[]> {
    const results: ParsedSubagent[] = [];

    // Process in batches for concurrency control
    for (let i = 0; i < fileInfos.length; i += DEFAULT_CONCURRENCY) {
      const batch = fileInfos.slice(i, i + DEFAULT_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map((info) => this.parseSingleSubagent(info, adapter)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(
            { error: result.reason, filePath: batch[j].filePath },
            'Failed to parse subagent file — skipping',
          );
        }
      }
    }

    return results;
  }

  /**
   * Parse a single subagent file and extract metadata for resolution.
   */
  private async parseSingleSubagent(
    fileInfo: SubagentFileInfo,
    adapter: SessionReaderAdapter,
  ): Promise<ParsedSubagent | null> {
    try {
      const session = await this.cacheService.getOrParse(
        fileInfo.filePath,
        fileInfo.filePath,
        adapter,
      );

      // Extract sourceToolUseId from first user message
      const firstUserMsg = session.messages.find((m) => m.role === 'user');
      const sourceToolUseId = firstUserMsg?.sourceToolUseId ?? null;

      // Detect warmup agent: first user message content is exactly "Warmup"
      const isWarmup = this.isWarmupAgent(session);

      return { fileInfo, session, sourceToolUseId, isWarmup };
    } catch (error) {
      this.logger.warn(
        { error, filePath: fileInfo.filePath },
        'Failed to parse subagent file — skipping',
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Task tool call extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract Task tool calls from the parent session's messages.
   * Returns them in message order (chronological).
   */
  private extractTaskToolCalls(session: UnifiedSession): TaskToolCall[] {
    const taskCalls: TaskToolCall[] = [];

    for (const msg of session.messages) {
      if (msg.role !== 'assistant') continue;
      for (const tc of msg.toolCalls) {
        if (!tc.isTask) continue;
        taskCalls.push({
          toolCallId: tc.id,
          description: tc.taskDescription,
          subagentType: tc.taskSubagentType,
          timestamp: msg.timestamp,
        });
      }
    }

    return taskCalls;
  }

  // ---------------------------------------------------------------------------
  // 3-Tier Matching
  // ---------------------------------------------------------------------------

  /**
   * Match subagent files to Task tool calls using 3-tier strategy.
   *
   * Tier 1 (result-based): sourceToolUseId → toolCallId direct match
   * Tier 2 (description-based): agent file identifier in task description
   * Tier 3 (positional): sequential matching without wrap-around
   */
  private matchSubagentsToTasks(
    subagents: ParsedSubagent[],
    taskCalls: TaskToolCall[],
  ): UnifiedProcess[] {
    const results: UnifiedProcess[] = [];
    const matchedTaskIds = new Set<string>();
    const matchedSubagentPaths = new Set<string>();
    let processIndex = 0;

    // --- Tier 1: Result-based matching (sourceToolUseId) ---
    for (const subagent of subagents) {
      if (!subagent.sourceToolUseId) continue;
      if (matchedSubagentPaths.has(subagent.fileInfo.filePath)) continue;

      const task = taskCalls.find(
        (tc) => tc.toolCallId === subagent.sourceToolUseId && !matchedTaskIds.has(tc.toolCallId),
      );
      if (!task) continue;

      results.push(this.buildProcess(processIndex++, task, subagent, 'result'));
      matchedTaskIds.add(task.toolCallId);
      matchedSubagentPaths.add(subagent.fileInfo.filePath);
    }

    // --- Tier 2: Description-based matching ---
    for (const subagent of subagents) {
      if (matchedSubagentPaths.has(subagent.fileInfo.filePath)) continue;

      const task = this.findDescriptionMatch(subagent, taskCalls, matchedTaskIds);
      if (!task) continue;

      results.push(this.buildProcess(processIndex++, task, subagent, 'description'));
      matchedTaskIds.add(task.toolCallId);
      matchedSubagentPaths.add(subagent.fileInfo.filePath);
    }

    // --- Tier 3: Positional fallback (sequential, no wrap-around) ---
    const unmatchedSubagents = subagents.filter(
      (s) => !matchedSubagentPaths.has(s.fileInfo.filePath),
    );
    const unmatchedTasks = taskCalls.filter((tc) => !matchedTaskIds.has(tc.toolCallId));

    const positionalCount = Math.min(unmatchedSubagents.length, unmatchedTasks.length);
    for (let i = 0; i < positionalCount; i++) {
      results.push(
        this.buildProcess(processIndex++, unmatchedTasks[i], unmatchedSubagents[i], 'positional'),
      );
    }

    // Log unmatched subagents (if any remain after all tiers)
    if (unmatchedSubagents.length > positionalCount) {
      this.logger.debug(
        { count: unmatchedSubagents.length - positionalCount },
        'Some subagent files could not be matched to Task tool calls',
      );
    }

    return results;
  }

  /**
   * Tier 2: Try to match a subagent to a task via description patterns.
   * Looks for agent identifiers like "name@team" in the task description.
   */
  private findDescriptionMatch(
    subagent: ParsedSubagent,
    taskCalls: TaskToolCall[],
    matchedTaskIds: Set<string>,
  ): TaskToolCall | null {
    const agentId = subagent.fileInfo.agentId;

    for (const task of taskCalls) {
      if (matchedTaskIds.has(task.toolCallId)) continue;
      if (!task.description) continue;

      // Check if the task description contains the agent identifier
      if (task.description.includes(agentId)) {
        return task;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Parallel execution detection
  // ---------------------------------------------------------------------------

  /**
   * Mark processes that ran in parallel (overlapping by >100ms).
   * Modifies `isParallel` in place on each process.
   */
  private markParallelExecution(processes: UnifiedProcess[]): void {
    if (processes.length < 2) return;

    // Build time ranges from each process's session
    const ranges = processes.map((p) => this.getSessionTimeRange(p.session));

    for (let i = 0; i < processes.length; i++) {
      if (processes[i].isParallel) continue;

      for (let j = i + 1; j < processes.length; j++) {
        const overlap = this.computeOverlapMs(ranges[i], ranges[j]);
        if (overlap > PARALLEL_OVERLAP_THRESHOLD_MS) {
          processes[i].isParallel = true;
          processes[j].isParallel = true;
        }
      }
    }
  }

  /**
   * Get the time range (start, end) of a session from its messages.
   */
  private getSessionTimeRange(session: UnifiedSession): { start: number; end: number } {
    if (session.messages.length === 0) {
      return { start: 0, end: 0 };
    }
    const first = session.messages[0].timestamp.getTime();
    const last = session.messages[session.messages.length - 1].timestamp.getTime();
    return { start: first, end: last };
  }

  /**
   * Compute the overlap in milliseconds between two time ranges.
   */
  private computeOverlapMs(
    a: { start: number; end: number },
    b: { start: number; end: number },
  ): number {
    const overlapStart = Math.max(a.start, b.start);
    const overlapEnd = Math.min(a.end, b.end);
    return Math.max(0, overlapEnd - overlapStart);
  }

  // ---------------------------------------------------------------------------
  // Warmup detection
  // ---------------------------------------------------------------------------

  /**
   * Detect warmup agents: first user message content is exactly "Warmup".
   */
  private isWarmupAgent(session: UnifiedSession): boolean {
    const firstUserMsg = session.messages.find((m) => m.role === 'user');
    if (!firstUserMsg) return false;

    const textBlocks = firstUserMsg.content.filter((b) => b.type === 'text');
    if (textBlocks.length !== 1) return false;

    return (textBlocks[0] as { text: string }).text.trim() === WARMUP_CONTENT;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildProcess(
    index: number,
    task: TaskToolCall,
    subagent: ParsedSubagent,
    matchMethod: UnifiedProcess['matchMethod'],
  ): UnifiedProcess {
    return {
      id: `process-${index}`,
      toolCallId: task.toolCallId,
      description: task.description,
      subagentType: task.subagentType,
      filePath: subagent.fileInfo.filePath,
      session: subagent.session,
      matchMethod,
      isParallel: false,
    };
  }
}
