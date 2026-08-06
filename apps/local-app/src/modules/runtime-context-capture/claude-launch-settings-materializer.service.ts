import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { constants, rmSync } from 'fs';
import { access, chmod, link, mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { validateClaudeLaunchSettingsJson } from '@devchain/shared';
import { ConflictError, IOError, ValidationError } from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { hasFlagOccurrence } from '../sessions/utils/profile-options';
import {
  getRuntimeContextCaptureRoot,
  getRuntimeContextEndpointPath,
} from './runtime-context-capture-files';

const logger = createLogger('ClaudeLaunchSettingsMaterializer');

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SCRIPT_FILE_MODE = 0o755;
const SETTINGS_FLAG = '--settings';
const STATUS_LINE_LOCATOR_ENV = 'DEVCHAIN_STATUSLINE_LOCATOR';

export const CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND =
  '"${CLAUDE_PROJECT_DIR}/.claude/hooks/devchain-statusline.sh"';

export const CLAUDE_LAUNCH_SETTINGS_ROOT = Symbol('CLAUDE_LAUNCH_SETTINGS_ROOT');

export interface PrepareClaudeLaunchSettingsInput {
  providerName: string;
  settingsJson: string | null;
  profileOptionArgs: string[];
  providerEnv: Record<string, string> | null;
  configEnv: Record<string, string> | null;
  sessionId: string;
  epoch: string;
  projectRootPath: string;
  pluginPolicy?: ReadonlyArray<ClaudePluginPolicyEntry>;
  policyRequired?: boolean;
}

export interface ClaudePluginPolicyEntry {
  pluginId: string;
  enabled: boolean;
}

export interface PreparedClaudeLaunchSettings {
  optionArgs: string[];
  runtimeEnv: Record<string, string>;
  captureEnabled: boolean;
}

const INACTIVE_RESULT: PreparedClaudeLaunchSettings = {
  optionArgs: [],
  runtimeEnv: {},
  captureEnabled: false,
};

const STATUS_LINE_NODE_SOURCE = String.raw`
const fs = require("fs");
let input = "";
let lockPath = null;
let cleaned = false;

function cleanup() {
  if (cleaned || !lockPath) return;
  cleaned = true;
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
}

function acquire(path) {
  try {
    fs.mkdirSync(path, { mode: 448 });
    return true;
  } catch (error) {
    if (!error || error.code !== "EEXIST") return false;
  }
  try {
    const ageMs = Date.now() - fs.statSync(path).mtimeMs;
    if (ageMs <= 15000) return false;
    fs.rmSync(path, { recursive: true, force: true });
    fs.mkdirSync(path, { mode: 448 });
    return true;
  } catch {
    return false;
  }
}

function writeCounter(path, value) {
  const temp = path + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(temp, String(value), { encoding: "utf8", mode: 384, flag: "wx" });
    fs.renameSync(temp, path);
    fs.chmodSync(path, 384);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

async function run() {
  const locatorPath = process.env.DEVCHAIN_STATUSLINE_LOCATOR;
  if (!locatorPath) return;

  let locator;
  let statusLine;
  try {
    locator = JSON.parse(fs.readFileSync(locatorPath, "utf8"));
    statusLine = JSON.parse(input);
  } catch {
    return;
  }

  const claudeSessionId = statusLine && statusLine.session_id;
  const modelId = statusLine && statusLine.model && statusLine.model.id;
  const contextWindowTokens =
    statusLine && statusLine.context_window && statusLine.context_window.context_window_size;
  if (
    typeof locator.sessionId !== "string" ||
    typeof locator.epoch !== "string" ||
    typeof locator.counterPath !== "string" ||
    typeof locator.lockPath !== "string" ||
    typeof locator.endpointPath !== "string" ||
    typeof claudeSessionId !== "string" ||
    claudeSessionId.length === 0 ||
    typeof modelId !== "string" ||
    modelId.length === 0 ||
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= 0 ||
    contextWindowTokens > 10000000
  ) {
    return;
  }

  lockPath = locator.lockPath;
  if (!acquire(lockPath)) return;
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("exit", cleanup);

  try {
    let previous = 0;
    try {
      previous = Number(fs.readFileSync(locator.counterPath, "utf8"));
      if (!Number.isSafeInteger(previous) || previous < 0) previous = 0;
    } catch {}
    const sequence = previous + 1;
    writeCounter(locator.counterPath, sequence);

    let endpoint;
    try {
      endpoint = JSON.parse(fs.readFileSync(locator.endpointPath, "utf8"));
    } catch {
      return;
    }
    if (!endpoint || typeof endpoint.apiUrl !== "string") return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(new URL("/api/hooks/events", endpoint.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hookEventName: "StatusLine",
          sessionId: locator.sessionId,
          epoch: locator.epoch,
          sequence,
          claudeSessionId,
          modelId,
          contextWindowTokens
        }),
        signal: controller.signal
      });
    } catch {
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    cleanup();
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => { run().catch(() => {}).finally(() => process.exit(0)); });
process.stdin.resume();
`.trim();

export const DEVCHAIN_STATUS_LINE_SCRIPT = [
  '#!/bin/sh',
  'child_pid=""',
  'forward_signal() {',
  '  if [ -n "$child_pid" ]; then',
  '    kill -TERM "$child_pid" >/dev/null 2>&1 || true',
  '    wait "$child_pid" >/dev/null 2>&1 || true',
  '  fi',
  '  exit 0',
  '}',
  'trap forward_signal INT TERM HUP',
  'exec 3<&0',
  `node -e '${STATUS_LINE_NODE_SOURCE}' <&3 >/dev/null 2>&1 &`,
  'child_pid=$!',
  'exec 3<&-',
  'wait "$child_pid" >/dev/null 2>&1 || true',
  'exit 0',
  '',
].join('\n');

@Injectable()
export class ClaudeLaunchSettingsMaterializerService {
  private readonly rootPath: string;

  constructor(
    @Optional()
    @Inject(CLAUDE_LAUNCH_SETTINGS_ROOT)
    rootPath?: string,
  ) {
    this.rootPath = rootPath ?? getRuntimeContextCaptureRoot();
  }

  async prepare(input: PrepareClaudeLaunchSettingsInput): Promise<PreparedClaudeLaunchSettings> {
    const prepared = this.prepareSettings(input);
    if (!prepared) return INACTIVE_RESULT;

    let settingsPath: string;
    try {
      settingsPath = await this.materializeSettingsRevision(prepared.settingsJson);
    } catch {
      await this.cleanupSession(input.sessionId);
      if (prepared.policyRequired) {
        throw new IOError('Failed to materialize required Claude plugin policy settings.', {
          stage: 'settings_revision',
        });
      }
      this.logFailOpen(input.sessionId);
      return INACTIVE_RESULT;
    }

    const settingsOnlyResult: PreparedClaudeLaunchSettings = {
      optionArgs: [SETTINGS_FLAG, settingsPath],
      runtimeEnv: {},
      captureEnabled: false,
    };
    if (!this.hasCanonicalStatusLine(prepared.parsed)) {
      return settingsOnlyResult;
    }

    try {
      await this.materializeStatusLineScript(input.projectRootPath);
      const locatorPath = await this.materializeSessionLocator(input.sessionId, input.epoch);
      return {
        optionArgs: [SETTINGS_FLAG, settingsPath],
        runtimeEnv: { [STATUS_LINE_LOCATOR_ENV]: locatorPath },
        captureEnabled: true,
      };
    } catch {
      await this.cleanupSession(input.sessionId);
      if (prepared.policyRequired) {
        logger.warn(
          { sessionId: input.sessionId },
          'Claude status capture materialization failed; required plugin policy remains active',
        );
        return settingsOnlyResult;
      }
      this.logFailOpen(input.sessionId);
      return INACTIVE_RESULT;
    }
  }

  private logFailOpen(sessionId: string): void {
    logger.warn(
      { sessionId },
      'Claude launch settings materialization failed; launching without provider settings',
    );
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const paths = this.getSessionPaths(sessionId);
    await Promise.all([
      rm(paths.locatorPath, { force: true }),
      rm(paths.counterPath, { force: true }),
      rm(paths.lockPath, { recursive: true, force: true }),
    ]).catch(() => undefined);
  }

  cleanupSessionSync(sessionId: string): void {
    const paths = this.getSessionPaths(sessionId);
    for (const [path, recursive] of [
      [paths.locatorPath, false],
      [paths.counterPath, false],
      [paths.lockPath, true],
    ] as const) {
      try {
        rmSync(path, { recursive, force: true });
      } catch {
        // Lifecycle cleanup is best-effort; stale private artifacts are harmless.
      }
    }
  }

  private prepareSettings(input: PrepareClaudeLaunchSettingsInput): {
    settingsJson: string;
    parsed: Record<string, unknown>;
    policyRequired: boolean;
  } | null {
    const pluginPolicy = input.pluginPolicy ?? [];
    const policyRequired = input.policyRequired === true || pluginPolicy.length > 0;

    if (input.providerName.toLowerCase() !== 'claude') {
      if (policyRequired) {
        throw new ValidationError(
          'Required Claude plugin policy cannot target a non-Claude provider.',
        );
      }
      return null;
    }
    if (hasFlagOccurrence(input.profileOptionArgs, SETTINGS_FLAG)) {
      if (policyRequired) {
        throw new ConflictError(
          'Profile-supplied --settings conflicts with required DevChain Claude plugin policy.',
          { field: 'profileOptions', flag: SETTINGS_FLAG },
        );
      }
      return null;
    }

    const effectiveBaseUrl =
      input.configEnv?.ANTHROPIC_BASE_URL ?? input.providerEnv?.ANTHROPIC_BASE_URL;
    const usesAlternateBase =
      typeof effectiveBaseUrl === 'string' && effectiveBaseUrl.trim().length > 0;

    if (!policyRequired) {
      if (usesAlternateBase) return null;

      const validation = validateClaudeLaunchSettingsJson(input.settingsJson);
      if (!validation.valid || validation.parsed === null) return null;
      return {
        settingsJson: input.settingsJson as string,
        parsed: validation.parsed,
        policyRequired: false,
      };
    }

    let base: Record<string, unknown> = {};
    if (!usesAlternateBase && input.settingsJson !== null) {
      const baseValidation = validateClaudeLaunchSettingsJson(input.settingsJson);
      if (!baseValidation.valid) {
        throw this.toPolicyValidationError(baseValidation);
      }
      if (baseValidation.parsed === null) {
        throw new ValidationError('Required Claude plugin policy settings have no merge base.', {
          field: 'pluginPolicy',
        });
      }
      base = baseValidation.parsed;
    }

    const existingEnabledPlugins = base.enabledPlugins as Record<string, boolean> | undefined;
    const enabledPlugins = Object.assign(
      Object.create(null) as Record<string, boolean>,
      existingEnabledPlugins ?? {},
    );
    for (const entry of pluginPolicy) {
      if (typeof entry.pluginId !== 'string' || typeof entry.enabled !== 'boolean') {
        throw new ValidationError('Resolved Claude plugin policy entries are invalid.', {
          field: 'pluginPolicy',
        });
      }
      enabledPlugins[entry.pluginId] = entry.enabled;
    }

    const settingsJson = JSON.stringify({ ...base, enabledPlugins }, null, 2);
    const finalValidation = validateClaudeLaunchSettingsJson(settingsJson);
    if (!finalValidation.valid) {
      throw this.toPolicyValidationError(finalValidation);
    }
    if (finalValidation.parsed === null) {
      throw new ValidationError('Required Claude plugin policy settings did not compose.', {
        field: 'pluginPolicy',
      });
    }
    return {
      settingsJson,
      parsed: finalValidation.parsed,
      policyRequired: true,
    };
  }

  private toPolicyValidationError(
    validation: Exclude<ReturnType<typeof validateClaudeLaunchSettingsJson>, { valid: true }>,
  ): ValidationError {
    return new ValidationError(
      `Required Claude plugin policy settings are invalid: ${validation.message}`,
      {
        field: 'pluginPolicy',
        ...(validation.path ? { path: validation.path } : {}),
      },
    );
  }

  private hasCanonicalStatusLine(parsed: Record<string, unknown>): boolean {
    const statusLine = parsed.statusLine;
    if (statusLine === null || typeof statusLine !== 'object' || Array.isArray(statusLine)) {
      return false;
    }
    const entry = statusLine as Record<string, unknown>;
    return entry.type === 'command' && entry.command === CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND;
  }

  private async materializeSettingsRevision(settingsJson: string): Promise<string> {
    const revisionsPath = join(this.rootPath, 'settings-revisions');
    await this.ensurePrivateDirectory(this.rootPath);
    await this.ensurePrivateDirectory(revisionsPath);

    const digest = createHash('sha256').update(settingsJson, 'utf8').digest('hex');
    const revisionPath = join(revisionsPath, `${digest}.json`);
    try {
      await access(revisionPath, constants.F_OK);
      const existing = await readFile(revisionPath, 'utf8');
      if (existing !== settingsJson) throw new Error('Settings revision hash collision');
      await chmod(revisionPath, PRIVATE_FILE_MODE);
      return revisionPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const tempPath = `${revisionPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, settingsJson, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
        flag: 'wx',
      });
      await link(tempPath, revisionPath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        const existing = await readFile(revisionPath, 'utf8');
        if (existing !== settingsJson) throw error;
      });
      await chmod(revisionPath, PRIVATE_FILE_MODE);
      return revisionPath;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async materializeStatusLineScript(projectRootPath: string): Promise<void> {
    const hooksPath = join(projectRootPath, '.claude', 'hooks');
    await mkdir(hooksPath, { recursive: true });
    const scriptPath = join(hooksPath, 'devchain-statusline.sh');
    const tempPath = `${scriptPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, DEVCHAIN_STATUS_LINE_SCRIPT, {
        encoding: 'utf8',
        mode: SCRIPT_FILE_MODE,
        flag: 'wx',
      });
      await rename(tempPath, scriptPath);
      await chmod(scriptPath, SCRIPT_FILE_MODE);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async materializeSessionLocator(sessionId: string, epoch: string): Promise<string> {
    const sessionsPath = join(this.rootPath, 'sessions');
    await this.ensurePrivateDirectory(this.rootPath);
    await this.ensurePrivateDirectory(sessionsPath);
    const paths = this.getSessionPaths(sessionId);
    const locator = {
      sessionId,
      epoch,
      counterPath: paths.counterPath,
      lockPath: paths.lockPath,
      endpointPath: getRuntimeContextEndpointPath(this.rootPath),
    };
    const tempPath = `${paths.locatorPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tempPath, JSON.stringify(locator), {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
        flag: 'wx',
      });
      await rename(tempPath, paths.locatorPath);
      await chmod(paths.locatorPath, PRIVATE_FILE_MODE);
      return paths.locatorPath;
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }

  private getSessionPaths(sessionId: string): {
    locatorPath: string;
    counterPath: string;
    lockPath: string;
  } {
    const key = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const sessionsPath = join(this.rootPath, 'sessions');
    return {
      locatorPath: join(sessionsPath, `${key}.json`),
      counterPath: join(sessionsPath, `${key}.sequence`),
      lockPath: join(sessionsPath, `${key}.lock`),
    };
  }
}
