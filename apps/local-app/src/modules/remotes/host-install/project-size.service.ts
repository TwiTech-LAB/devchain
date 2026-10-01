import { Injectable } from '@nestjs/common';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../../common/logging/logger';
import { FileSyncService } from '../../file-sync/file-sync.service';

const logger = createLogger('ProjectSizeService');

/** A project size is unknown when the walk cannot finish reliably. */
export interface ProjectSizeEstimate {
  bytes: number | null;
  approximate: boolean;
}

export const PROJECT_SIZE_TIMEOUT_MS = 60_000;

interface IgnoreRule {
  name: string;
  caseInsensitive: boolean;
}

interface IgnoreRules {
  rules: IgnoreRule[];
  approximate: boolean;
}

class ProjectSizeTimeoutError extends Error {
  constructor() {
    super('Project size walk timed out');
    this.name = 'ProjectSizeTimeoutError';
  }
}

function parseIgnoreRules(patterns: readonly string[]): IgnoreRules {
  const rules: IgnoreRule[] = [];
  let approximate = false;

  for (const rawPattern of patterns) {
    let pattern = rawPattern.trim();
    let caseInsensitive = false;

    while (pattern.startsWith('(?d)') || pattern.startsWith('(?i)')) {
      if (pattern.startsWith('(?i)')) caseInsensitive = true;
      pattern = pattern.slice(4);
    }

    if (!pattern) continue;
    if (/[/*?!\[]/.test(pattern) || pattern.includes('//')) {
      approximate = true;
      continue;
    }

    rules.push({ name: caseInsensitive ? pattern.toLowerCase() : pattern, caseInsensitive });
  }

  return { rules, approximate };
}

function isIgnored(name: string, rules: readonly IgnoreRule[]): boolean {
  return rules.some((rule) =>
    rule.caseInsensitive ? name.toLowerCase() === rule.name : name === rule.name,
  );
}

/**
 * Measures a project root for host-install disk preflight. The walk deliberately
 * uses lstat so symlinks never pull files outside the project into the estimate.
 */
@Injectable()
export class ProjectSizeService {
  constructor(private readonly fileSync: FileSyncService) {}

  async measure(
    projectId: string,
    rootPath: string,
    timeoutMs = PROJECT_SIZE_TIMEOUT_MS,
  ): Promise<ProjectSizeEstimate> {
    const ignoreRules = parseIgnoreRules(this.fileSync.getIgnores(projectId));
    const walk = this.walk(
      rootPath,
      ignoreRules.rules,
      () => {
        throw new ProjectSizeTimeoutError();
      },
      timeoutMs,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProjectSizeTimeoutError()), timeoutMs);
      });
      const bytes = await Promise.race([walk, timeout]);
      return { bytes, approximate: ignoreRules.approximate };
    } catch (error) {
      if (!(error instanceof ProjectSizeTimeoutError)) {
        logger.warn({ projectId, bytes: null }, 'Project size estimate failed');
      }
      return { bytes: null, approximate: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async walk(
    rootPath: string,
    rules: readonly IgnoreRule[],
    checkTimeout: () => void,
    timeoutMs: number,
    startedAt = Date.now(),
  ): Promise<number> {
    const checkDeadline = () => {
      if (Date.now() - startedAt >= timeoutMs) checkTimeout();
    };

    checkDeadline();
    const directory = await opendir(rootPath);
    let bytes = 0;
    try {
      for await (const entry of directory) {
        checkDeadline();
        if (isIgnored(entry.name, rules)) continue;

        const entryPath = join(rootPath, entry.name);
        const stats = await lstat(entryPath);
        checkDeadline();
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          bytes += await this.walk(entryPath, rules, checkTimeout, timeoutMs, startedAt);
        } else if (stats.isFile()) {
          bytes += stats.size;
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return bytes;
  }
}

export { isIgnored, parseIgnoreRules };
