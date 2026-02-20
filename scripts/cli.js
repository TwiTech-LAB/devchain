#!/usr/bin/env node
/**
 * Devchain CLI
 * start command: boots the local app API + UI, picks a port, and opens browser.
 */

/* eslint-disable no-console */

const { Command } = require('commander');
const getPort = require('get-port');
const open = require('open');
const { join, dirname, basename } = require('path');
const { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync, realpathSync } = require('fs');
const { homedir, platform } = require('os');
const { spawn, execSync, execFileSync } = require('child_process');
const { InteractiveCLI } = require('./lib/interactive-cli');
const readline = require('readline');

async function waitForHealth(url, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return true;
      }
    } catch (_) {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function resolveOpenOptions() {
  const val = process.env.DEVCHAIN_BROWSER || process.env.BROWSER;
  if (val && typeof val === 'string' && val.trim()) {
    const parts = val.trim().split(/\s+/);
    return { app: { name: parts[0], arguments: parts.slice(1) } };
  }
  return {};
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...(options || {}), signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function getChangelogBetweenVersions(changelog, fromVersion, toVersion) {
  if (!changelog || typeof changelog !== 'object') return [];

  const changes = [];
  const versions = Object.keys(changelog).sort((a, b) => {
    // Sort versions descending
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((bParts[i] || 0) !== (aParts[i] || 0)) {
        return (bParts[i] || 0) - (aParts[i] || 0);
      }
    }
    return 0;
  });

  for (const version of versions) {
    if (isNewerVersion(version, fromVersion) && !isNewerVersion(version, toVersion)) {
      // Include this version's changes
      if (Array.isArray(changelog[version])) {
        changes.push({ version, items: changelog[version] });
      }
    }
    // Also include the target version itself
    if (version === toVersion && Array.isArray(changelog[version])) {
      if (!changes.find(c => c.version === version)) {
        changes.unshift({ version, items: changelog[version] });
      }
    }
  }

  return changes;
}

function normalizeCliArgv(argv) {
  const rawArgs = argv.slice(2);
  const hasContainerFlag = rawArgs.includes('--container');
  if (!hasContainerFlag) {
    return argv;
  }

  const knownCommands = new Set(['start', 'stop', 'help']);
  const hasKnownCommand = rawArgs.some((arg) => knownCommands.has(arg));
  if (hasKnownCommand) {
    return argv;
  }

  const passthrough = rawArgs.filter((arg) => arg !== '--container');
  return [argv[0], argv[1], 'start', '--container', ...passthrough];
}

const WORKTREE_RUNTIME_TYPES = new Set(['container', 'process']);

function normalizeWorktreeRuntimeType(rawRuntimeType) {
  if (typeof rawRuntimeType !== 'string') {
    return null;
  }

  const normalized = rawRuntimeType.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (!WORKTREE_RUNTIME_TYPES.has(normalized)) {
    throw new Error(
      `Invalid --worktree-runtime value "${rawRuntimeType}". Expected one of: container, process.`,
    );
  }

  return normalized;
}

function isWorktreeRuntimeModeEnabled(worktreeRuntimeType) {
  return worktreeRuntimeType === 'container' || worktreeRuntimeType === 'process';
}

/**
 * Detect which global package manager owns the devchain install.
 *
 * @param {string} packageName - The npm package name (e.g. 'devchain-cli')
 * @param {object} [deps] - Dependency-injected functions for testability
 * @returns {{ name: 'npm'|'pnpm', installCmd: string[], sudoInstallCmd: string[]|null, manualCmd: string }|null}
 */
function detectGlobalPackageManager(packageName, {
  realpathSyncFn = realpathSync,
  execFileSyncFn = execFileSync,
  argvPath = process.argv[1],
} = {}) {
  try {
    let scriptRealPath;
    try {
      scriptRealPath = realpathSyncFn(argvPath);
    } catch {
      return null;
    }

    const pms = [
      { name: 'pnpm', rootArgs: ['root', '-g'], installVerb: 'add' },
      { name: 'npm', rootArgs: ['root', '-g'], installVerb: 'install' },
    ];

    const available = [];
    for (const pm of pms) {
      try {
        execFileSyncFn(pm.name, ['--version'], { stdio: 'ignore' });
        available.push(pm);
      } catch {
        // PM not on PATH
      }
    }

    if (available.length === 0) return null;

    const owners = [];
    for (const pm of available) {
      try {
        const globalRoot = execFileSyncFn(pm.name, pm.rootArgs, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (globalRoot && scriptRealPath.startsWith(globalRoot)) {
          owners.push(pm);
        }
      } catch {
        // root -g failed
      }
    }

    // Ambiguous: both match or neither match
    if (owners.length !== 1) return null;

    const pm = owners[0];
    const installCmd = [pm.name, pm.installVerb, '-g', `${packageName}@latest`];
    const sudoInstallCmd = platform() !== 'win32'
      ? ['sudo', ...installCmd]
      : null;
    const manualCmd = `${pm.name} ${pm.installVerb} -g ${packageName}`;

    return { name: pm.name, installCmd, sudoInstallCmd, manualCmd };
  } catch {
    return null;
  }
}

async function checkForUpdates(cli, askYesNoFn) {
  try {
    const pkg = require('../package.json');
    const currentVersion = pkg.version;
    const packageName = pkg.name;

    // Fetch latest package info from npm registry (with short timeout)
    const res = await fetchWithTimeout(`https://registry.npmjs.org/${packageName}/latest`, {}, 3000);
    if (!res.ok) return;

    const data = await res.json();
    const latestVersion = data.version;

    if (latestVersion !== currentVersion && isNewerVersion(latestVersion, currentVersion)) {
      cli.blank();
      cli.warn(`A new version of devchain is available: ${currentVersion} → ${latestVersion}`);

      // Show changelog if available
      const changelog = data.changelog;
      const changes = getChangelogBetweenVersions(changelog, currentVersion, latestVersion);
      if (changes.length > 0) {
        cli.blank();
        cli.info("What's new:");
        for (const { version, items } of changes) {
          for (const item of items) {
            console.log(`  • ${item}`);
          }
        }
      }
      cli.blank();

      const shouldUpdate = await askYesNoFn('Would you like to update now?', true);

      if (shouldUpdate) {
        const pm = detectGlobalPackageManager(packageName);

        if (!pm) {
          // Cannot determine owning PM — show manual instructions
          cli.warn('Could not detect the package manager used to install devchain.');
          cli.info('Please update manually:');
          cli.info('  npm install -g ' + packageName);
          cli.info('  pnpm add -g ' + packageName);
          return;
        }

        cli.info(`Updating devchain via ${pm.name}...`);
        try {
          execFileSync(pm.installCmd[0], pm.installCmd.slice(1), { stdio: 'inherit' });
          cli.success('Update complete! Please restart devchain.');
          process.exit(0);
        } catch (e) {
          // On Linux/Mac, might need sudo for system installs
          if (pm.sudoInstallCmd) {
            cli.info('Retrying with sudo...');
            try {
              execFileSync(pm.sudoInstallCmd[0], pm.sudoInstallCmd.slice(1), { stdio: 'inherit' });
              cli.success('Update complete! Please restart devchain.');
              process.exit(0);
            } catch (e2) {
              cli.error('Update failed. You can manually run: sudo ' + pm.manualCmd);
            }
          } else {
            cli.error('Update failed. You can manually run: ' + pm.manualCmd);
          }
        }
      }
      cli.blank();
    }
  } catch (e) {
    // Silently ignore - don't block startup for update check failures
  }
}

function isBinaryInstalled(cmd) {
  try {
    const out = execSync(`which ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

function detectInstalledProviders() {
  const detected = new Map();
  const codexPath = isBinaryInstalled('codex');
  const claudePath = isBinaryInstalled('claude');
  const geminiPath = isBinaryInstalled('gemini');
  if (codexPath) detected.set('codex', codexPath);
  if (claudePath) detected.set('claude', claudePath);
  if (geminiPath) detected.set('gemini', geminiPath);
  return detected; // Map<name, absolutePath>
}

const ORCHESTRATOR_WORKTREE_IMAGE_REPO = 'ghcr.io/twitech-lab/devchain';
const WORKTREE_IMAGE_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDockerAvailable(execSyncFn = execSync) {
  try {
    execSyncFn('docker info --format "{{.ID}}"', {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (_) {
    throw new Error('Container mode requires Docker. Please install Docker and try again.');
  }
}

function isDockerAvailable(execSyncFn = execSync) {
  try {
    ensureDockerAvailable(execSyncFn);
    return true;
  } catch (_) {
    return false;
  }
}

function deriveRepoRootFromGit(execSyncFn = execSync) {
  try {
    const gitTopLevel = execSyncFn('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (!gitTopLevel) {
      throw new Error('empty-git-top-level');
    }

    process.env.REPO_ROOT = gitTopLevel;
    return gitTopLevel;
  } catch (_) {
    throw new Error('Container mode must be run from within a git repository.');
  }
}

function isInsideGitRepo(execSyncFn = execSync) {
  const previousRepoRoot = process.env.REPO_ROOT;
  try {
    deriveRepoRootFromGit(execSyncFn);
    return true;
  } catch (_) {
    return false;
  } finally {
    if (typeof previousRepoRoot === 'string') {
      process.env.REPO_ROOT = previousRepoRoot;
    } else {
      delete process.env.REPO_ROOT;
    }
  }
}

function ensureProjectGitignoreIncludesDevchain(repoRoot) {
  const normalizedRepoRoot = typeof repoRoot === 'string' ? repoRoot.trim() : '';
  if (!normalizedRepoRoot || !existsSync(normalizedRepoRoot)) {
    return;
  }

  const gitignorePath = join(normalizedRepoRoot, '.gitignore');

  try {
    const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const alreadyIgnored = existingContent.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return false;
      }
      return (
        trimmed === '.devchain/' ||
        trimmed === '/.devchain/' ||
        trimmed === '.devchain' ||
        trimmed === '/.devchain'
      );
    });

    if (alreadyIgnored) {
      return;
    }

    const delimiter = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignorePath, `${existingContent}${delimiter}.devchain/\n`, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: unable to update project .gitignore with .devchain/ (${message})`);
  }
}

function resolveRepoRootForDockerBuild(execSyncFn = execSync) {
  const repoRootFromEnv = typeof process.env.REPO_ROOT === 'string' ? process.env.REPO_ROOT.trim() : '';
  if (repoRootFromEnv) {
    return repoRootFromEnv;
  }
  try {
    return deriveRepoRootFromGit(execSyncFn);
  } catch (_) {
    return join(__dirname, '..');
  }
}

function shouldSkipHostPreflights(enableOrchestration) {
  return Boolean(enableOrchestration);
}

function resolveWorktreeImageFromPackageVersion() {
  const pkg = require('../package.json');
  const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  if (!version) {
    throw new Error('Unable to resolve CLI package version for worktree image provisioning.');
  }
  return `${ORCHESTRATOR_WORKTREE_IMAGE_REPO}:${version}`;
}

function hasWorktreeImageLocally(imageRef, execSyncFn = execSync) {
  try {
    execSyncFn(`docker image inspect ${imageRef}`, {
      stdio: 'pipe',
      timeout: 15000,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function buildWorktreeImage({
  imageRef = resolveWorktreeImageFromPackageVersion(),
  execSyncFn = execSync,
} = {}) {
  const repoRoot = resolveRepoRootForDockerBuild(execSyncFn);
  const dockerfilePath = join(repoRoot, 'apps', 'local-app', 'Dockerfile');
  console.log(`Building worktree image: ${imageRef}`);
  try {
    execSyncFn(
      `docker build -f "${dockerfilePath}" -t ${imageRef} "${repoRoot}"`,
      {
        stdio: 'inherit',
        timeout: WORKTREE_IMAGE_BUILD_TIMEOUT_MS,
      },
    );
    console.log(`Built worktree image: ${imageRef}`);
    return imageRef;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Failed to build worktree image: ${imageRef}`,
        `Reason: ${message}`,
        `Try manually: docker build -f "${dockerfilePath}" -t ${imageRef} "${repoRoot}"`,
      ].join('\n'),
    );
  }
}

function resolveDevchainApiBaseUrlForRestart({
  readPidFileFn = readPidFile,
  isProcessRunningFn = isProcessRunning,
} = {}) {
  const pidData = readPidFileFn();
  if (!pidData || !Number.isFinite(Number(pidData.pid)) || !Number.isFinite(Number(pidData.port))) {
    throw new Error(
      'Image was rebuilt, but Devchain is not running. Start container mode first, then retry with --restart.',
    );
  }

  const pid = Number(pidData.pid);
  const port = Number(pidData.port);
  if (!isProcessRunningFn(pid)) {
    throw new Error(
      'Image was rebuilt, but Devchain is not running. Start container mode first, then retry with --restart.',
    );
  }

  return `http://127.0.0.1:${port}`;
}

function normalizeWorktreeListPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.items)) {
    return payload.items;
  }
  throw new Error('Unexpected response shape from /api/worktrees.');
}

async function restartRunningWorktrees({
  baseUrl,
  fetchFn = fetch,
} = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('A baseUrl is required to restart running worktrees.');
  }

  const listRes = await fetchFn(`${baseUrl}/api/worktrees`);
  if (!listRes.ok) {
    throw new Error(`Failed to list worktrees for restart (HTTP ${listRes.status}).`);
  }

  const worktrees = normalizeWorktreeListPayload(await listRes.json());
  const runningWorktrees = worktrees.filter(
    (worktree) => String(worktree?.status || '').toLowerCase() === 'running',
  );

  if (runningWorktrees.length === 0) {
    console.log('No running worktrees found. Build completed without restarts.');
    return 0;
  }

  console.log(`Restarting ${runningWorktrees.length} running worktree(s)...`);
  for (const worktree of runningWorktrees) {
    const worktreeId = typeof worktree?.id === 'string' ? worktree.id.trim() : '';
    const worktreeName =
      typeof worktree?.name === 'string' && worktree.name.trim()
        ? worktree.name.trim()
        : worktreeId || 'unknown';

    if (!worktreeId) {
      throw new Error('Cannot restart worktree without an id from /api/worktrees response.');
    }

    console.log(`Stopping worktree "${worktreeName}"...`);
    const stopRes = await fetchFn(`${baseUrl}/api/worktrees/${encodeURIComponent(worktreeId)}/stop`, {
      method: 'POST',
    });
    if (!stopRes.ok) {
      throw new Error(`Failed stopping worktree "${worktreeName}" (HTTP ${stopRes.status}).`);
    }

    console.log(`Starting worktree "${worktreeName}"...`);
    const startRes = await fetchFn(`${baseUrl}/api/worktrees/${encodeURIComponent(worktreeId)}/start`, {
      method: 'POST',
    });
    if (!startRes.ok) {
      throw new Error(`Failed starting worktree "${worktreeName}" (HTTP ${startRes.status}).`);
    }
  }

  console.log('Worktree restart complete.');
  return runningWorktrees.length;
}

async function ensureWorktreeImage({
  execSyncFn = execSync,
  onMissing = 'pull',
} = {}) {
  const existingImageOverride =
    typeof process.env.ORCHESTRATOR_CONTAINER_IMAGE === 'string'
      ? process.env.ORCHESTRATOR_CONTAINER_IMAGE.trim()
      : '';
  if (existingImageOverride) {
    process.env.ORCHESTRATOR_CONTAINER_IMAGE = existingImageOverride;
    console.log(`Using worktree image override: ${existingImageOverride}`);
    return existingImageOverride;
  }

  const imageRef = resolveWorktreeImageFromPackageVersion();

  if (hasWorktreeImageLocally(imageRef, execSyncFn)) {
    console.log(`Using local worktree image: ${imageRef}`);
  } else if (onMissing === 'build') {
    console.log(`Local worktree image missing: ${imageRef}`);
    buildWorktreeImage({ imageRef, execSyncFn });
  } else if (onMissing === 'pull') {
    console.log(`Pulling worktree image: ${imageRef}`);
    try {
      execSyncFn(`docker pull ${imageRef}`, {
        stdio: 'inherit',
        timeout: 300000,
      });
      console.log(`Pulled worktree image: ${imageRef}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          `Failed to pull worktree image: ${imageRef}`,
          `Reason: ${message}`,
          `Try manually: docker pull ${imageRef}`,
          `Or build locally: docker build -t ${imageRef} -f apps/local-app/Dockerfile .`,
        ].join('\n'),
      );
    }
  } else {
    throw new Error(`Invalid ensureWorktreeImage onMissing strategy: ${onMissing}`);
  }

  process.env.ORCHESTRATOR_CONTAINER_IMAGE = imageRef;
  return imageRef;
}

function ensureWorktreeImageRefFromPackageVersion() {
  const existingImageOverride =
    typeof process.env.ORCHESTRATOR_CONTAINER_IMAGE === 'string'
      ? process.env.ORCHESTRATOR_CONTAINER_IMAGE.trim()
      : '';
  if (existingImageOverride) {
    process.env.ORCHESTRATOR_CONTAINER_IMAGE = existingImageOverride;
    return existingImageOverride;
  }

  const imageRef = resolveWorktreeImageFromPackageVersion();
  process.env.ORCHESTRATOR_CONTAINER_IMAGE = imageRef;
  return imageRef;
}

async function bootstrapContainerMode({
  execSyncFn = execSync,
} = {}) {
  ensureDockerAvailable(execSyncFn);
  const repoRoot = deriveRepoRootFromGit(execSyncFn);
  ensureProjectGitignoreIncludesDevchain(repoRoot);
  ensureWorktreeImageRefFromPackageVersion();
}

function formatOrchestrationDetectionFailureReason({
  skippedByEnvNormal = false,
  dockerAvailable = false,
  insideGitRepo = false,
} = {}) {
  if (skippedByEnvNormal) {
    return 'DEVCHAIN_MODE=normal override is active';
  }

  const missing = [];
  if (!dockerAvailable) {
    missing.push('Docker is unavailable');
  }
  if (!insideGitRepo) {
    missing.push('current directory is not inside a git repository');
  }

  if (missing.length === 0) {
    return 'orchestration prerequisites are not met';
  }
  if (missing.length === 1) {
    return missing[0];
  }
  return `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
}

async function resolveStartupOrchestration({
  forceContainer = false,
  env = process.env,
  execSyncFn = execSync,
  bootstrapContainerModeFn = bootstrapContainerMode,
  warnFn = (message) => console.warn(message),
} = {}) {
  const modeOverride = typeof env.DEVCHAIN_MODE === 'string' ? env.DEVCHAIN_MODE.trim() : '';
  const skippedByEnvNormal = modeOverride.toLowerCase() === 'normal';
  if (skippedByEnvNormal) {
    if (forceContainer) {
      throw new Error(
        `--container requires orchestration, but ${formatOrchestrationDetectionFailureReason({ skippedByEnvNormal })}.`,
      );
    }
    return {
      enableOrchestration: false,
      skippedByEnvNormal,
      dockerAvailable: false,
      insideGitRepo: false,
    };
  }

  const dockerAvailable = isDockerAvailable(execSyncFn);
  const insideGitRepo = isInsideGitRepo(execSyncFn);

  if (!dockerAvailable || !insideGitRepo) {
    const reason = formatOrchestrationDetectionFailureReason({
      dockerAvailable,
      insideGitRepo,
    });
    if (forceContainer) {
      throw new Error(`--container requires orchestration, but ${reason}.`);
    }
    return {
      enableOrchestration: false,
      skippedByEnvNormal: false,
      dockerAvailable,
      insideGitRepo,
    };
  }

  try {
    await bootstrapContainerModeFn({
      execSyncFn,
    });
    env.DEVCHAIN_MODE = 'main';
    return {
      enableOrchestration: true,
      skippedByEnvNormal: false,
      dockerAvailable: true,
      insideGitRepo: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (forceContainer) {
      throw new Error(`--container failed to initialize orchestration: ${message}`);
    }
    warnFn(`Container auto-detection found prerequisites but bootstrap failed: ${message}`);
    return {
      enableOrchestration: false,
      skippedByEnvNormal: false,
      dockerAvailable: true,
      insideGitRepo: true,
      bootstrapError: message,
    };
  }
}

async function ensureProvidersInDb(baseUrl, detected, log) {
  try {
    const res = await fetch(`${baseUrl}/api/providers`);
    if (!res.ok) {
      log('warn', 'Failed to fetch providers; skipping ensure');
      return;
    }
    const data = await res.json();
    const existing = new Set((data?.items || []).map((p) => p.name));
    const toCreate = Array.from(detected.keys()).filter((n) => !existing.has(n));
    for (const name of toCreate) {
      const body = {
        name,
        // pass command name to allow normalization; controller validates presence on PATH
        binPath: name,
      };
      try {
        const createRes = await fetch(`${baseUrl}/api/providers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (createRes.ok) {
          log('info', 'Created provider', { name });
        } else {
          const errText = await createRes.text();
          log('warn', 'Failed to create provider', { name, status: createRes.status, errText });
        }
      } catch (e) {
        log('warn', 'Error creating provider', { name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    log('warn', 'Provider DB ensure failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function validateMcpForProviders(baseUrl, cli, opts, log, projectPath) {
  try {
    // Fetch all providers
    const res = await fetch(`${baseUrl}/api/providers`);
    if (!res.ok) {
      if (opts.foreground) {
        log('warn', 'Failed to fetch providers for MCP validation; skipping', { status: res.status });
      } else {
        cli.warn('Skipping MCP validation (failed to fetch providers)');
      }
      return;
    }

    const data = await res.json();
    const providers = data?.items || [];
    if (providers.length === 0) {
      if (opts.foreground) {
        log('info', 'No providers to validate for MCP');
      }
      return;
    }

    // Interactive: show spinner
    const spinner = opts.foreground ? null : cli.spinner('Validating MCP');
    if (spinner) spinner.start();

    const results = [];
    for (const provider of providers) {
      try {
        const body = projectPath ? JSON.stringify({ projectPath }) : JSON.stringify({});
        const ensureRes = await fetch(`${baseUrl}/api/providers/${provider.id}/mcp/ensure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (ensureRes.ok) {
          const result = await ensureRes.json();
          results.push({
            name: provider.name,
            action: result.action,
            success: true,
            endpoint: result.endpoint,
          });

          if (opts.foreground) {
            log('info', 'MCP validation complete', {
              provider: provider.name,
              action: result.action,
              endpoint: result.endpoint,
            });
          }
        } else {
          const errText = await ensureRes.text();
          results.push({
            name: provider.name,
            success: false,
            error: errText,
          });

          if (opts.foreground) {
            log('warn', 'MCP validation failed', {
              provider: provider.name,
              status: ensureRes.status,
              error: errText,
            });
          }
        }
      } catch (e) {
        results.push({
          name: provider.name,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });

        if (opts.foreground) {
          log('warn', 'MCP validation error', {
            provider: provider.name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    if (spinner) spinner.stop('✓');

    // Display results in interactive mode
    if (!opts.foreground) {
      for (const result of results) {
        if (result.success) {
          const actionText = {
            added: 'configured',
            fixed_mismatch: 'fixed',
            already_configured: 'ready',
          }[result.action] || result.action;
          cli.success(`${result.name}: ${actionText}`);
        } else {
          cli.error(`${result.name}: validation failed`);
        }
      }
    }
  } catch (e) {
    if (opts.foreground) {
      log('warn', 'MCP validation step failed', { error: e instanceof Error ? e.message : String(e) });
    } else {
      cli.warn('MCP validation failed');
    }
  }
}

function askYesNo(question, defaultYes = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const prompt = defaultYes ? `${question} [Y/n] ` : `${question} [y/N] `;
    let answered = false;

    // Handle Ctrl+D (EOF) - user wants to cancel/exit
    rl.on('close', () => {
      if (!answered) {
        console.log(); // Print newline since Ctrl+D doesn't
        process.exit(0);
      }
    });

    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') {
        resolve(defaultYes);
      } else {
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    });
  });
}

async function ensureClaudeBypassPermissions(cli) {
  const claudeConfigPath = join(homedir(), '.claude.json');

  // Skip if file doesn't exist
  if (!existsSync(claudeConfigPath)) {
    return;
  }

  // Try to read and parse config
  let config;
  try {
    config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
  } catch {
    // Invalid JSON - skip silently
    return;
  }

  // Skip silently if already enabled
  if (config.bypassPermissionsModeAccepted === true) {
    return;
  }

  // Show explanation and prompt
  cli.blank();
  cli.info('Claude requires permission approval for each command by default.');
  cli.info('Enabling bypass mode allows devchain to auto-approve commands.');

  const confirmed = await askYesNo('Enable bypass permissions mode for Claude?', true);
  cli.blank();

  if (confirmed) {
    config.bypassPermissionsModeAccepted = true;
    try {
      writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      cli.success('Bypass permissions mode enabled in ~/.claude.json');
    } catch (error) {
      cli.warn('Failed to update ~/.claude.json - you may need to enable manually');
    }
  } else {
    cli.info('Skipped - you can enable this later in ~/.claude.json');
  }
}

function parseDbPath(db) {
  if (!db) return {};
  // If a directory was provided, use it as DB_PATH and keep default filename
  // If a file path was provided, split into dir + filename
  try {
    const dir = dirname(db);
    const file = basename(db);
    const looksLikeFile = /\.[a-zA-Z0-9]+$/.test(file);
    if (looksLikeFile) {
      return { DB_PATH: dir, DB_FILENAME: file };
    }
    return { DB_PATH: db };
  } catch {
    return {};
  }
}

function getPidFilePath() {
  const devchainDir = join(homedir(), '.devchain');
  if (!existsSync(devchainDir)) {
    mkdirSync(devchainDir, { recursive: true });
  }
  return join(devchainDir, 'devchain.pid');
}

function writePidFile(port) {
  const pidFile = getPidFilePath();
  const data = JSON.stringify({ pid: process.pid, port, timestamp: Date.now() });
  writeFileSync(pidFile, data, 'utf8');
}

function readPidFile() {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) {
    return null;
  }
  try {
    const data = readFileSync(pidFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function removePidFile() {
  const pidFile = getPidFilePath();
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

function isProcessRunning(pid) {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isTmuxInstalled() {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getOSType() {
  const plat = platform();
  if (plat === 'darwin') return 'macos';
  if (plat === 'win32') return 'windows';

  // Detect Linux distribution
  try {
    const release = execSync('cat /etc/os-release', { encoding: 'utf8' });
    if (/debian|ubuntu/i.test(release)) return 'debian';
    if (/fedora/i.test(release)) return 'fedora';
    if (/rhel|centos|rocky|alma/i.test(release)) return 'rhel';
    if (/arch/i.test(release)) return 'arch';
  } catch {
    // Fallback if /etc/os-release doesn't exist
  }

  return 'linux-generic';
}

function getTmuxErrorMessage(osType) {
  const baseMessage = 'Error: tmux is not installed\n\n' +
    'Devchain requires tmux for terminal session management.\n\n';

  const verifyMessage = '\nAfter installation, verify with:\n' +
    '  which tmux\n\n' +
    'For advanced users: bypass this check with DEVCHAIN_SKIP_TMUX_CHECK=1\n';

  switch (osType) {
    case 'macos':
      return baseMessage +
        'To install tmux on macOS, run:\n' +
        '  brew install tmux' +
        verifyMessage;

    case 'debian':
      return baseMessage +
        'To install tmux on Debian/Ubuntu, run:\n' +
        '  sudo apt update && sudo apt install tmux' +
        verifyMessage;

    case 'fedora':
      return baseMessage +
        'To install tmux on Fedora, run:\n' +
        '  sudo dnf install tmux' +
        verifyMessage;

    case 'rhel':
      return baseMessage +
        'To install tmux on RHEL/CentOS, run:\n' +
        '  sudo yum install tmux' +
        verifyMessage;

    case 'arch':
      return baseMessage +
        'To install tmux on Arch Linux, run:\n' +
        '  sudo pacman -S tmux' +
        verifyMessage;

    case 'linux-generic':
    default:
      return baseMessage +
        'To install tmux, use your distribution\'s package manager:\n' +
        '  - Debian/Ubuntu: sudo apt install tmux\n' +
        '  - Fedora:        sudo dnf install tmux\n' +
        '  - RHEL/CentOS:   sudo yum install tmux\n' +
        '  - Arch:          sudo pacman -S tmux\n\n' +
        'Or visit: https://github.com/tmux/tmux/wiki/Installing' +
        verifyMessage;
  }
}

async function runHostPreflightChecks(
  {
    enableOrchestration,
    opts,
    cli,
    log,
    isDetachedChild,
  },
  {
    execSyncFn = execSync,
    isTmuxInstalledFn = isTmuxInstalled,
    getOSTypeFn = getOSType,
    detectInstalledProvidersFn = detectInstalledProviders,
    ensureClaudeBypassPermissionsFn = ensureClaudeBypassPermissions,
    platformFn = platform,
  } = {},
) {
  const skipHostPreflights = shouldSkipHostPreflights(enableOrchestration);

  // Tmux preflight check
  const skipTmuxCheck = process.env.DEVCHAIN_SKIP_TMUX_CHECK === '1';
  if (skipHostPreflights) {
    if (opts.foreground) {
      log('info', 'Skipping tmux check in container mode', { skipReason: 'container_mode' });
    } else {
      cli.info('Skipping tmux check in container mode');
    }
  } else if (skipTmuxCheck) {
    if (opts.foreground) {
      log('info', 'Skipping tmux check (DEVCHAIN_SKIP_TMUX_CHECK=1)', { skipReason: 'env_var' });
    } else {
      cli.info('Skipping tmux check (DEVCHAIN_SKIP_TMUX_CHECK=1)');
    }
  } else {
    const osType = getOSTypeFn();

    if (osType === 'windows') {
      if (opts.foreground) {
        log('info', 'Skipping tmux check on Windows', { skipReason: 'windows', platform: 'win32' });
      } else {
        cli.info('Skipping tmux check on Windows');
      }
    } else {
      if (!opts.foreground) {
        cli.step('Checking tmux');
      }

      if (!isTmuxInstalledFn()) {
        if (opts.foreground) {
          log('error', 'tmux not found; aborting startup', { platform: osType, checked: 'which tmux' });
        } else {
          cli.stepDone('✗ not found');
          cli.blank();
        }
        console.error('\n' + getTmuxErrorMessage(osType));
        process.exit(1);
      }

      try {
        const tmuxPath = execSyncFn('which tmux', { encoding: 'utf8' }).trim();
        if (opts.foreground) {
          log('info', 'tmux found', { tmuxPath });
        } else {
          cli.stepDone('✓ found');
        }
      } catch {
        if (opts.foreground) {
          log('info', 'tmux check passed');
        } else {
          cli.stepDone('✓');
        }
      }
    }
  }

  // Provider detection (Linux/macOS only)
  const skipProviderCheck = process.env.DEVCHAIN_SKIP_PROVIDER_CHECK === '1';
  const plat = platformFn();
  if (skipHostPreflights) {
    if (opts.foreground) {
      log('info', 'Skipping provider check in container mode', { skipReason: 'container_mode' });
    } else {
      cli.info('Skipping provider check in container mode');
    }
  } else if (skipProviderCheck) {
    if (opts.foreground) {
      log('info', 'Skipping provider check (DEVCHAIN_SKIP_PROVIDER_CHECK=1)', {
        skipReason: 'env_var',
      });
    } else {
      cli.info('Skipping provider check (DEVCHAIN_SKIP_PROVIDER_CHECK=1)');
    }
  } else if (plat === 'win32') {
    if (opts.foreground) {
      log('info', 'Skipping provider check on Windows', { skipReason: 'windows' });
    } else {
      cli.info('Skipping provider check on Windows');
    }
  } else {
    if (!opts.foreground) {
      cli.step('Detecting providers');
    }

    const providersDetected = detectInstalledProvidersFn();
    if (providersDetected.size === 0) {
      const guide = [
        'No provider binaries detected on PATH. Install at least one provider and retry.',
        'Checked: "which codex", "which claude", and "which gemini"',
        'Examples:',
        '  - Install Codex:   npm i -g @openai/codex (example) or follow provider docs',
        '  - Install Claude:  npm i -g @anthropic-ai/claude-code (example) or follow provider docs',
        '  - Install Gemini:  npm i -g @google/gemini-cli (example) or follow provider docs',
        'Advanced: bypass with DEVCHAIN_SKIP_PROVIDER_CHECK=1',
      ].join('\n');
      if (opts.foreground) {
        log('error', 'No providers found; aborting startup', {
          checked: ['which codex', 'which claude', 'which gemini'],
        });
      } else {
        cli.stepDone('✗ none found');
        cli.blank();
      }
      console.error('\n' + guide + '\n');
      process.exit(1);
    }

    opts.__providersDetected = providersDetected;
    const providerNames = Array.from(providersDetected.keys());

    if (opts.foreground) {
      log('info', 'Detected providers', {
        providers: Array.from(providersDetected.entries()).map(([name, p]) => ({ name, path: p })),
      });
    } else {
      cli.stepDone(`✓ ${providerNames.join(', ')}`);
    }
  }

  // Prompt for Claude bypass permissions (parent only - requires stdin)
  // This runs BEFORE detach since it needs user interaction
  if (!isDetachedChild && opts.__providersDetected && opts.__providersDetected.has('claude')) {
    await ensureClaudeBypassPermissionsFn(cli);
  }
}

function getDevUiConfig(containerMode) {
  if (containerMode) {
    return {
      script: 'dev:ui',
      startMessage: 'Starting UI (dev mode)...',
      logLabel: 'UI dev server',
      url: 'http://127.0.0.1:5175',
    };
  }

  return {
    script: 'dev:ui',
    startMessage: 'Starting UI (dev mode)...',
    logLabel: 'UI dev server',
    url: 'http://127.0.0.1:5175',
  };
}

function applyContainerModeDefaults(containerMode, opts = {}, env = process.env) {
  if (!containerMode) {
    return;
  }

  const hasExplicitPortEnv = typeof env.PORT === 'string' && env.PORT.trim() !== '';
  if (!opts.port && !hasExplicitPortEnv) {
    env.PORT = '3000';
  }
}

function getPreferredDevApiPort(optsPort, containerMode, env = process.env) {
  if (optsPort) {
    return Number(optsPort);
  }
  if (containerMode) {
    return Number(env.PORT || 3000);
  }
  return 3000;
}

function getDevModeSpawnConfig({ containerMode, port, env = process.env }) {
  const ui = getDevUiConfig(containerMode);
  return {
    ui,
    nest: {
      command: 'pnpm',
      args: ['--filter', 'local-app', 'dev:api'],
      env: { ...env, PORT: String(port) },
    },
    vite: {
      command: 'pnpm',
      args: ['--filter', 'local-app', ui.script],
      env: { ...env, VITE_API_PORT: String(port) },
    },
  };
}

async function main(argv) {
  const program = new Command();
  const pkg = require('../package.json');
  program
    .name('devchain')
    .description('Devchain — Local-first AI agent orchestration')
    .version(pkg.version)
    .option('--container', 'Shorthand for "start --container"');

  const startCommand = program
    .command('start [args...]')
    .description('Start the Devchain local app')
    .option('-p, --port <number>', 'Port to listen on (default: 3000 or next free)')
    .option('-f, --foreground', 'Run in foreground (attached to terminal). Shows startup output with colors and spinners.')
    .option('-d, --detach', 'Run in background as a detached process (default). Use "devchain stop" to stop it.')
    .option('--no-open', 'Do not open a browser window')
    .option('--db <path>', 'Path to database directory or file (overrides DB_PATH/DB_FILENAME)')
    .option('--project <path>', 'Initial project root path; creates project if missing')
    .option(
      '--container',
      'Force orchestration startup (errors if Docker or git repository prerequisites are missing)'
    )
    .option(
      '--worktree-runtime <type>',
      '[internal] Worktree runtime context (container|process); bypasses singleton and interactive startup flows',
    )
    .option(
      '--log-level <level>',
      'Set log verbosity: error (errors only), warn, info, debug, or trace. ' +
      'Default: "error" (clean) in interactive mode, "info" in foreground. ' +
      'Respects LOG_LEVEL env var if set.'
    )
    .option('--dev', 'Development mode with hot reload (spawns nest --watch + vite)')
    .option('--internal-detached-child', '[internal] Marker for detached child process')
    .action(async (rawArgs, opts) => {
      const args = Array.isArray(rawArgs) ? [...rawArgs] : [];
      const usesContainerSubcommand = args[0] === 'container';
      if (usesContainerSubcommand) {
        args.shift();
      }
      const forceContainer = Boolean(
        opts.container || program.opts().container || usesContainerSubcommand,
      );
      let worktreeRuntimeType = null;
      try {
        worktreeRuntimeType = normalizeWorktreeRuntimeType(opts.worktreeRuntime);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Invalid --worktree-runtime value.');
        process.exit(1);
      }
      const worktreeRuntimeMode = isWorktreeRuntimeModeEnabled(worktreeRuntimeType);

      // Check if "help" was passed as an argument
      if (args && args.length > 0 && args[0] === 'help') {
        startCommand.help();
        return;
      }

      // Check if already running (skip for detached child - parent already checked)
      if (!opts.internalDetachedChild && !worktreeRuntimeMode) {
        const existingPid = readPidFile();
        if (existingPid && isProcessRunning(existingPid.pid)) {
          console.error(`Devchain is already running (PID ${existingPid.pid}, port ${existingPid.port})`);
          console.error(`Access it at: http://127.0.0.1:${existingPid.port}`);
          console.error('Use "devchain stop" to stop it first.');
          process.exit(1);
        }
        // Clean up stale PID file if process is not running
        if (existingPid && !isProcessRunning(existingPid.pid)) {
          removePidFile();
        }
      }

      // Normalize defaults for negatable options (Commander may leave undefined)
      if (typeof opts.open === 'undefined') {
        opts.open = worktreeRuntimeMode ? false : forceContainer ? false : true;
      }
      if (worktreeRuntimeMode) {
        opts.open = false;
      }
      // Detached mode by default, unless foreground is explicitly requested
      // Don't detach again if we're already the detached child process
      const isDetachedChild = Boolean(opts.internalDetachedChild);
      const shouldDetach = opts.foreground !== true && !isDetachedChild && !worktreeRuntimeMode;

      // Initialize interactive CLI (user-friendly output unless in foreground mode)
      const cli = new InteractiveCLI({
        interactive: !opts.foreground && !isDetachedChild && !worktreeRuntimeMode,
        colors: true,
        spinners: true
      });

      const log = (level, msg, extra) => {
        const entry = { level, msg, time: new Date().toISOString(), ...(extra || {}) };
        console.log(JSON.stringify(entry));
      };

      let enableOrchestration = false;
      if (worktreeRuntimeMode) {
        enableOrchestration = worktreeRuntimeType === 'container';
      } else {
        try {
          const orchestrationResolution = await resolveStartupOrchestration({
            forceContainer,
            env: process.env,
            warnFn: (message) => {
              if (opts.foreground) {
                log('warn', message);
              } else {
                cli.warn(message);
              }
            },
          });
          enableOrchestration = orchestrationResolution.enableOrchestration;
        } catch (error) {
          console.error(
            error instanceof Error
              ? error.message
              : 'Failed to resolve orchestration startup prerequisites.',
          );
          process.exit(1);
        }
      }

      applyContainerModeDefaults(enableOrchestration, opts, process.env);

      // Check for updates (parent process only, skip in dev mode)
      if (!isDetachedChild && !opts.dev && !worktreeRuntimeMode) {
        await checkForUpdates(cli, askYesNo);
      }

      // Show startup banner (interactive mode only)
      if (!opts.foreground && !worktreeRuntimeMode) {
        cli.blank();
        cli.info('Starting Devchain...');
        cli.blank();
      }

      if (!worktreeRuntimeMode) {
        await runHostPreflightChecks({
          enableOrchestration,
          opts,
          cli,
          log,
          isDetachedChild,
        });
      }

      const preferPort = getPreferredDevApiPort(opts.port, enableOrchestration, process.env);

      // In worktree runtime mode, bind strictly to the requested port.
      // getPort() silently picks a different port when the requested one is unavailable,
      // which causes the parent orchestrator to talk to the wrong instance.
      // Let NestJS fail fast with EADDRINUSE instead of silently rebinding.
      let port;
      if (worktreeRuntimeMode && preferPort) {
        port = preferPort;
      } else {
        port = await getPort({ port: preferPort });
      }

      // === DETACH POINT ===
      // All interactive prompts are done. Now spawn the detached child if needed.
      if (shouldDetach) {
        // Build child args, passing the selected port
        const childArgs = process.argv.slice(2)
          .filter(arg => arg !== '-d' && arg !== '--detach')
          .filter((arg, i, arr) => {
            // Remove existing --port and its value
            if (arg === '--port' || arg === '-p') return false;
            if (i > 0 && (arr[i - 1] === '--port' || arr[i - 1] === '-p')) return false;
            return true;
          });
        childArgs.push('--internal-detached-child');
        childArgs.push('--port', String(port));

        // Create log file for detached process output
        const devchainDir = join(homedir(), '.devchain');
        if (!existsSync(devchainDir)) {
          mkdirSync(devchainDir, { recursive: true });
        }
        const logFile = join(devchainDir, 'devchain.log');
        const out = openSync(logFile, 'a');
        const err = openSync(logFile, 'a');

        const child = spawn(process.execPath, [__filename, ...childArgs], {
          detached: true,
          stdio: ['ignore', out, err],
        });

        child.unref();

        cli.blank();
        cli.success(`Devchain starting in background (PID ${child.pid})`);
        cli.info(`Log file: ${logFile}`);
        cli.info('Use "devchain stop" to stop it.');
        process.exit(0);
      }

      // Apply env before requiring the server
      process.env.PORT = String(port);
      process.env.HOST = process.env.HOST || '127.0.0.1';
      process.env.NODE_ENV = process.env.NODE_ENV || 'production';
      const dbEnv = parseDbPath(opts.db);
      if (dbEnv.DB_PATH) process.env.DB_PATH = dbEnv.DB_PATH;
      if (dbEnv.DB_FILENAME) process.env.DB_FILENAME = dbEnv.DB_FILENAME;

      // Set log level with priority: --log-level flag > existing env/dotenv > mode defaults
      if (opts.logLevel) {
        // Highest priority: explicit CLI flag always wins
        process.env.LOG_LEVEL = opts.logLevel;
      } else if (!process.env.LOG_LEVEL) {
        // No LOG_LEVEL set anywhere: use mode defaults
        // Interactive mode: only show errors (clean output)
        // Foreground mode: show all logs (debugging)
        // Use Pino log levels: silent, fatal, error, warn, info, debug, trace
        process.env.LOG_LEVEL = opts.foreground ? 'info' : 'error';
      }
      // If LOG_LEVEL is already set in env or .env file, respect it

      // Development mode: spawn nest --watch + vite instead of requiring built server
      if (opts.dev) {
        process.env.NODE_ENV = 'development';
        // Show logs in dev mode (like dev:pure) unless explicitly set via --log-level
        if (!opts.logLevel) {
          process.env.LOG_LEVEL = 'info';
        }

        cli.info('Starting API (dev mode)...');
        cli.blank();

        // Helper to kill process group (all children)
        const killProcessGroup = (proc) => {
          if (!proc || !proc.pid) return;
          try {
            // On Unix, negative PID kills the entire process group
            if (platform() !== 'win32') {
              process.kill(-proc.pid, 'SIGTERM');
            } else {
              proc.kill('SIGTERM');
            }
          } catch (e) {
            // Process may already be dead
          }
        };

        // Spawn NestJS in watch mode (detached to create process group)
        const devSpawnConfig = getDevModeSpawnConfig({
          containerMode: enableOrchestration,
          port,
          env: process.env,
        });

        const nestProcess = spawn(devSpawnConfig.nest.command, devSpawnConfig.nest.args, {
          stdio: 'inherit',
          env: devSpawnConfig.nest.env,
          shell: true,
          detached: platform() !== 'win32', // Create process group on Unix
        });

        const baseUrl = `http://${process.env.HOST}:${port}`;

        // Wait for API to be ready (longer timeout for dev mode compilation)
        const ready = await waitForHealth(`${baseUrl}/health`, { timeoutMs: 60000 });
        if (!ready) {
          cli.error('API did not become ready in time');
          killProcessGroup(nestProcess);
          process.exit(1);
        }

        cli.blank();
        cli.success(`API ready at ${baseUrl}`);
        cli.info(`API docs: ${baseUrl}/api/docs`);

        // Ensure provider rows exist
        if (
          !worktreeRuntimeMode
          && !enableOrchestration
          && opts.__providersDetected
          && opts.__providersDetected.size > 0
        ) {
          await ensureProvidersInDb(baseUrl, opts.__providersDetected, log);
        }

        // Determine startup path for MCP validation
        const startupPath = opts.project && typeof opts.project === 'string' && opts.project.trim()
          ? opts.project.trim()
          : process.cwd();

        // Validate MCP for all providers
        if (!worktreeRuntimeMode && !enableOrchestration) {
          await validateMcpForProviders(baseUrl, cli, opts, log, startupPath);
        }

        // Note: Claude bypass prompt already handled before server start

        const devUiConfig = devSpawnConfig.ui;

        cli.blank();
        cli.info(devUiConfig.startMessage);

        // Spawn Vite for UI hot reload (pass API port, detached to create process group)
        const viteProcess = spawn(devSpawnConfig.vite.command, devSpawnConfig.vite.args, {
          stdio: 'inherit',
          env: devSpawnConfig.vite.env,
          shell: true,
          detached: platform() !== 'win32', // Create process group on Unix
        });

        cli.blank();
        cli.success('Development servers running');
        cli.info(`${devUiConfig.logLabel}: ${devUiConfig.url}`);
        cli.info(`API: ${baseUrl}`);
        cli.blank();

        // Write PID file for top-level runtime only
        if (!worktreeRuntimeMode) {
          writePidFile(port);
        }

        // Handle cleanup on exit - kill entire process groups
        const cleanup = () => {
          console.log('\nShutting down development servers...');
          killProcessGroup(nestProcess);
          killProcessGroup(viteProcess);
          if (!worktreeRuntimeMode) {
            removePidFile();
          }
          process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        // Keep process alive
        return;
      }

      // Ensure built server exists
      // Prefer bundled server in dist/server (copied at pack-time); fallback to workspace path.
      let serverEntry = join(__dirname, '..', 'dist', 'server', 'main.js');
      if (!existsSync(serverEntry)) {
        serverEntry = join(__dirname, '..', 'apps', 'local-app', 'dist', 'main.js');
      }
      if (!existsSync(serverEntry)) {
        log('error', 'Built server not found. Please build first (pnpm --filter local-app build).', {
          expected: serverEntry,
        });
        process.exit(1);
      }

      // Add bundled node_modules to NODE_PATH for @devchain/shared resolution
      const bundledNodeModules = join(__dirname, '..', 'dist', 'node_modules');
      if (existsSync(bundledNodeModules)) {
        process.env.NODE_PATH = process.env.NODE_PATH
          ? `${bundledNodeModules}:${process.env.NODE_PATH}`
          : bundledNodeModules;
        require('module').Module._initPaths();
      }

      // Start server (main.js bootstraps immediately)
      const spinner = opts.foreground ? null : cli.spinner('Starting server');
      if (spinner) spinner.start();

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(serverEntry);

      const baseUrl = `http://${process.env.HOST}:${port}`;
      const ready = await waitForHealth(`${baseUrl}/health`);
      if (!ready) {
        log('error', 'Server did not become ready in time', { url: baseUrl });
        if (spinner) {
          spinner.stop('✗ timeout');
          cli.blank();
        }
        process.exit(1);
      }

      if (spinner) {
        spinner.stop('✓ ready', true);
      }

      if (opts.foreground) {
        log('info', `Devchain is running at ${baseUrl}`);
        log('info', `API docs: ${baseUrl}/api/docs`);
        console.log(`\nDevchain is running at ${baseUrl}`);
        console.log(`API docs: ${baseUrl}/api/docs`);
        console.log('Press Ctrl+C to stop.\n');
      } else {
        cli.blank();
        cli.success(`Server ready at ${baseUrl}`);
        cli.info(`API docs: ${baseUrl}/api/docs`);
      }

      // Ensure provider rows exist (idempotent) before opening UI
      if (
        !worktreeRuntimeMode
        && !enableOrchestration
        && opts.__providersDetected
        && opts.__providersDetected.size > 0
      ) {
        await ensureProvidersInDb(baseUrl, opts.__providersDetected, log);
      }

      // Determine startup path for MCP validation and URL
      const startupPath = opts.project && typeof opts.project === 'string' && opts.project.trim()
        ? opts.project.trim()
        : process.cwd();

      // Validate MCP for all providers (with project context)
      if (!worktreeRuntimeMode && !enableOrchestration) {
        await validateMcpForProviders(baseUrl, cli, opts, log, startupPath);
      }

      // Note: Claude bypass prompt already handled before server start (in parent process for detach mode)

      // Determine URL to open based on project path
      let urlToOpen = baseUrl;
      try {
        const byPathUrl = `${baseUrl}/api/projects/by-path?path=${encodeURIComponent(startupPath)}`;
        const resByPath = await fetchWithTimeout(byPathUrl, {}, 2500);
        if (resByPath.ok) {
          const project = await resByPath.json();
          urlToOpen = `${baseUrl}/projects?projectId=${encodeURIComponent(project.id)}`;
          if (opts.foreground) {
            log('info', 'Resolved startup path to existing project', { startupPath, projectId: project.id });
          } else if (opts.open) {
            cli.info(`Opening project: ${project.name}`);
          }
        } else {
          // 404 or invalid — fall back to newProjectPath to prefill dialog
          urlToOpen = `${baseUrl}/projects?newProjectPath=${encodeURIComponent(startupPath)}`;
          if (opts.foreground) {
            log('info', 'No project at startup path; prefill create dialog', { startupPath });
          } else if (opts.open) {
            cli.info('Opening Projects page (create new project)');
          }
        }
      } catch (e) {
        // Network/timeouts: still prefer prefilled create dialog
        urlToOpen = `${baseUrl}/projects?newProjectPath=${encodeURIComponent(startupPath)}`;
        if (opts.foreground) {
          log('warn', 'Failed to resolve startup path; opening create dialog', {
            error: e instanceof Error ? e.message : String(e),
          });
        } else if (opts.open) {
          cli.info('Opening Projects page (create new project)');
        }
      }

      // Always print the App URL so the user can click/copy it
      if (opts.foreground) {
        console.log(`App: ${urlToOpen}`);
      } else {
        cli.info(`App: ${urlToOpen}`);
      }

      // Final blank line for clean output
      if (!opts.foreground) {
        cli.blank();
      }

      if (!worktreeRuntimeMode) {
        // Write PID file for stop command
        writePidFile(port);

        // Clean up PID file on exit (main.ts handles SIGINT/SIGTERM and graceful shutdown)
        process.on('exit', () => {
          removePidFile();
        });
      }

      if (opts.open) {
        if (!opts.foreground) {
          cli.info(`Opening ${urlToOpen}`);
        }
        try {
          const openOpts = resolveOpenOptions();
          await open(urlToOpen, openOpts);
        } catch (e) {
          // Fall back to printing URL without failing the process
          const msg = e instanceof Error ? e.message : String(e);
          if (opts.foreground) {
            log('warn', 'Failed to open browser automatically', { error: msg, url: urlToOpen });
          } else {
            cli.warn('Failed to open browser automatically');
            console.log(`Open this URL in your browser: ${urlToOpen}`);
          }
          // Linux fallback to xdg-open when available
          try {
            if (platform() === 'linux') {
              spawn('xdg-open', [urlToOpen], { stdio: 'ignore', detached: true }).unref();
            }
          } catch (_) {
            // ignore
          }
        }
      }
    });

  program
    .command('dev:image')
    .description('Rebuild worktree image for Docker-enabled development')
    .option('--restart', 'After rebuild, restart running worktrees via orchestrator API')
    .action(async (opts) => {
      try {
        ensureDockerAvailable();
        const imageRef = buildWorktreeImage();
        process.env.ORCHESTRATOR_CONTAINER_IMAGE = imageRef;

        if (!opts.restart) {
          console.log('Build complete. Running worktrees were not restarted.');
          process.exit(0);
        }

        const baseUrl = resolveDevchainApiBaseUrlForRestart();
        const ready = await waitForHealth(`${baseUrl}/health`, {
          timeoutMs: 5000,
          intervalMs: 250,
        });
        if (!ready) {
          throw new Error(
            `Image was rebuilt, but orchestrator is not reachable at ${baseUrl}. Start it and retry --restart.`,
          );
        }

        await restartRunningWorktrees({ baseUrl });
        process.exit(0);
      } catch (error) {
        console.error(
          error instanceof Error
            ? error.message
            : 'Failed to rebuild worktree image.',
        );
        process.exit(1);
      }
    });

  program
    .command('stop')
    .description('Stop the running Devchain instance')
    .action(async () => {
      const pidData = readPidFile();

      if (!pidData) {
        console.log('No running Devchain instance found.');
        process.exit(1);
      } else {
        const { pid, port } = pidData;

        if (!isProcessRunning(pid)) {
          console.log(`Devchain process (PID ${pid}) is not running. Cleaning up stale PID file.`);
          removePidFile();
          process.exit(1);
        } else {
          console.log(`Stopping Devchain (PID ${pid}, port ${port})...`);

          try {
            process.kill(pid, 'SIGTERM');
          } catch (err) {
            console.error('Failed to stop Devchain:', err.message);
            process.exit(1);
          }

          let stopped = false;
          for (let attempts = 0; attempts <= 20; attempts += 1) {
            if (!isProcessRunning(pid)) {
              stopped = true;
              break;
            }
            await sleep(100);
          }

          if (!stopped) {
            console.log('Graceful shutdown timed out, forcing...');
            try {
              process.kill(pid, 'SIGKILL');
            } catch (err) {
              console.error('Failed to stop Devchain:', err.message);
              process.exit(1);
            }
          }

          removePidFile();
          console.log(stopped ? 'Devchain stopped successfully.' : 'Devchain stopped (forced).');
        }
      }

      process.exit(0);
    });

  await program.parseAsync(normalizeCliArgv(argv));
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  normalizeCliArgv,
  __test__: {
    ensureDockerAvailable,
    isDockerAvailable,
    deriveRepoRootFromGit,
    isInsideGitRepo,
    ensureProjectGitignoreIncludesDevchain,
    shouldSkipHostPreflights,
    runHostPreflightChecks,
    getDevUiConfig,
    applyContainerModeDefaults,
    getPreferredDevApiPort,
    getDevModeSpawnConfig,
    hasWorktreeImageLocally,
    buildWorktreeImage,
    resolveDevchainApiBaseUrlForRestart,
    restartRunningWorktrees,
    ensureWorktreeImage,
    bootstrapContainerMode,
    ensureWorktreeImageRefFromPackageVersion,
    formatOrchestrationDetectionFailureReason,
    resolveStartupOrchestration,
    normalizeWorktreeRuntimeType,
    isWorktreeRuntimeModeEnabled,
    detectGlobalPackageManager,
  },
};
