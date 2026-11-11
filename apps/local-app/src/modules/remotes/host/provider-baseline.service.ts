import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { mkdir, readFile } from 'fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLAUDE_JSON_BASELINE,
  CLAUDE_SETTINGS_BASELINE,
  DEVIN_CONFIG_BASELINE,
} from '../../../common/config/provider-baseline';
import { parseJsonc, setJsoncValue } from '../../../common/jsonc';
import { createLogger } from '../../../common/logging/logger';
import { ensureClaudeConfigKeys, writeConfigAtomically } from '../../providers/utils/claude-config';
import { HostHelperService } from './host-helper.service';

const logger = createLogger('ProviderBaselineService');
const SETTINGS_FILE_MODE = 0o600;
const SETTINGS_DIRECTORY_MODE = 0o700;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

type BaselineObject = Readonly<Record<string, unknown>>;

/** True when every baseline leaf is already in `current`, at any depth. */
export function containsBaseline(
  current: Record<string, unknown>,
  baseline: BaselineObject,
): boolean {
  return Object.entries(baseline).every(([key, wanted]) =>
    isObjectRecord(wanted)
      ? isObjectRecord(current[key]) && containsBaseline(current[key], wanted)
      : current[key] === wanted,
  );
}

/** Every leaf of `baseline` as a key path and its value. */
function baselineLeaves(
  baseline: BaselineObject,
  path: string[] = [],
): Array<{ path: string[]; value: unknown }> {
  return Object.entries(baseline).flatMap(([key, wanted]) =>
    isObjectRecord(wanted)
      ? baselineLeaves(wanted, [...path, key])
      : [{ path: [...path, key], value: wanted }],
  );
}

/** Devin's own path rule: `$XDG_CONFIG_HOME/devin/config.json`, else `~/.config/devin/config.json`. */
export function getDevinUserConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'devin', 'config.json');
}

type BaselineMerge = { ok: true; value: Record<string, unknown> } | { ok: false; key: string };

/**
 * Baseline leaves win; every other key survives, also inside nested baseline
 * objects. A nested baseline object that meets a non-object value is a
 * conflict, reported by its key path, and nothing is merged.
 */
export function mergeBaseline(
  current: Record<string, unknown>,
  baseline: BaselineObject,
  path = '',
): BaselineMerge {
  const value: Record<string, unknown> = { ...current };
  for (const [key, wanted] of Object.entries(baseline)) {
    if (!isObjectRecord(wanted)) {
      value[key] = wanted;
      continue;
    }
    const existing = current[key];
    if (existing !== undefined && !isObjectRecord(existing)) {
      return { ok: false, key: `${path}${key}` };
    }
    const nested = mergeBaseline(existing ?? {}, wanted, `${path}${key}.`);
    if (!nested.ok) return nested;
    value[key] = nested.value;
  }
  return { ok: true, value };
}

@Injectable()
export class ProviderBaselineService implements OnApplicationBootstrap {
  constructor(private readonly hostHelper: HostHelperService) {}

  async onApplicationBootstrap(): Promise<void> {
    let isClaimedHost: boolean;
    try {
      isClaimedHost = this.hostHelper.isClaimedHost();
    } catch (error) {
      logger.warn({ error }, 'Could not determine whether this instance is a claimed host');
      return;
    }
    if (!isClaimedHost) return;

    try {
      const result = await ensureClaudeConfigKeys(CLAUDE_JSON_BASELINE);
      if (!result.success) {
        logger.warn(
          { errorType: result.errorType, error: result.error },
          'Could not apply the Claude config baseline',
        );
      }
    } catch (error) {
      logger.warn({ error }, 'Could not apply the Claude config baseline');
    }

    try {
      await this.applySettingsBaseline();
    } catch (error) {
      logger.warn({ error }, 'Could not apply the Claude settings baseline');
    }

    try {
      await this.applyDevinConfigBaseline();
    } catch (error) {
      logger.warn({ error }, 'Could not apply the Devin config baseline');
    }
  }

  /**
   * Devin rewrites this file itself and accepts comments in it, so the baseline
   * edits only its own leaves in the text instead of re-serializing the file.
   */
  private async applyDevinConfigBaseline(): Promise<void> {
    const configPath = getDevinUserConfigPath();
    await mkdir(dirname(configPath), { recursive: true, mode: SETTINGS_DIRECTORY_MODE });

    let text = '{}\n';
    try {
      text = await readFile(configPath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = parseJsonc(text);
      } catch {
        logger.warn(
          { path: configPath },
          'Devin config is not valid JSON with comments; leaving unchanged',
        );
        return;
      }
      if (!isObjectRecord(parsed)) {
        logger.warn({ path: configPath }, 'Devin config is not a JSON object; leaving unchanged');
        return;
      }
      if (containsBaseline(parsed, DEVIN_CONFIG_BASELINE)) return;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    for (const leaf of baselineLeaves(DEVIN_CONFIG_BASELINE)) {
      text = setJsoncValue(text, leaf.path, leaf.value);
    }
    await writeConfigAtomically(configPath, text, SETTINGS_FILE_MODE);
  }

  private async applySettingsBaseline(): Promise<void> {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    await mkdir(dirname(settingsPath), { recursive: true, mode: SETTINGS_DIRECTORY_MODE });

    let current: Record<string, unknown> | null = null;
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn(
          { path: settingsPath },
          'Claude settings contain invalid JSON; leaving unchanged',
        );
        return;
      }
      if (!isObjectRecord(parsed)) {
        logger.warn(
          { path: settingsPath },
          'Claude settings are not a JSON object; leaving unchanged',
        );
        return;
      }
      current = parsed;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    if (current && containsBaseline(current, CLAUDE_SETTINGS_BASELINE)) return;

    const merged = mergeBaseline(current ?? {}, CLAUDE_SETTINGS_BASELINE);
    if (!merged.ok) {
      logger.warn(
        { path: settingsPath, key: merged.key },
        `Claude settings ${merged.key} is not an object; leaving unchanged`,
      );
      return;
    }
    await writeConfigAtomically(
      settingsPath,
      `${JSON.stringify(merged.value, null, 2)}\n`,
      SETTINGS_FILE_MODE,
    );
  }
}
