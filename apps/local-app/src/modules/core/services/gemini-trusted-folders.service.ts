import { Injectable } from '@nestjs/common';
import { homedir } from 'os';
import { join, dirname, resolve, normalize } from 'path';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'fs/promises';
import { randomBytes } from 'crypto';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('GeminiTrustedFolders');

type TrustLevel = 'TRUST_FOLDER' | 'TRUST_PARENT' | 'DO_NOT_TRUST';

const VALID_LEVELS = new Set<string>(['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST']);

export type EffectiveTrust =
  | { kind: 'trusted'; via: 'exact' | 'ancestor' | 'parent_rule' }
  | { kind: 'distrusted'; via: 'exact' | 'ancestor' }
  | { kind: 'no_rule' };

export type EnsureTrustResult = {
  success: boolean;
  action: 'added' | 'already_trusted' | 'distrusted_warning' | 'malformed_warning';
  message: string;
  warnings?: string[];
};

function isSubpath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const parentWithSep = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(parentWithSep);
}

export function getEffectiveTrust(
  projectPath: string,
  rules: Record<string, TrustLevel>,
): EffectiveTrust {
  let bestMatch: { effectivePath: string; level: TrustLevel; rulePath: string } | null = null;

  for (const [rulePath, level] of Object.entries(rules)) {
    const effectivePath = level === 'TRUST_PARENT' ? dirname(rulePath) : rulePath;

    if (!isSubpath(effectivePath, projectPath)) continue;

    if (!bestMatch || effectivePath.length > bestMatch.effectivePath.length) {
      bestMatch = { effectivePath, level, rulePath };
    }
  }

  if (!bestMatch) return { kind: 'no_rule' };

  if (bestMatch.level === 'DO_NOT_TRUST') {
    const via = bestMatch.effectivePath === projectPath ? 'exact' : 'ancestor';
    return { kind: 'distrusted', via };
  }

  if (bestMatch.level === 'TRUST_FOLDER') {
    const via = bestMatch.effectivePath === projectPath ? 'exact' : 'ancestor';
    return { kind: 'trusted', via };
  }

  return { kind: 'trusted', via: 'parent_rule' };
}

@Injectable()
export class GeminiTrustedFoldersService {
  private writeTail: Promise<unknown> = Promise.resolve();

  private get filePath(): string {
    return join(homedir(), '.gemini', 'trustedFolders.json');
  }

  ensure(projectPath: string): Promise<EnsureTrustResult> {
    const op = this.writeTail.catch(() => undefined).then(() => this.doEnsure(projectPath));
    this.writeTail = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  private async doEnsure(projectPath: string): Promise<EnsureTrustResult> {
    const normalizedPath = await this.normalizePath(projectPath);
    const dirPath = dirname(this.filePath);

    try {
      await mkdir(dirPath, { recursive: true, mode: 0o700 });
    } catch {
      return {
        success: false,
        action: 'malformed_warning',
        message: `Failed to create directory ${dirPath}`,
      };
    }

    let rawContent: string;
    try {
      rawContent = await readFile(this.filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        rawContent = '{}';
      } else {
        return {
          success: false,
          action: 'malformed_warning',
          message: `Failed to read ${this.filePath}: ${String(err)}`,
        };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return {
        success: false,
        action: 'malformed_warning',
        message: `${this.filePath} contains invalid JSON — refusing to modify`,
      };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        success: false,
        action: 'malformed_warning',
        message: `${this.filePath} root is not a JSON object — refusing to modify`,
      };
    }

    const allRules = parsed as Record<string, unknown>;
    const warnings: string[] = [];
    const validRules: Record<string, TrustLevel> = {};

    for (const [path, value] of Object.entries(allRules)) {
      if (typeof value === 'string' && VALID_LEVELS.has(value)) {
        validRules[path] = value as TrustLevel;
      } else {
        warnings.push(`Invalid trust value for "${path}": ${JSON.stringify(value)}`);
      }
    }

    const trust = getEffectiveTrust(normalizedPath, validRules);

    if (trust.kind === 'trusted') {
      return {
        success: true,
        action: 'already_trusted',
        message: `${normalizedPath} is already effectively trusted (${trust.via})`,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (trust.kind === 'distrusted') {
      return {
        success: false,
        action: 'distrusted_warning',
        message: `${normalizedPath} is explicitly distrusted (${trust.via}) — not overriding`,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const merged = { ...allRules, [normalizedPath]: 'TRUST_FOLDER' };

    try {
      await this.atomicWrite(JSON.stringify(merged, null, 2) + '\n');
    } catch (err) {
      return {
        success: false,
        action: 'malformed_warning',
        message: `Failed to write ${this.filePath}: ${String(err)}`,
      };
    }

    logger.info({ projectPath: normalizedPath }, 'Added trust entry');

    return {
      success: true,
      action: 'added',
      message: `Added ${normalizedPath} to trusted folders`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private async atomicWrite(content: string): Promise<void> {
    const tmpPath = `${this.filePath}.tmp.${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, content, { mode: 0o600 });
      await rename(tmpPath, this.filePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {}
      throw err;
    }
  }

  private async normalizePath(projectPath: string): Promise<string> {
    const resolved = resolve(normalize(projectPath));
    try {
      return await realpath(resolved);
    } catch {
      return resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
    }
  }
}
