import { readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_CONFIG_FILENAME = '.claude.json';
const DEFAULT_CLAUDE_CONFIG_MODE = 0o600;

export interface ClaudeAutoCompactStatus {
  autoCompactEnabled: boolean;
}

export interface DisableClaudeAutoCompactResult {
  success: boolean;
  error?: string;
  errorType?: 'invalid_config' | 'io_error';
}

function getClaudeConfigPath(): string {
  return join(homedir(), CLAUDE_CONFIG_FILENAME);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

export async function checkClaudeAutoCompact(): Promise<ClaudeAutoCompactStatus> {
  const configPath = getClaudeConfigPath();

  try {
    const configRaw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(configRaw) as unknown;

    if (!isObjectRecord(parsed)) {
      return { autoCompactEnabled: false };
    }

    return { autoCompactEnabled: parsed.autoCompactEnabled === true };
  } catch {
    return { autoCompactEnabled: false };
  }
}

export async function disableClaudeAutoCompact(): Promise<DisableClaudeAutoCompactResult> {
  const configPath = getClaudeConfigPath();
  let parsed: unknown = {};
  let hadExistingConfig = true;

  try {
    const configRaw = await readFile(configPath, 'utf-8');
    parsed = JSON.parse(configRaw) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      hadExistingConfig = false;
      parsed = {};
    } else if (isJsonParseError(error)) {
      return {
        success: false,
        error: getErrorMessage(error),
        errorType: 'invalid_config',
      };
    } else {
      return {
        success: false,
        error: getErrorMessage(error),
        errorType: 'io_error',
      };
    }
  }

  if (!isObjectRecord(parsed)) {
    return {
      success: false,
      error: 'Invalid Claude config: expected top-level JSON object',
      errorType: 'invalid_config',
    };
  }

  let targetMode = DEFAULT_CLAUDE_CONFIG_MODE;
  if (hadExistingConfig) {
    try {
      const existingStat = await stat(configPath);
      targetMode = existingStat.mode & 0o777;
    } catch (error) {
      if (!isMissingFileError(error)) {
        return {
          success: false,
          error: getErrorMessage(error),
          errorType: 'io_error',
        };
      }
    }
  }

  const updatedConfig: Record<string, unknown> = {
    ...parsed,
    autoCompactEnabled: false,
  };
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  const output = `${JSON.stringify(updatedConfig, null, 2)}\n`;

  try {
    await writeFile(tempPath, output, { encoding: 'utf-8', mode: targetMode });
    await rename(tempPath, configPath);
    return { success: true };
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors and return the original failure.
    }

    return {
      success: false,
      error: getErrorMessage(error),
      errorType: 'io_error',
    };
  }
}
