import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';
import { IOError, TimeoutError, ValidationError } from '../../common/errors/error-types';
import { getRuntimeContextCaptureRoot } from './runtime-context-capture-files';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const EXECUTABLE_FILE_MODE = 0o700;
const MAX_PLUGIN_ID_LENGTH = 512;
const MAX_PROJECT_SLUG_LENGTH = 64;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,254}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const CODEX_PLUGIN_PROFILE_ROOT = Symbol('CODEX_PLUGIN_PROFILE_ROOT');

export interface CodexPluginPolicyEntry {
  pluginId: string;
  enabled: boolean;
}

export interface PrepareCodexPluginProfileInput {
  projectId: string;
  projectName: string;
  sessionId: string;
  pluginPolicy: ReadonlyArray<CodexPluginPolicyEntry>;
  attemptNonce: string;
}

export interface PreparedCodexPluginProfile {
  profileName: string;
  projectDigest: string;
  policyHash: string;
  sourceRevisionPath: string;
  helperPath: string;
  sessionId: string;
  attemptNonce: string;
  referencePath: string;
  locatorPath: string;
  acknowledgementPath: string;
  providerOptionArgs: string[];
}

interface CodexProfileAcknowledgement {
  version: 1;
  canonicalTargetPath: string;
  projectId: string;
  sessionId: string;
  projectDigest: string;
  profileName: string;
  policyHash: string;
  nonce: string;
}

interface CodexProfileLocator extends CodexProfileAcknowledgement {
  referencePath: string;
  acknowledgementPath: string;
  markerPath: string;
  lockKey: string;
}

const CODEX_PROFILE_HELPER_SOURCE = String.raw`#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,254}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

function fail(code) {
  process.stderr.write("DEVCHAIN_CODEX_PROFILE_ERROR:" + code + "\n");
  process.exit(78);
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) fail("invalid_arguments");
  const control = argv.slice(0, separator);
  const codexArgs = argv.slice(separator + 1);
  const values = Object.create(null);
  for (let index = 0; index < control.length; index += 2) {
    const flag = control[index];
    const value = control[index + 1];
    if (!flag || !flag.startsWith("--") || value === undefined || values[flag] !== undefined) {
      fail("invalid_arguments");
    }
    values[flag] = value;
  }
  const required = [
    "--source",
    "--profile",
    "--project-id",
    "--session-id",
    "--project-digest",
    "--policy-hash",
    "--reference",
    "--locator",
    "--ack",
    "--nonce",
    "--codex-bin"
  ];
  if (Object.keys(values).length !== required.length || required.some((flag) => !values[flag])) {
    fail("invalid_arguments");
  }
  return { values, codexArgs };
}

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_private_root");
  fs.chmodSync(directory, DIRECTORY_MODE);
}

function ensureCodexHome(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const resolved = fs.realpathSync(directory);
  if (!fs.statSync(resolved).isDirectory()) fail("invalid_codex_home");
  return resolved;
}

function containedRegularFile(candidate, directory, code) {
  const resolvedDirectory = fs.realpathSync(directory);
  const resolvedCandidate = fs.realpathSync(candidate);
  if (
    path.dirname(resolvedCandidate) !== resolvedDirectory ||
    !fs.lstatSync(resolvedCandidate).isFile() ||
    fs.lstatSync(candidate).isSymbolicLink()
  ) {
    fail(code);
  }
  return resolvedCandidate;
}

function containedDestination(candidate, directory, suffix, code) {
  const resolvedDirectory = fs.realpathSync(directory);
  const resolvedCandidate = path.resolve(candidate);
  if (
    path.dirname(resolvedCandidate) !== resolvedDirectory ||
    !path.basename(resolvedCandidate).endsWith(suffix)
  ) {
    fail(code);
  }
  return resolvedCandidate;
}

function writeExclusive(destination, content) {
  const temporary = destination + ".tmp-" + process.pid + "-" + crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", FILE_MODE);
    fs.writeFileSync(descriptor, content, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      fail("lifecycle_collision");
    }
    fs.chmodSync(destination, FILE_MODE);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function processStartIdentity(pid) {
  try {
    const value = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] || null;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ESRCH")) return false;
    return null;
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireTargetLock(locksRoot, canonicalTargetPath, attemptNonce) {
  const lockKey = sha256(canonicalTargetPath);
  const lockPath = path.join(locksRoot, lockKey + ".lock");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath, { mode: DIRECTORY_MODE });
      const startIdentity = processStartIdentity(process.pid);
      if (typeof startIdentity !== "string") fail("process_identity_unavailable");
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ version: 1, pid: process.pid, startIdentity, attemptNonce }),
        { encoding: "utf8", mode: FILE_MODE, flag: "wx" }
      );
      return {
        lockKey,
        release() {
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
        }
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") fail("lock_failure");
    }

    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    } catch {
      sleep(25);
      continue;
    }
    const actual = Number.isSafeInteger(owner.pid) ? processStartIdentity(owner.pid) : null;
    if (actual === false || (typeof actual === "string" && actual !== owner.startIdentity)) {
      const stalePath = lockPath + ".stale-" + process.pid + "-" + crypto.randomUUID();
      try {
        fs.renameSync(lockPath, stalePath);
        fs.rmSync(stalePath, { recursive: true, force: true });
        continue;
      } catch {
        sleep(25);
        continue;
      }
    }
    sleep(25);
  }
  fail("lock_timeout");
}

function writeOrValidateMarker(markerPath, marker) {
  try {
    const metadata = fs.lstatSync(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("unsafe_target_marker");
    const existing = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (
      existing.canonicalTargetPath !== marker.canonicalTargetPath ||
      existing.profileName !== marker.profileName ||
      existing.policyHash !== marker.policyHash
    ) {
      fail("target_marker_mismatch");
    }
    return;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  writeExclusive(markerPath, JSON.stringify(marker));
}

function materializeProfile(destination, content) {
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("unsafe_profile_target");
    if (fs.readFileSync(destination, "utf8") !== content) fail("profile_content_mismatch");
    fs.chmodSync(destination, FILE_MODE);
    return;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  const temporary = destination + ".tmp-" + process.pid + "-" + crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", FILE_MODE);
    fs.writeFileSync(descriptor, content, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const stat = fs.lstatSync(destination);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        fs.readFileSync(destination, "utf8") !== content
      ) {
        fail("profile_content_mismatch");
      }
    }
    fs.chmodSync(destination, FILE_MODE);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function resolveExecutable(binary) {
  if (path.isAbsolute(binary)) {
    try { fs.accessSync(binary, fs.constants.X_OK); } catch { fail("codex_binary_unavailable"); }
    return binary;
  }
  if (binary.includes("/") || binary.includes("\\") || binary.length === 0) {
    fail("invalid_codex_binary");
  }
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(entry || process.cwd(), binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  fail("codex_binary_unavailable");
}

function main() {
  const { values, codexArgs } = parseArguments(process.argv.slice(2));
  const profileName = values["--profile"];
  const projectDigest = values["--project-digest"];
  const policyHash = values["--policy-hash"];
  const nonce = values["--nonce"];
  if (!PROFILE_NAME.test(profileName)) fail("invalid_profile_name");
  if (!DIGEST.test(projectDigest) || !DIGEST.test(policyHash)) fail("invalid_digest");
  if (!NONCE.test(nonce)) fail("invalid_nonce");
  if (sha256(values["--project-id"]) !== projectDigest) fail("project_digest_mismatch");
  if (!profileName.endsWith("-" + projectDigest.slice(0, 16) + "-" + policyHash)) {
    fail("profile_identity_mismatch");
  }

  const privateRoot = path.dirname(path.dirname(fs.realpathSync(__filename)));
  const sourceRoot = path.join(privateRoot, "source-revisions");
  const lifecycleRoot = path.join(privateRoot, "lifecycle");
  const locksRoot = path.join(privateRoot, "locks");
  const targetsRoot = path.join(privateRoot, "targets");
  ensureDirectory(sourceRoot);
  ensureDirectory(lifecycleRoot);
  ensureDirectory(locksRoot);
  ensureDirectory(targetsRoot);
  const sourcePath = containedRegularFile(values["--source"], sourceRoot, "unsafe_source_path");
  if (path.basename(sourcePath) !== profileName + ".config.toml") fail("source_identity_mismatch");
  const referencePath = containedDestination(
    values["--reference"],
    lifecycleRoot,
    ".reference.json",
    "unsafe_reference_path"
  );
  const locatorPath = containedDestination(
    values["--locator"],
    lifecycleRoot,
    ".locator.json",
    "unsafe_locator_path"
  );
  const acknowledgementPath = containedDestination(
    values["--ack"],
    lifecycleRoot,
    ".ack.json",
    "unsafe_ack_path"
  );
  const attemptKey = sha256(values["--project-id"] + "\0" + nonce);
  if (referencePath !== path.join(lifecycleRoot, attemptKey + ".reference.json")) {
    fail("reference_identity_mismatch");
  }
  if (acknowledgementPath !== path.join(lifecycleRoot, attemptKey + ".ack.json")) {
    fail("ack_identity_mismatch");
  }
  if (locatorPath !== path.join(lifecycleRoot, attemptKey + ".locator.json")) {
    fail("locator_identity_mismatch");
  }
  const content = fs.readFileSync(sourcePath, "utf8");
  if (sha256(content) !== policyHash) fail("source_hash_mismatch");

  const configuredHome = process.env.CODEX_HOME;
  const inheritedHome = process.env.HOME;
  const homeCandidate = configuredHome && configuredHome.length > 0
    ? configuredHome
    : inheritedHome && inheritedHome.length > 0
      ? path.join(inheritedHome, ".codex")
      : null;
  if (!homeCandidate) fail("codex_home_unavailable");
  const codexHome = ensureCodexHome(path.resolve(homeCandidate));
  const canonicalTargetPath = path.join(codexHome, profileName + ".config.toml");
  if (path.dirname(canonicalTargetPath) !== codexHome) fail("profile_path_escape");
  const codexBinary = resolveExecutable(values["--codex-bin"]);
  if (typeof process.execve !== "function") fail("exec_unavailable");
  const targetLock = acquireTargetLock(locksRoot, canonicalTargetPath, nonce);
  try {
    materializeProfile(canonicalTargetPath, content);
    if (sha256(fs.readFileSync(canonicalTargetPath, "utf8")) !== policyHash) {
      fail("target_hash_mismatch");
    }

    const acknowledgement = {
      version: 1,
      canonicalTargetPath,
      projectId: values["--project-id"],
      sessionId: values["--session-id"],
      projectDigest,
      profileName,
      policyHash,
      nonce
    };
    const markerPath = path.join(targetsRoot, targetLock.lockKey + ".target.json");
    writeOrValidateMarker(markerPath, acknowledgement);
    writeExclusive(referencePath, JSON.stringify({
      ...acknowledgement,
      acknowledgementPath,
      locatorPath
    }));
    writeExclusive(locatorPath, JSON.stringify({
      ...acknowledgement,
      referencePath,
      acknowledgementPath,
      markerPath,
      lockKey: targetLock.lockKey
    }));
    writeExclusive(acknowledgementPath, JSON.stringify(acknowledgement));
  } finally {
    targetLock.release();
  }

  process.execve(codexBinary, [values["--codex-bin"], ...codexArgs], process.env);
}

try {
  main();
} catch {
  fail("internal_failure");
}
`;

@Injectable()
export class CodexPluginProfileMaterializerService {
  private readonly rootPath: string;

  constructor(
    @Optional()
    @Inject(CODEX_PLUGIN_PROFILE_ROOT)
    rootPath?: string,
  ) {
    this.rootPath = resolve(
      rootPath ?? join(getRuntimeContextCaptureRoot(), 'codex-plugin-profiles'),
    );
  }

  async prepare(input: PrepareCodexPluginProfileInput): Promise<PreparedCodexPluginProfile | null> {
    if (input.pluginPolicy.length === 0) return null;
    this.validateIdentity(input);

    const profileToml = this.serializePolicy(input.pluginPolicy);
    const projectDigest = this.sha256(input.projectId);
    const policyHash = this.sha256(profileToml);
    const projectSlug = this.toProjectSlug(input.projectName);
    const profileName = `devchain-${projectSlug}-${projectDigest.slice(0, 16)}-${policyHash}`;
    if (!PROFILE_NAME_PATTERN.test(profileName) || profileName.length > 255) {
      throw new ValidationError('Codex plugin profile name is not filesystem-safe.', {
        field: 'projectName',
      });
    }

    const sourceRoot = join(this.rootPath, 'source-revisions');
    const helperRoot = join(this.rootPath, 'bin');
    const lifecycleRoot = join(this.rootPath, 'lifecycle');
    const locksRoot = join(this.rootPath, 'locks');
    const targetsRoot = join(this.rootPath, 'targets');
    await Promise.all([
      this.ensurePrivateDirectory(this.rootPath),
      this.ensurePrivateDirectory(sourceRoot),
      this.ensurePrivateDirectory(helperRoot),
      this.ensurePrivateDirectory(lifecycleRoot),
      this.ensurePrivateDirectory(locksRoot),
      this.ensurePrivateDirectory(targetsRoot),
    ]);

    const helperHash = this.sha256(CODEX_PROFILE_HELPER_SOURCE);
    const sourceRevisionPath = join(sourceRoot, `${profileName}.config.toml`);
    const helperPath = join(helperRoot, `devchain-codex-profile-helper-${helperHash}`);
    const attemptKey = this.sha256(`${input.projectId}\0${input.attemptNonce}`);
    const referencePath = join(lifecycleRoot, `${attemptKey}.reference.json`);
    const locatorPath = join(lifecycleRoot, `${attemptKey}.locator.json`);
    const acknowledgementPath = join(lifecycleRoot, `${attemptKey}.ack.json`);

    await Promise.all([
      this.materializeImmutable(sourceRevisionPath, profileToml, PRIVATE_FILE_MODE),
      this.materializeImmutable(helperPath, CODEX_PROFILE_HELPER_SOURCE, EXECUTABLE_FILE_MODE),
    ]);

    return {
      profileName,
      projectDigest,
      policyHash,
      sourceRevisionPath,
      helperPath,
      sessionId: input.sessionId,
      attemptNonce: input.attemptNonce,
      referencePath,
      locatorPath,
      acknowledgementPath,
      providerOptionArgs: ['--profile', profileName],
    };
  }

  buildHelperArgv(
    prepared: PreparedCodexPluginProfile,
    codexBinary: string,
    codexArgv: readonly string[],
    input: Pick<PrepareCodexPluginProfileInput, 'projectId' | 'attemptNonce'>,
  ): string[] {
    this.validateCodexBinary(codexBinary);
    if (!PROFILE_NAME_PATTERN.test(prepared.profileName)) {
      throw new ValidationError('Codex plugin profile name is not filesystem-safe.', {
        field: 'profileName',
      });
    }
    if (!DIGEST_PATTERN.test(prepared.projectDigest) || !DIGEST_PATTERN.test(prepared.policyHash)) {
      throw new ValidationError('Codex plugin profile digests are invalid.', {
        field: 'policyHash',
      });
    }
    if (!NONCE_PATTERN.test(input.attemptNonce)) {
      throw new ValidationError('Codex plugin profile attempt nonce is invalid.', {
        field: 'attemptNonce',
      });
    }
    if (codexArgv.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new ValidationError('Codex launch arguments are invalid.', { field: 'codexArgv' });
    }

    return [
      prepared.helperPath,
      '--source',
      prepared.sourceRevisionPath,
      '--profile',
      prepared.profileName,
      '--project-id',
      input.projectId,
      '--session-id',
      prepared.sessionId,
      '--project-digest',
      prepared.projectDigest,
      '--policy-hash',
      prepared.policyHash,
      '--reference',
      prepared.referencePath,
      '--locator',
      prepared.locatorPath,
      '--ack',
      prepared.acknowledgementPath,
      '--nonce',
      input.attemptNonce,
      '--codex-bin',
      codexBinary,
      '--',
      ...codexArgv,
    ];
  }

  async awaitAcknowledgement(
    prepared: PreparedCodexPluginProfile,
    input: Pick<PrepareCodexPluginProfileInput, 'projectId' | 'attemptNonce'>,
    timeoutMs = 5_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const acknowledgement = await this.readJsonFile<CodexProfileAcknowledgement>(
        prepared.acknowledgementPath,
      );
      if (acknowledgement) {
        const locator = await this.readJsonFile<CodexProfileLocator>(prepared.locatorPath);
        if (!locator) {
          throw new IOError('Codex profile acknowledgement has no matching locator.', {
            stage: 'profile_acknowledgement',
          });
        }
        this.assertAcknowledgement(acknowledgement, prepared, input);
        this.assertAcknowledgement(locator, prepared, input);
        if (
          locator.canonicalTargetPath !== acknowledgement.canonicalTargetPath ||
          locator.referencePath !== prepared.referencePath ||
          locator.acknowledgementPath !== prepared.acknowledgementPath ||
          locator.lockKey !== this.sha256(locator.canonicalTargetPath)
        ) {
          throw new IOError('Codex profile locator does not match its launch attempt.', {
            stage: 'profile_locator',
          });
        }
        return acknowledgement.canonicalTargetPath;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new TimeoutError('Timed out waiting for Codex profile acknowledgement.', {
      stage: 'profile_acknowledgement',
    });
  }

  async cleanupPrepared(prepared: PreparedCodexPluginProfile): Promise<void> {
    const locator = await this.readJsonFile<CodexProfileLocator>(prepared.locatorPath);
    if (!locator) {
      return;
    }
    await this.cleanupLocator(prepared.locatorPath, locator);
  }

  async cleanupSession(sessionId: string): Promise<void> {
    await this.cleanupLifecycleLocators((locator) => locator.sessionId === sessionId);
  }

  async reconcileStartup(nonLiveSessionIds: ReadonlySet<string>): Promise<void> {
    await this.cleanupLifecycleLocators((locator) => nonLiveSessionIds.has(locator.sessionId));
  }

  serializePolicy(policy: ReadonlyArray<CodexPluginPolicyEntry>): string {
    const byPluginId = new Map<string, boolean>();
    for (const entry of policy) {
      this.validatePolicyEntry(entry);
      if (byPluginId.has(entry.pluginId)) {
        throw new ValidationError('Resolved Codex plugin policy contains duplicate plugin IDs.', {
          field: 'pluginPolicy',
        });
      }
      byPluginId.set(entry.pluginId, entry.enabled);
    }

    return [...byPluginId.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([pluginId, enabled]) =>
          `[plugins.${JSON.stringify(pluginId)}]\nenabled = ${enabled ? 'true' : 'false'}\n`,
      )
      .join('\n');
  }

  private async cleanupLifecycleLocators(
    predicate: (locator: CodexProfileLocator) => boolean,
  ): Promise<void> {
    const lifecycleRoot = join(this.rootPath, 'lifecycle');
    let entries;
    try {
      entries = await readdir(lifecycleRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.locator.json')) continue;
      const locatorPath = join(lifecycleRoot, entry.name);
      const locator = await this.readJsonFile<CodexProfileLocator>(locatorPath);
      if (!locator || !predicate(locator)) continue;
      await this.cleanupLocator(locatorPath, locator);
    }
  }

  private async cleanupLocator(locatorPath: string, locator: CodexProfileLocator): Promise<void> {
    if (
      !isAbsolute(locator.canonicalTargetPath) ||
      locator.lockKey !== this.sha256(locator.canonicalTargetPath) ||
      locatorPath !==
        join(
          this.rootPath,
          'lifecycle',
          `${this.sha256(`${locator.projectId}\0${locator.nonce}`)}.locator.json`,
        ) ||
      locator.referencePath !== locatorPath.replace(/\.locator\.json$/, '.reference.json') ||
      locator.acknowledgementPath !== locatorPath.replace(/\.locator\.json$/, '.ack.json') ||
      locator.markerPath !== join(this.rootPath, 'targets', `${locator.lockKey}.target.json`)
    ) {
      return;
    }

    const release = await this.acquireTargetLock(
      locator.canonicalTargetPath,
      `cleanup:${locator.nonce}`,
    );
    try {
      await rm(locator.referencePath, { force: true });
      if (!(await this.hasLiveReference(locator.canonicalTargetPath))) {
        const marker = await this.readJsonFile<CodexProfileAcknowledgement>(locator.markerPath);
        const targetHash = await this.hashRegularFile(locator.canonicalTargetPath);
        if (
          marker &&
          marker.canonicalTargetPath === locator.canonicalTargetPath &&
          marker.profileName === locator.profileName &&
          marker.policyHash === locator.policyHash &&
          targetHash === locator.policyHash
        ) {
          await rm(locator.canonicalTargetPath, { force: true });
          await rm(locator.markerPath, { force: true });
        }
      }
    } finally {
      await release();
    }
    await Promise.all([
      rm(locator.acknowledgementPath, { force: true }),
      rm(locatorPath, { force: true }),
    ]);
  }

  private async hasLiveReference(canonicalTargetPath: string): Promise<boolean> {
    const lifecycleRoot = join(this.rootPath, 'lifecycle');
    const entries = await readdir(lifecycleRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.reference.json')) continue;
      const reference = await this.readJsonFile<CodexProfileAcknowledgement>(
        join(lifecycleRoot, entry.name),
      );
      if (!reference || reference.canonicalTargetPath === canonicalTargetPath) return true;
    }
    return false;
  }

  private async acquireTargetLock(
    canonicalTargetPath: string,
    attemptNonce: string,
  ): Promise<() => Promise<void>> {
    const locksRoot = join(this.rootPath, 'locks');
    await this.ensurePrivateDirectory(locksRoot);
    const lockPath = join(locksRoot, `${this.sha256(canonicalTargetPath)}.lock`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
        const startIdentity = await this.readProcessStartIdentity(process.pid);
        if (typeof startIdentity !== 'string') {
          await rm(lockPath, { recursive: true, force: true });
          throw new IOError('Process identity unavailable for Codex profile lock.');
        }
        await writeFile(
          join(lockPath, 'owner.json'),
          JSON.stringify({ version: 1, pid: process.pid, startIdentity, attemptNonce }),
          { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' },
        );
        return async () => rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const owner = await this.readJsonFile<{ pid: number; startIdentity: string }>(
        join(lockPath, 'owner.json'),
      );
      if (owner && Number.isSafeInteger(owner.pid) && typeof owner.startIdentity === 'string') {
        const actual = await this.readProcessStartIdentity(owner.pid);
        if (actual === false || (typeof actual === 'string' && actual !== owner.startIdentity)) {
          const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
          try {
            await rename(lockPath, stalePath);
            await rm(stalePath, { recursive: true, force: true });
            continue;
          } catch {
            // Another contender won recovery; retry without weakening the proof requirement.
          }
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new TimeoutError('Timed out acquiring Codex profile lifecycle lock.', {
      stage: 'profile_lock',
    });
  }

  private async readProcessStartIdentity(pid: number): Promise<string | false | null> {
    try {
      const value = await readFile(`/proc/${pid}/stat`, 'utf8');
      return (
        value
          .slice(value.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/)[19] ?? null
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ESRCH' ? false : null;
    }
  }

  private async readJsonFile<T>(path: string): Promise<T | null> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async hashRegularFile(path: string): Promise<string | null> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return this.sha256(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  private assertAcknowledgement(
    acknowledgement: CodexProfileAcknowledgement,
    prepared: PreparedCodexPluginProfile,
    input: Pick<PrepareCodexPluginProfileInput, 'projectId' | 'attemptNonce'>,
  ): void {
    if (
      acknowledgement.version !== 1 ||
      acknowledgement.projectId !== input.projectId ||
      acknowledgement.sessionId !== prepared.sessionId ||
      acknowledgement.projectDigest !== prepared.projectDigest ||
      acknowledgement.profileName !== prepared.profileName ||
      acknowledgement.policyHash !== prepared.policyHash ||
      acknowledgement.nonce !== input.attemptNonce ||
      !isAbsolute(acknowledgement.canonicalTargetPath)
    ) {
      throw new IOError('Codex profile acknowledgement does not match its launch attempt.', {
        stage: 'profile_acknowledgement',
      });
    }
  }

  private validateIdentity(input: PrepareCodexPluginProfileInput): void {
    if (
      typeof input.projectId !== 'string' ||
      input.projectId.length === 0 ||
      ASCII_CONTROL_PATTERN.test(input.projectId)
    ) {
      throw new ValidationError('Codex plugin profile project identity is invalid.', {
        field: 'projectId',
      });
    }
    if (typeof input.projectName !== 'string') {
      throw new ValidationError('Codex plugin profile project name is invalid.', {
        field: 'projectName',
      });
    }
    if (
      typeof input.sessionId !== 'string' ||
      input.sessionId.length === 0 ||
      ASCII_CONTROL_PATTERN.test(input.sessionId)
    ) {
      throw new ValidationError('Codex plugin profile session identity is invalid.', {
        field: 'sessionId',
      });
    }
    if (!NONCE_PATTERN.test(input.attemptNonce)) {
      throw new ValidationError('Codex plugin profile attempt nonce is invalid.', {
        field: 'attemptNonce',
      });
    }
  }

  private validatePolicyEntry(entry: CodexPluginPolicyEntry): void {
    const characterCount =
      typeof entry.pluginId === 'string' ? Array.from(entry.pluginId).length : 0;
    if (
      typeof entry.pluginId !== 'string' ||
      characterCount === 0 ||
      characterCount > MAX_PLUGIN_ID_LENGTH ||
      ASCII_CONTROL_PATTERN.test(entry.pluginId) ||
      typeof entry.enabled !== 'boolean'
    ) {
      throw new ValidationError('Resolved Codex plugin policy entry is invalid.', {
        field: 'pluginPolicy',
      });
    }
  }

  private validateCodexBinary(codexBinary: string): void {
    if (
      typeof codexBinary !== 'string' ||
      codexBinary.length === 0 ||
      ASCII_CONTROL_PATTERN.test(codexBinary) ||
      (!isAbsolute(codexBinary) && (codexBinary.includes('/') || codexBinary.includes('\\')))
    ) {
      throw new ValidationError('Codex binary must be a bare command or absolute path.', {
        field: 'codexBinary',
      });
    }
  }

  private toProjectSlug(projectName: string): string {
    const slug = projectName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_PROJECT_SLUG_LENGTH)
      .replace(/-+$/g, '');
    return slug || 'project';
  }

  private sha256(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Codex plugin profile private path is unsafe');
    }
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }

  private async materializeImmutable(path: string, content: string, mode: number): Promise<void> {
    try {
      await access(path, constants.F_OK);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Immutable Codex profile artifact path is unsafe');
      }
      if ((await readFile(path, 'utf8')) !== content) {
        throw new Error('Immutable Codex profile artifact content mismatch');
      }
      await chmod(path, mode);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, content, {
        encoding: 'utf8',
        mode,
        flag: 'wx',
      });
      await link(temporaryPath, path).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        if ((await readFile(path, 'utf8')) !== content) throw error;
      });
      await chmod(path, mode);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export { CODEX_PROFILE_HELPER_SOURCE };
