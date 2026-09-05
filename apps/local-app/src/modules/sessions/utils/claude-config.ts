import { randomBytes } from 'crypto';
import { readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { lock, type LockOptions } from 'proper-lockfile';

const CLAUDE_CONFIG_FILENAME = '.claude.json';
const DEFAULT_CLAUDE_CONFIG_MODE = 0o600;
const INVALID_CLAUDE_CONFIG_JSON_MESSAGE = 'Invalid Claude config: malformed JSON';

// Claude Code (2.1.257) serializes ~/.claude.json mutations through
// proper-lockfile with a 10s stale window and a 5s mtime refresh, creating its
// lock directory at ~/.claude.json.lock. These values must stay identical to
// Claude's so both writers mutually exclude through the same protocol.
const CLAUDE_LOCK_STALE_MS = 10_000;
const CLAUDE_LOCK_UPDATE_MS = 5_000;
// Acquisition gives up after twelve 1s-spaced retries (~12s of waiting) instead
// of queueing forever behind a stuck holder.
const CLAUDE_LOCK_RETRIES: NonNullable<LockOptions['retries']> = {
  retries: 12,
  factor: 1,
  minTimeout: 1_000,
  maxTimeout: 1_000,
};

export type ClaudeConfigState = 'valid' | 'missing' | 'malformed';

export interface ClaudeAutoCompactStatus {
  autoCompactEnabled: boolean;
  configState: ClaudeConfigState;
}

export interface ClaudeConfigWriteResult {
  success: boolean;
  error?: string;
  errorType?: 'invalid_config' | 'io_error';
}

export type ClaudeAutoCompactWriteResult = ClaudeConfigWriteResult;

/** @deprecated Use ClaudeAutoCompactWriteResult instead */
export type DisableClaudeAutoCompactResult = ClaudeAutoCompactWriteResult;

export type ClaudeProjectTrustResult = ClaudeConfigWriteResult;

type ClaudeWriteFailure = {
  success: false;
  error: string;
  errorType: 'invalid_config' | 'io_error';
};
type ClaudeWriteOutcome = { success: true } | ClaudeWriteFailure;

/**
 * Serializes all in-process writers of ~/.claude.json. The proper-lockfile lock
 * covers other processes; this FIFO covers concurrent DevChain callers so they
 * queue instead of burning the bounded lock-wait budget against each other.
 */
let configMutationChain: Promise<unknown> = Promise.resolve();

function enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const chained = configMutationChain.then(operation, operation);
  configMutationChain = chained.then(
    () => undefined,
    () => undefined,
  );
  return chained;
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

function ioErrorResult(error: unknown): ClaudeWriteFailure {
  return { success: false, error: getErrorMessage(error), errorType: 'io_error' };
}

function invalidConfigResult(error: string): ClaudeWriteFailure {
  return { success: false, error, errorType: 'invalid_config' };
}

interface ClaudeConfigLock {
  release: () => Promise<void>;
  isCompromised: () => boolean;
}

async function acquireClaudeConfigLock(configPath: string): Promise<ClaudeConfigLock> {
  let compromised = false;
  const release = await lock(configPath, {
    // realpath:false lets the lock be taken while ~/.claude.json does not exist
    // yet; proper-lockfile still resolves the path itself, so the lock directory
    // lands exactly at ~/.claude.json.lock either way.
    realpath: false,
    stale: CLAUDE_LOCK_STALE_MS,
    update: CLAUDE_LOCK_UPDATE_MS,
    retries: CLAUDE_LOCK_RETRIES,
    // proper-lockfile's default onCompromised rethrows from inside an fs
    // callback, which surfaces as an uncaught async exception. Record the
    // compromise and fail the mutation with io_error instead.
    onCompromised: () => {
      compromised = true;
    },
  });
  return {
    release: () => release(),
    isCompromised: () => compromised,
  };
}

/**
 * Acquires the cross-process lock before any read, holds it through the
 * mutation and release, and never reports success when the lock's exclusivity
 * is unprovable (compromise or release failure).
 */
async function runLockedConfigMutation(
  configPath: string,
  operation: () => Promise<ClaudeWriteOutcome>,
): Promise<ClaudeWriteOutcome> {
  let held: ClaudeConfigLock;
  try {
    held = await acquireClaudeConfigLock(configPath);
  } catch (error) {
    return ioErrorResult(error);
  }

  let outcome: ClaudeWriteOutcome;
  let releaseError: unknown;
  try {
    outcome = await operation();
  } catch (error) {
    outcome = ioErrorResult(error);
  } finally {
    try {
      await held.release();
    } catch (error) {
      releaseError = error;
    }
  }

  if (held.isCompromised()) {
    return {
      success: false,
      error: 'Claude config lock was compromised while the configuration was being written',
      errorType: 'io_error',
    };
  }
  if (releaseError !== undefined) {
    return ioErrorResult(releaseError);
  }
  return outcome;
}

type ClaudeConfigRead = { parsed: Record<string, unknown> | null } | ClaudeWriteFailure;

async function readConfigForMutation(configPath: string): Promise<ClaudeConfigRead> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return { parsed: null };
    }
    return ioErrorResult(error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!isJsonParseError(error)) {
      return ioErrorResult(error);
    }
    // Node can include a slice of the malformed source in SyntaxError.message.
    // Never pass that text into provisioning results or startup logs because
    // ~/.claude.json can contain authentication data.
    return invalidConfigResult(INVALID_CLAUDE_CONFIG_JSON_MESSAGE);
  }

  if (!isObjectRecord(parsed)) {
    return invalidConfigResult('Invalid Claude config: expected top-level JSON object');
  }
  return { parsed };
}

async function resolveWriteMode(
  configPath: string,
  hadExistingConfig: boolean,
): Promise<number | ClaudeWriteFailure> {
  if (!hadExistingConfig) {
    return DEFAULT_CLAUDE_CONFIG_MODE;
  }
  try {
    return (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (isMissingFileError(error)) {
      return DEFAULT_CLAUDE_CONFIG_MODE;
    }
    return ioErrorResult(error);
  }
}

/**
 * Atomic write through Claude's recognized temporary-file shape. Claude removes
 * abandoned `<config>.tmp.<8 lowercase hex>` files on its own cleanup passes, so
 * a crash between write and rename must use exactly this form.
 */
async function writeConfigAtomically(
  configPath: string,
  output: string,
  mode: number,
): Promise<void> {
  const tempPath = `${configPath}.tmp.${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tempPath, output, { encoding: 'utf-8', mode });
    await rename(tempPath, configPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Cleanup is best-effort; surface the original failure.
    }
    throw error;
  }
}

export async function checkAutoCompactConfig(): Promise<ClaudeAutoCompactStatus> {
  const configPath = getClaudeConfigPath();

  try {
    const configRaw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(configRaw) as unknown;

    if (!isObjectRecord(parsed)) {
      return { autoCompactEnabled: false, configState: 'malformed' };
    }

    // Claude Code enables auto-compact by default — only an explicit `false` disables it.
    // A missing key means "use default" which is enabled.
    return { autoCompactEnabled: parsed.autoCompactEnabled !== false, configState: 'valid' };
  } catch (error) {
    if (isMissingFileError(error)) {
      // No config file — Claude Code uses defaults, which has auto-compact enabled.
      return { autoCompactEnabled: true, configState: 'missing' };
    }
    if (isJsonParseError(error)) {
      return { autoCompactEnabled: false, configState: 'malformed' };
    }
    // Other I/O errors: treat as malformed to avoid false recommendations
    return { autoCompactEnabled: false, configState: 'malformed' };
  }
}

async function writeAutoCompactUnderLock(
  configPath: string,
  enabled: boolean,
): Promise<ClaudeWriteOutcome> {
  const read = await readConfigForMutation(configPath);
  if (!('parsed' in read)) {
    return read;
  }

  const mode = await resolveWriteMode(configPath, read.parsed !== null);
  if (typeof mode !== 'number') {
    return mode;
  }

  const updatedConfig: Record<string, unknown> = {
    ...(read.parsed ?? {}),
    autoCompactEnabled: enabled,
  };

  try {
    await writeConfigAtomically(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, mode);
  } catch (error) {
    return ioErrorResult(error);
  }
  return { success: true };
}

async function mutateAutoCompactConfig(enabled: boolean): Promise<ClaudeWriteOutcome> {
  const configPath = getClaudeConfigPath();
  return runLockedConfigMutation(configPath, () => writeAutoCompactUnderLock(configPath, enabled));
}

export async function enableClaudeAutoCompact(): Promise<ClaudeAutoCompactWriteResult> {
  return enqueueConfigMutation(() => mutateAutoCompactConfig(true));
}

export async function disableClaudeAutoCompact(): Promise<ClaudeAutoCompactWriteResult> {
  return enqueueConfigMutation(() => mutateAutoCompactConfig(false));
}

/**
 * Trust only the exact registered root, plus — when the filesystem resolves it
 * to a different physical directory (symlinked or linked worktree roots) — its
 * realpath identity, so Claude honors trust under either spelling. Parent and
 * child directories are never trusted.
 */
async function resolveTrustIdentities(projectPath: string): Promise<string[]> {
  const registeredPath = resolve(projectPath);
  let physicalPath: string;
  try {
    physicalPath = await realpath(registeredPath);
  } catch {
    return [registeredPath];
  }
  if (physicalPath === registeredPath) {
    return [registeredPath];
  }
  return [registeredPath, physicalPath];
}

function validateProjectsShape(parsed: Record<string, unknown>): ClaudeWriteFailure | null {
  const projects = parsed.projects;
  if (projects === undefined) {
    return null;
  }
  if (!isObjectRecord(projects)) {
    return invalidConfigResult('Invalid Claude config: expected "projects" to be an object');
  }
  // Every existing record must be an object, including records unrelated to the
  // project being trusted; rewriting the map would otherwise normalize away a
  // shape the config owner did not produce.
  for (const record of Object.values(projects)) {
    if (!isObjectRecord(record)) {
      return invalidConfigResult(
        'Invalid Claude config: expected "projects" entries to be objects',
      );
    }
  }
  return null;
}

function applyProjectTrust(
  parsed: Record<string, unknown>,
  identities: string[],
): { config: Record<string, unknown>; changed: boolean } {
  const projects: Record<string, unknown> = isObjectRecord(parsed.projects)
    ? { ...parsed.projects }
    : {};
  let changed = false;
  for (const identity of identities) {
    const record = projects[identity];
    const projectConfig = isObjectRecord(record) ? record : {};
    if (projectConfig.hasTrustDialogAccepted === true) {
      continue;
    }
    projects[identity] = {
      ...projectConfig,
      hasTrustDialogAccepted: true,
    };
    changed = true;
  }
  if (!changed) {
    return { config: parsed, changed };
  }
  return { config: { ...parsed, projects }, changed };
}

async function isProjectTrustedInConfig(
  configPath: string,
  identities: string[],
): Promise<boolean> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const projects = isObjectRecord(parsed) ? parsed.projects : undefined;
    if (!isObjectRecord(projects)) {
      return false;
    }
    return identities.every((identity) => {
      const record = projects[identity];
      return isObjectRecord(record) && record.hasTrustDialogAccepted === true;
    });
  } catch {
    return false;
  }
}

async function attemptProjectTrustWrite(
  configPath: string,
  identities: string[],
): Promise<'written' | 'skipped' | ClaudeWriteFailure> {
  const read = await readConfigForMutation(configPath);
  if (!('parsed' in read)) {
    return read;
  }

  if (read.parsed !== null) {
    const shapeFailure = validateProjectsShape(read.parsed);
    if (shapeFailure) {
      return shapeFailure;
    }
  }

  const { config, changed } = applyProjectTrust(read.parsed ?? {}, identities);
  if (!changed) {
    return 'skipped';
  }

  const mode = await resolveWriteMode(configPath, read.parsed !== null);
  if (typeof mode !== 'number') {
    return mode;
  }

  try {
    await writeConfigAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`, mode);
  } catch (error) {
    return ioErrorResult(error);
  }
  return 'written';
}

async function writeProjectTrustUnderLock(
  configPath: string,
  identities: string[],
): Promise<ClaudeWriteOutcome> {
  const firstAttempt = await attemptProjectTrustWrite(configPath, identities);
  if (firstAttempt !== 'written') {
    return firstAttempt === 'skipped' ? { success: true } : firstAttempt;
  }
  if (await isProjectTrustedInConfig(configPath, identities)) {
    return { success: true };
  }

  // Defense in depth: a writer that ignores the lock may have replaced the file
  // between our rename and the verification read. Re-merge once while still
  // holding the lock, then verify again.
  const retryAttempt = await attemptProjectTrustWrite(configPath, identities);
  if (retryAttempt !== 'written' && retryAttempt !== 'skipped') {
    return retryAttempt;
  }
  if (!(await isProjectTrustedInConfig(configPath, identities))) {
    return {
      success: false,
      error: 'Claude config trust verification failed after write',
      errorType: 'io_error',
    };
  }
  return { success: true };
}

async function mutateProjectTrust(projectPath: string): Promise<ClaudeWriteOutcome> {
  const identities = await resolveTrustIdentities(projectPath);
  const configPath = getClaudeConfigPath();
  return runLockedConfigMutation(configPath, () =>
    writeProjectTrustUnderLock(configPath, identities),
  );
}

/**
 * Record `projects[path].hasTrustDialogAccepted = true` for the registered
 * project root (and its realpath identity when they differ) in ~/.claude.json,
 * preserving every other configuration field. Malformed structures are never
 * overwritten; an already trusted project causes no write.
 */
export function ensureClaudeProjectTrusted(projectPath: string): Promise<ClaudeProjectTrustResult> {
  return enqueueConfigMutation(() => mutateProjectTrust(projectPath));
}
