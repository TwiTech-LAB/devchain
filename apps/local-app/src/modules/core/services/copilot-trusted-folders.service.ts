import { Injectable } from '@nestjs/common';
import { homedir } from 'os';
import { join, dirname, resolve, normalize } from 'path';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'fs/promises';
import { randomBytes } from 'crypto';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('CopilotTrustedFolders');

/**
 * A single warning to surface via the provisioning pipeline. Shape is
 * structurally compatible with `ProvisioningWarningItem` so the adapter can pass
 * it straight through into a `ProvisioningResult` (kept local to avoid a
 * core → capability dependency).
 */
export interface CopilotTrustWarning {
  source: 'trusted_folders';
  level: 'warn';
  message: string;
  code?: string;
}

export interface EnsureCopilotTrustResult {
  /** True when `trustedFolders[]` ends up trusting the path (added or already present). */
  success: boolean;
  warnings: CopilotTrustWarning[];
}

/**
 * Dedicated folder-trust provisioner for the GitHub Copilot CLI (`copilot`).
 *
 * Per spike S1 (epic 3be9ec57): an interactive (`-i`) TUI launch in an untrusted
 * folder HARD-BLOCKS on a "Confirm folder trust" modal, and NO launch flag
 * bypasses it (`--yolo`/`--allow-all` still prompt). The only non-interactive
 * mechanism is to pre-write the project path into `~/.copilot/config.json`
 * `trustedFolders[]`, which copilot honors with no prompt.
 *
 * Unlike agy (two gemini-family stores), Copilot uses a SINGLE store. The catch
 * is that `config.json` is JSONC — copilot writes a two-line `//` comment header
 * ("managed automatically") above the JSON object, and owns the rest of the keys
 * (`firstLaunchAt`, `loggedInUsers[]`, `lastLoggedInUser`, …). So this service:
 *  - strips ONLY leading `//` comment lines before parsing (a naive line filter
 *    would corrupt `"host": "https://github.com"` style values), and preserves
 *    that header verbatim on write;
 *  - preserves every sibling key (read-modify-write, never clobber);
 *  - writes atomically (tmp + rename, mode 0600) and serializes writes via a
 *    write-tail so concurrent provisioning never interleaves;
 *  - NEVER overwrites a malformed file (surfaced as a warning, no data loss);
 *  - is idempotent (add-if-absent), and re-reads after writing to confirm our
 *    entry survived copilot's own "managed automatically" writer (retry once).
 */
@Injectable()
export class CopilotTrustedFoldersService {
  private writeTail: Promise<unknown> = Promise.resolve();

  private get configPath(): string {
    return join(homedir(), '.copilot', 'config.json');
  }

  /**
   * Ensure `projectPath` is in copilot's `trustedFolders[]`. Serialized via a
   * write-tail so concurrent provisioning calls never interleave file writes.
   */
  ensure(projectPath: string): Promise<EnsureCopilotTrustResult> {
    const op = this.writeTail.catch(() => undefined).then(() => this.doEnsure(projectPath));
    this.writeTail = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  private async doEnsure(projectPath: string): Promise<EnsureCopilotTrustResult> {
    const normalizedPath = await this.normalizePath(projectPath);
    const warnings: CopilotTrustWarning[] = [];
    const filePath = this.configPath;

    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    } catch (err) {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `Failed to create directory ${dirname(filePath)}: ${String(err)}`,
        code: 'COPILOT_TRUST_DIR_FAILED',
      });
      return { success: false, warnings };
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No config yet — copilot will reconcile its other keys on next launch.
        raw = '{}';
      } else {
        warnings.push({
          source: 'trusted_folders',
          level: 'warn',
          message: `Failed to read ${filePath}: ${String(err)}`,
          code: 'COPILOT_TRUST_READ_FAILED',
        });
        return { success: false, warnings };
      }
    }

    const split = this.splitJsonc(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(split.body);
    } catch {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `${filePath} contains invalid JSON — refusing to modify`,
        code: 'COPILOT_CONFIG_MALFORMED',
      });
      return { success: false, warnings };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `${filePath} root is not a JSON object — refusing to modify`,
        code: 'COPILOT_CONFIG_MALFORMED',
      });
      return { success: false, warnings };
    }

    const config = parsed as Record<string, unknown>;
    const existing = config.trustedFolders;

    if (existing !== undefined && !Array.isArray(existing)) {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `${filePath} "trustedFolders" is not an array — refusing to modify`,
        code: 'COPILOT_TRUSTED_FOLDERS_MALFORMED',
      });
      return { success: false, warnings };
    }

    // Preserve any non-string entries verbatim (no data loss); dedupe by value.
    const list: unknown[] = Array.isArray(existing) ? [...existing] : [];
    if (list.includes(normalizedPath)) {
      return { success: true, warnings };
    }

    list.push(normalizedPath);
    const merged = { ...config, trustedFolders: list };
    const content = this.serialize(split.header, merged);

    try {
      await this.atomicWrite(filePath, content);
    } catch (err) {
      warnings.push({
        source: 'trusted_folders',
        level: 'warn',
        message: `Failed to write ${filePath}: ${String(err)}`,
        code: 'COPILOT_TRUST_WRITE_FAILED',
      });
      return { success: false, warnings };
    }

    // Re-read to confirm our entry survived copilot's own "managed automatically"
    // writer (the lost-update window is small — copilot appends, never prunes —
    // but real). Retry the add-and-write exactly once if it vanished.
    if (!(await this.entryPresent(filePath, normalizedPath))) {
      logger.warn(
        { projectPath: normalizedPath },
        'Copilot trustedFolders entry missing after write — retrying once',
      );
      const retry = await this.retryAdd(filePath, normalizedPath);
      if (!retry.ok) {
        warnings.push({
          source: 'trusted_folders',
          level: 'warn',
          message: `Copilot trustedFolders entry for ${normalizedPath} did not persist (concurrent writer?)`,
          code: 'COPILOT_TRUST_LOST_UPDATE',
        });
        return { success: false, warnings };
      }
    }

    logger.info({ projectPath: normalizedPath }, 'Added copilot trustedFolders entry');
    return { success: true, warnings };
  }

  /**
   * Re-add the path and rewrite once. Returns ok=false on any read/parse/write
   * problem or if the entry still does not persist (caller surfaces a warning).
   */
  private async retryAdd(filePath: string, normalizedPath: string): Promise<{ ok: boolean }> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      return { ok: false };
    }

    const split = this.splitJsonc(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(split.body);
    } catch {
      return { ok: false };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }

    const config = parsed as Record<string, unknown>;
    const existing = config.trustedFolders;
    if (existing !== undefined && !Array.isArray(existing)) {
      return { ok: false };
    }
    const list: unknown[] = Array.isArray(existing) ? [...existing] : [];
    if (!list.includes(normalizedPath)) {
      list.push(normalizedPath);
    }
    const merged = { ...config, trustedFolders: list };

    try {
      await this.atomicWrite(filePath, this.serialize(split.header, merged));
    } catch {
      return { ok: false };
    }
    return { ok: await this.entryPresent(filePath, normalizedPath) };
  }

  private async entryPresent(filePath: string, normalizedPath: string): Promise<boolean> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(this.splitJsonc(raw).body) as Record<string, unknown>;
      const list = parsed?.trustedFolders;
      return Array.isArray(list) && list.includes(normalizedPath);
    } catch {
      return false;
    }
  }

  /**
   * Split a JSONC document into its leading comment/blank header and the JSON
   * body. Only lines BEFORE the JSON body whose first non-whitespace characters
   * are `//` (or which are blank) are treated as header — this never touches a
   * `"host": "https://…"` value, which does not start with `//`.
   */
  private splitJsonc(raw: string): { header: string; body: string } {
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (trimmed === '' || trimmed.startsWith('//')) {
        i++;
        continue;
      }
      break;
    }
    if (i === 0) {
      return { header: '', body: raw };
    }
    return { header: lines.slice(0, i).join('\n'), body: lines.slice(i).join('\n') };
  }

  /** Re-emit the preserved JSONC header (if any) above the pretty-printed JSON. */
  private serialize(header: string, value: unknown): string {
    const json = JSON.stringify(value, null, 2) + '\n';
    return header ? `${header}\n${json}` : json;
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
