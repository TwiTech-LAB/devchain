import { Injectable } from '@nestjs/common';
import { homedir } from 'os';
import { join, dirname, resolve, normalize } from 'path';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'fs/promises';
import { randomBytes } from 'crypto';
import { createLogger } from '../../../common/logging/logger';
import { getEffectiveTrust, type TrustLevel } from './trust-folders-logic';

const logger = createLogger('AntigravityTrustedWorkspaces');

const VALID_LEVELS = new Set<string>(['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST']);

/**
 * A single warning to surface via the provisioning pipeline. Shape is structurally
 * compatible with `ProvisioningWarningItem` so the adapter can pass it straight
 * through into a `ProvisioningResult` (kept local to avoid a core → capability dep).
 */
export interface AntigravityTrustWarning {
  source: 'trusted_workspaces' | 'trusted_folders';
  level: 'warn';
  message: string;
  code?: string;
}

export interface EnsureAntigravityTrustResult {
  /**
   * True when the agy-native store (`trustedWorkspaces[]`) ends up trusting the
   * path (added or already present). The shared `trustedFolders.json` write is
   * best-effort belt-and-suspenders; its failures are surfaced as warnings only.
   */
  success: boolean;
  warnings: AntigravityTrustWarning[];
}

/**
 * Dedicated workspace-trust provisioner for Google Antigravity (`agy`).
 *
 * Per the P1-1(c) spike (`docs/spikes/agy-p1-1-spike-findings.md`):
 * `--dangerously-skip-permissions` only auto-approves tool permissions, NOT
 * workspace trust — trust must be pre-written so the full-screen TUI launches
 * non-interactively. The spike found two stores in play, so we write BOTH:
 *  1. `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces: []` (the
 *     documented agy key — the authoritative agy-native store).
 *  2. `~/.gemini/trustedFolders.json` (`"<abs-path>": "TRUST_FOLDER"`) — the
 *     shared gemini-family effective-trust store, written with the same
 *     semantics (reusing the exported pure `getEffectiveTrust`).
 *
 * This is a DEDICATED service with its own trust stores (it does not share state
 * with any other provider's trust service).
 * All writes are atomic (tmp + rename, mode 0600). A malformed existing file is
 * never overwritten (no data loss); the issue is surfaced as a warning.
 */
@Injectable()
export class AntigravityTrustedWorkspacesService {
  private writeTail: Promise<unknown> = Promise.resolve();

  private get settingsPath(): string {
    return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  }

  private get trustedFoldersPath(): string {
    return join(homedir(), '.gemini', 'trustedFolders.json');
  }

  /**
   * Ensure `projectPath` is trusted for agy across both stores. Serialized via a
   * write-tail so concurrent provisioning calls never interleave file writes.
   */
  ensure(projectPath: string): Promise<EnsureAntigravityTrustResult> {
    const op = this.writeTail.catch(() => undefined).then(() => this.doEnsure(projectPath));
    this.writeTail = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  private async doEnsure(projectPath: string): Promise<EnsureAntigravityTrustResult> {
    const normalizedPath = await this.normalizePath(projectPath);
    const warnings: AntigravityTrustWarning[] = [];

    const native = await this.ensureTrustedWorkspaces(normalizedPath);
    warnings.push(...native.warnings);

    const shared = await this.ensureTrustedFolders(normalizedPath);
    warnings.push(...shared.warnings);

    return { success: native.trusted, warnings };
  }

  // ── Store 1: agy-native antigravity-cli/settings.json trustedWorkspaces[] ──

  private async ensureTrustedWorkspaces(
    normalizedPath: string,
  ): Promise<{ trusted: boolean; warnings: AntigravityTrustWarning[] }> {
    const warnings: AntigravityTrustWarning[] = [];
    const filePath = this.settingsPath;

    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    } catch (err) {
      warnings.push({
        source: 'trusted_workspaces',
        level: 'warn',
        message: `Failed to create directory ${dirname(filePath)}: ${String(err)}`,
        code: 'AGY_TRUST_DIR_FAILED',
      });
      return { trusted: false, warnings };
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        raw = '{}';
      } else {
        warnings.push({
          source: 'trusted_workspaces',
          level: 'warn',
          message: `Failed to read ${filePath}: ${String(err)}`,
          code: 'AGY_TRUST_READ_FAILED',
        });
        return { trusted: false, warnings };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push({
        source: 'trusted_workspaces',
        level: 'warn',
        message: `${filePath} contains invalid JSON — refusing to modify`,
        code: 'AGY_SETTINGS_MALFORMED',
      });
      return { trusted: false, warnings };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push({
        source: 'trusted_workspaces',
        level: 'warn',
        message: `${filePath} root is not a JSON object — refusing to modify`,
        code: 'AGY_SETTINGS_MALFORMED',
      });
      return { trusted: false, warnings };
    }

    const settings = parsed as Record<string, unknown>;
    const existing = settings.trustedWorkspaces;

    if (existing !== undefined && !Array.isArray(existing)) {
      warnings.push({
        source: 'trusted_workspaces',
        level: 'warn',
        message: `${filePath} "trustedWorkspaces" is not an array — refusing to modify`,
        code: 'AGY_TRUSTED_WORKSPACES_MALFORMED',
      });
      return { trusted: false, warnings };
    }

    // Preserve any non-string entries verbatim (no data loss); dedupe by value.
    const list: unknown[] = Array.isArray(existing) ? [...existing] : [];
    if (list.includes(normalizedPath)) {
      return { trusted: true, warnings };
    }

    list.push(normalizedPath);
    const merged = { ...settings, trustedWorkspaces: list };

    try {
      await this.atomicWrite(filePath, JSON.stringify(merged, null, 2) + '\n');
    } catch (err) {
      warnings.push({
        source: 'trusted_workspaces',
        level: 'warn',
        message: `Failed to write ${filePath}: ${String(err)}`,
        code: 'AGY_TRUST_WRITE_FAILED',
      });
      return { trusted: false, warnings };
    }

    logger.info({ projectPath: normalizedPath }, 'Added agy trustedWorkspaces entry');
    return { trusted: true, warnings };
  }

  // ── Store 2: shared ~/.gemini/trustedFolders.json (gemini-family semantics) ──

  private async ensureTrustedFolders(
    normalizedPath: string,
  ): Promise<{ warnings: AntigravityTrustWarning[] }> {
    const warnings: AntigravityTrustWarning[] = [];
    const filePath = this.trustedFoldersPath;

    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    } catch {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `Failed to create directory ${dirname(filePath)}`,
        code: 'AGY_TRUSTED_FOLDERS_DIR_FAILED',
      });
      return { warnings };
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        raw = '{}';
      } else {
        warnings.push({
          source: 'trusted_folders',
          level: 'warn',
          message: `Failed to read ${filePath}: ${String(err)}`,
          code: 'AGY_TRUSTED_FOLDERS_READ_FAILED',
        });
        return { warnings };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `${filePath} contains invalid JSON — refusing to modify`,
        code: 'AGY_TRUSTED_FOLDERS_MALFORMED',
      });
      return { warnings };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `${filePath} root is not a JSON object — refusing to modify`,
        code: 'AGY_TRUSTED_FOLDERS_MALFORMED',
      });
      return { warnings };
    }

    const allRules = parsed as Record<string, unknown>;
    const validRules: Record<string, TrustLevel> = {};
    for (const [path, value] of Object.entries(allRules)) {
      if (typeof value === 'string' && VALID_LEVELS.has(value)) {
        validRules[path] = value as TrustLevel;
      }
      // Unknown entries are preserved verbatim in the merge below (no data loss).
    }

    const trust = getEffectiveTrust(normalizedPath, validRules);

    if (trust.kind === 'trusted') {
      return { warnings };
    }

    if (trust.kind === 'distrusted') {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `${normalizedPath} is explicitly distrusted (${trust.via}) in ${filePath} — not overriding`,
        code: 'AGY_TRUSTED_FOLDERS_DISTRUSTED',
      });
      return { warnings };
    }

    const merged = { ...allRules, [normalizedPath]: 'TRUST_FOLDER' };
    try {
      await this.atomicWrite(filePath, JSON.stringify(merged, null, 2) + '\n');
    } catch (err) {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `Failed to write ${filePath}: ${String(err)}`,
        code: 'AGY_TRUSTED_FOLDERS_WRITE_FAILED',
      });
      return { warnings };
    }

    logger.info({ projectPath: normalizedPath }, 'Added trustedFolders entry for agy');
    return { warnings };
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, content, { mode: 0o600 });
      await rename(tmpPath, filePath);
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
