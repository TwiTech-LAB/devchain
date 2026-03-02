import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Information about a discovered subagent file */
export interface SubagentFileInfo {
  /** Absolute path to the subagent JSONL file */
  filePath: string;
  /** Agent identifier extracted from filename (e.g., "agent-0") */
  agentId: string;
  /** Which directory structure the file was found in */
  directoryType: 'new' | 'legacy';
}

/** Pattern matching subagent JSONL filenames (agent-{id}.jsonl) */
const AGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/;

/**
 * Discovers subagent JSONL files for a given parent session.
 *
 * Supports two directory structures:
 * - **New**: `{projectDir}/{sessionUuid}/subagents/agent-{id}.jsonl`
 * - **Legacy**: `{projectDir}/agent-{id}.jsonl`
 *
 * Files are returned sorted by agent ID for deterministic ordering.
 */
@Injectable()
export class SubagentLocator {
  private readonly logger = new Logger(SubagentLocator.name);

  /**
   * Locate subagent JSONL files for a parent session.
   *
   * @param parentFilePath - Absolute path to the parent session's JSONL file
   * @returns Array of discovered subagent file info, sorted by agentId
   */
  async locate(parentFilePath: string): Promise<SubagentFileInfo[]> {
    const projectDir = path.dirname(parentFilePath);
    const sessionUuid = path.basename(parentFilePath, '.jsonl');
    const results: SubagentFileInfo[] = [];

    // New structure: {projectDir}/{sessionUuid}/subagents/agent-{id}.jsonl
    const newSubagentDir = path.join(projectDir, sessionUuid, 'subagents');
    const newFiles = await this.scanDirectory(newSubagentDir, 'new');
    results.push(...newFiles);

    // Legacy structure: {projectDir}/agent-{id}.jsonl
    const legacyFiles = await this.scanDirectory(projectDir, 'legacy');
    results.push(...legacyFiles);

    // Deduplicate: if same agentId found in both, prefer 'new' structure
    const seen = new Set<string>();
    const deduped: SubagentFileInfo[] = [];
    for (const file of results) {
      if (!seen.has(file.agentId)) {
        seen.add(file.agentId);
        deduped.push(file);
      }
    }

    // Sort by agent ID for deterministic ordering
    deduped.sort((a, b) => a.agentId.localeCompare(b.agentId, undefined, { numeric: true }));

    this.logger.debug({ parentFilePath, count: deduped.length }, 'Located subagent files');

    return deduped;
  }

  /**
   * Scan a directory for subagent JSONL files matching the agent-{id}.jsonl pattern.
   */
  private async scanDirectory(
    dirPath: string,
    directoryType: 'new' | 'legacy',
  ): Promise<SubagentFileInfo[]> {
    const results: SubagentFileInfo[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = AGENT_FILE_PATTERN.exec(entry.name);
        if (!match) continue;

        results.push({
          filePath: path.join(dirPath, entry.name),
          agentId: `agent-${match[1]}`,
          directoryType,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ error, dirPath }, 'Failed to scan subagent directory');
      }
    }

    return results;
  }
}
