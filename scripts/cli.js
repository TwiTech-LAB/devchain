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
const { pathToFileURL } = require('url');
const { InteractiveCLI } = require('./lib/interactive-cli');
const { runHostInstallCommand } = require('./lib/host-install');
const { runHostApiKeyReset } = require('./lib/host-api-key');
const { QUEUE_NAME, runExclusive } = require('./lib/exclusive-run');
const readline = require('readline');

// Resolve @devchain/shared across packed (dist/node_modules) and workspace (packages/shared
// or apps/local-app/node_modules) layouts. Node's ESM resolver only walks node_modules from
// this script's location, where the workspace symlink does not exist, so dynamic imports must
// use a concrete file:// URL.
let _sharedModuleUrlCache;
function resolveSharedModuleSpecifier() {
  if (_sharedModuleUrlCache) return _sharedModuleUrlCache;
  const candidates = [
    join(__dirname, '..', 'dist', 'node_modules', '@devchain', 'shared', 'index.js'),
    join(__dirname, '..', 'packages', 'shared', 'dist', 'index.js'),
    join(__dirname, '..', 'node_modules', '@devchain', 'shared', 'dist', 'index.js'),
    join(__dirname, '..', 'apps', 'local-app', 'node_modules', '@devchain', 'shared', 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      _sharedModuleUrlCache = pathToFileURL(candidate).href;
      return _sharedModuleUrlCache;
    }
  }
  return '@devchain/shared';
}

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

  // A synchronous bootstrap stall can hold the event loop past the nominal
  // deadline. Make one bounded attempt because the in-process server may have
  // finished binding while the watchdog could not run.
  try {
    const res = await fetchWithTimeout(url, {}, 1000);
    return res.ok;
  } catch (_) {
    return false;
  }
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

// The parent process checks once; dev mode and --no-update-check skip it (a local
// build would otherwise be offered the public version).
function shouldCheckForUpdates(opts) {
  return !opts.internalDetachedChild && !opts.dev && opts.updateCheck !== false;
}

async function checkForUpdates(cli, askYesNoFn) {
  // Without a terminal (a systemd service) nobody can answer, and an unattended
  // update would move the installed version away from the one chosen for it.
  if (!process.stdin.isTTY) return;
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
  const opencodePath = isBinaryInstalled('opencode');
  const agyPath = isBinaryInstalled('agy');
  const copilotPath = isBinaryInstalled('copilot');
  if (codexPath) detected.set('codex', codexPath);
  if (claudePath) detected.set('claude', claudePath);
  if (opencodePath) detected.set('opencode', opencodePath);
  if (agyPath) detected.set('agy', agyPath);
  if (copilotPath) detected.set('copilot', copilotPath);
  return detected; // Map<name, absolutePath>
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // End of input would read as Ctrl+D and exit; without a terminal take the default.
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
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
  const settingsPath = join(homedir(), '.claude', 'settings.json');

  // Read existing settings if present
  let settings = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Invalid JSON — start fresh
    settings = {};
  }

  // Skip silently if already enabled
  if (settings.skipDangerousModePermissionPrompt === true) {
    return;
  }

  // Show explanation and prompt
  cli.blank();
  cli.info('Claude requires permission approval for each command by default.');
  cli.info('Enabling bypass mode allows devchain to auto-approve commands.');

  const confirmed = await askYesNo('Enable bypass permissions mode for Claude?', true);
  cli.blank();

  if (confirmed) {
    settings.skipDangerousModePermissionPrompt = true;
    try {
      const settingsDir = join(homedir(), '.claude');
      if (!existsSync(settingsDir)) {
        mkdirSync(settingsDir, { recursive: true });
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      cli.success('Bypass permissions mode enabled in ~/.claude/settings.json');
    } catch (error) {
      cli.warn('Failed to update ~/.claude/settings.json - you may need to enable manually');
    }
  } else {
    cli.info('Skipped - you can enable this later in ~/.claude/settings.json');
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

function writePidFile(port, host) {
  const pidFile = getPidFilePath();
  const data = JSON.stringify({ pid: process.pid, port, host: host || '127.0.0.1', timestamp: Date.now() });
  writeFileSync(pidFile, data, 'utf8');
}

function readPidFile() {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) {
    return null;
  }
  try {
    const data = readFileSync(pidFile, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && !parsed.host) parsed.host = '127.0.0.1';
    return parsed;
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

// A claimed VM has the claim record; home never does.
function getMachineRole(env = process.env) {
  const etcDir = env.DEVCHAIN_HOST_ETC_DIR || '/etc/devchain-host';
  return existsSync(join(etcDir, 'claim.json')) ? 'remote VM' : 'home';
}

const SUDO_CHECK_TIMEOUT_MS = 5000;

/**
 * Whether an agent can run `sudo` here without a person. `sudo -n` never
 * prompts: it fails when a password would be needed.
 */
function getSudoStatus({
  platformName = platform(),
  getuid = process.getuid,
  execFileSyncFn = execFileSync,
} = {}) {
  if (platformName === 'win32') return 'not available on Windows';
  if (typeof getuid === 'function' && getuid() === 0) return 'yes (running as root)';
  try {
    execFileSyncFn('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: SUDO_CHECK_TIMEOUT_MS });
    return 'yes (no password)';
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'not installed';
    if (error && error.code === 'ETIMEDOUT') return 'unknown (sudo did not answer in 5 s)';
    return 'needs a password';
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
  // Tmux preflight check
  const skipTmuxCheck = process.env.DEVCHAIN_SKIP_TMUX_CHECK === '1';
  if (skipTmuxCheck) {
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
  if (skipProviderCheck) {
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
        'Checked: "which codex", "which claude", "which opencode", "which agy", and "which copilot"',
        'Examples:',
        '  - Install Codex:    npm i -g @openai/codex (example) or follow provider docs',
        '  - Install Claude:   npm i -g @anthropic-ai/claude-code (example) or follow provider docs',
        '  - Install agy:      curl -fsSL https://antigravity.google/cli/install.sh | bash or follow provider docs',
        '  - Install OpenCode: go install github.com/opencode-ai/opencode@latest or follow provider docs',
        'Advanced: bypass with DEVCHAIN_SKIP_PROVIDER_CHECK=1',
      ].join('\n');
      if (opts.foreground) {
        log('error', 'No providers found; aborting startup', {
          checked: [
            'which codex',
            'which claude',
            'which opencode',
            'which agy',
            'which copilot',
          ],
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

function getDevUiConfig() {
  return {
    script: 'dev:ui',
    startMessage: 'Starting UI (dev mode)...',
    logLabel: 'UI dev server',
    url: 'http://127.0.0.1:5175',
  };
}

function getPreferredDevApiPort(optsPort) {
  if (optsPort) {
    return Number(optsPort);
  }
  return 3000;
}

function getDevModeSpawnConfig({ port, env = process.env }) {
  const ui = getDevUiConfig();
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
    .version(pkg.version);

  const startCommand = program
    .command('start [args...]')
    .description('Start the Devchain local app')
    .option('-p, --port <number>', 'Port to listen on (default: 3000 or next free)')
    .option('--host <address>', 'Host/bind address (default: 127.0.0.1; use 0.0.0.0 for all IPv4 interfaces, :: for all IPv6)')
    .option('-f, --foreground', 'Run in foreground (attached to terminal). Shows startup output with colors and spinners.')
    .option('-d, --detach', 'Run in background as a detached process (default). Use "devchain stop" to stop it.')
    .option('--no-open', 'Do not open a browser window')
    .option('--db <path>', 'Path to database directory or file (overrides DB_PATH/DB_FILENAME)')
    .option('--project <path>', 'Initial project root path; creates project if missing')
    .option(
      '--log-level <level>',
      'Set log verbosity: error (errors only), warn, info, debug, or trace. ' +
      'Default: "error" (clean) in interactive mode, "info" in foreground. ' +
      'Respects LOG_LEVEL env var if set.'
    )
    .option('--dev', 'Development mode with hot reload (spawns nest --watch + vite)')
    .option('--no-cloud', 'Disable Cloud and Notifications UI features for this run')
    .option('--no-update-check', 'Do not check npm for a newer devchain at start')
    .option('--internal-detached-child', '[internal] Marker for detached child process')
    .action(async (rawArgs, opts) => {
      const { HostResolver } = await import(resolveSharedModuleSpecifier());
      const args = Array.isArray(rawArgs) ? [...rawArgs] : [];
      // Cloud UI is on by default. Commander defaults opts.cloud to `true`
      // and sets it to `false` only when --no-cloud is passed.
      if (opts.cloud === false) {
        process.env.DEVCHAIN_CLOUD_UI_ENABLED = '0';
      }

      // Check if "help" was passed as an argument
      if (args && args.length > 0 && args[0] === 'help') {
        startCommand.help();
        return;
      }

      // Check if already running (skip for detached child - parent already checked)
      if (!opts.internalDetachedChild) {
        const existingPid = readPidFile();
        if (existingPid && isProcessRunning(existingPid.pid)) {
          console.error(`Devchain is already running (PID ${existingPid.pid}, port ${existingPid.port})`);
          console.error(`Access it at: ${HostResolver.buildDisplayUrls({ host: existingPid.host || '127.0.0.1', port: existingPid.port }).primary}`);
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
        opts.open = true;
      }
      // Detached mode by default, unless foreground is explicitly requested
      // Don't detach again if we're already the detached child process
      const isDetachedChild = Boolean(opts.internalDetachedChild);
      const shouldDetach = opts.foreground !== true && !isDetachedChild;

      // Initialize interactive CLI (user-friendly output unless in foreground mode)
      const cli = new InteractiveCLI({
        interactive: !opts.foreground && !isDetachedChild,
        colors: true,
        spinners: true
      });

      const log = (level, msg, extra) => {
        const entry = { level, msg, time: new Date().toISOString(), ...(extra || {}) };
        console.log(JSON.stringify(entry));
      };

      if (shouldCheckForUpdates(opts)) {
        await checkForUpdates(cli, askYesNo);
      }

      // Show startup banner (interactive mode only)
      if (!opts.foreground) {
        cli.blank();
        cli.info('Starting Devchain...');
        cli.blank();
      }

      await runHostPreflightChecks({
        opts,
        cli,
        log,
        isDetachedChild,
      });

      const preferPort = getPreferredDevApiPort(opts.port);
      const port = await getPort({ port: preferPort });

      // Resolve effective host before detach so child inherits normalized HOST env.
      // The --host flag also flows through childArgs (detach filter only strips --port
      // and --detach), so the child receives the effective host via two independent paths.
      let effectiveHost;
      try {
        effectiveHost = HostResolver.normalizeHost(opts.host ?? process.env.HOST ?? '');
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
      process.env.HOST = effectiveHost;

      // Security warning for non-loopback bind (before detach so parent terminal sees it)
      if (HostResolver.isNonLoopbackHost(effectiveHost)) {
        console.error('');
        console.error(`⚠  DevChain is binding to ${effectiveHost}. This hand-started instance has`);
        console.error('   no caller authentication; the API, terminals, MCP, and project files');
        console.error('   are exposed to anyone who can reach this address. The VM API key');
        console.error('   protects claimed remote VMs, not a hand-started instance. Use only on');
        console.error('   a trusted network, VPN, or behind firewall rules.');
        if (opts.dev) {
          console.error('');
          console.error('   Note: --dev mode runs the UI on a separate Vite dev server bound to');
          console.error('   127.0.0.1 only. Remote access affects the API server only. For full');
          console.error('   remote access including the UI dev server, use production mode');
          console.error('   (no --dev flag).');
        }
        console.error('');
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

      // Apply env before requiring the server (HOST already set pre-detach)
      process.env.PORT = String(port);
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

        // Signal entire process group (all children). On Unix, a negative PID
        // targets the PG; on Windows we fall back to signalling the child directly.
        const signalProcessGroup = (proc, signal) => {
          if (!proc || !proc.pid) return;
          try {
            if (platform() !== 'win32') {
              process.kill(-proc.pid, signal);
            } else {
              proc.kill(signal);
            }
          } catch (e) {
            // Process may already be dead
          }
        };
        const killProcessGroup = (proc) => signalProcessGroup(proc, 'SIGTERM');

        // Resolve when the child process emits 'exit' (or immediately if it
        // already exited). Lets cleanup await actual termination.
        const waitForExit = (proc) => new Promise((resolve) => {
          if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
            resolve();
            return;
          }
          proc.once('exit', () => resolve());
        });

        const waitWithTimeout = (promise, ms) => Promise.race([
          promise,
          new Promise((resolve) => setTimeout(resolve, ms)),
        ]);

        // Spawn NestJS in watch mode (detached to create process group)
        const devSpawnConfig = getDevModeSpawnConfig({
          port,
          env: process.env,
        });

        const nestProcess = spawn(devSpawnConfig.nest.command, devSpawnConfig.nest.args, {
          stdio: 'inherit',
          env: devSpawnConfig.nest.env,
          shell: true,
          detached: platform() !== 'win32', // Create process group on Unix
        });

        const internalBaseUrl = HostResolver.buildInternalBaseUrl({ host: effectiveHost, port });

        const displayUrl = HostResolver.buildDisplayUrls({ host: effectiveHost, port }).primary;

        // Wait for API to be ready (longer timeout for dev mode compilation)
        const ready = await waitForHealth(`${internalBaseUrl}/health`, { timeoutMs: 60000 });
        if (!ready) {
          cli.error('API did not become ready in time');
          killProcessGroup(nestProcess);
          process.exit(1);
        }

        cli.blank();
        cli.success(`API ready at ${displayUrl}`);
        cli.info(`API docs: ${displayUrl}/api/docs`);

        // Ensure provider rows exist
        if (opts.__providersDetected && opts.__providersDetected.size > 0) {
          await ensureProvidersInDb(internalBaseUrl, opts.__providersDetected, log);
        }

        // Determine startup path for MCP validation
        const startupPath = opts.project && typeof opts.project === 'string' && opts.project.trim()
          ? opts.project.trim()
          : process.cwd();

        // Validate MCP for all providers
        await validateMcpForProviders(internalBaseUrl, cli, opts, log, startupPath);

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
        cli.info(`API: ${displayUrl}`);
        cli.blank();

        // Write PID file for stop command
        writePidFile(port, effectiveHost);

        // Handle cleanup on exit - kill entire process groups, then wait for
        // children to actually exit before removing the PID file and exiting.
        // Re-entrancy: a second Ctrl+C escalates to SIGKILL immediately instead
        // of waiting again.
        let cleanupStarted = false;
        const SIGTERM_GRACE_MS = 5000;
        const SIGKILL_GRACE_MS = 2000;
        const cleanup = async () => {
          if (cleanupStarted) {
            // Second signal: stop being polite
            signalProcessGroup(nestProcess, 'SIGKILL');
            signalProcessGroup(viteProcess, 'SIGKILL');
            return;
          }
          cleanupStarted = true;
          console.log('\nShutting down development servers...');

          const nestExited = waitForExit(nestProcess);
          const viteExited = waitForExit(viteProcess);

          killProcessGroup(nestProcess);
          killProcessGroup(viteProcess);

          await waitWithTimeout(Promise.all([nestExited, viteExited]), SIGTERM_GRACE_MS);

          // Anything still alive after the grace period gets SIGKILL.
          const stillAlive = [nestProcess, viteProcess].filter(
            (p) => p && p.exitCode === null && p.signalCode === null,
          );
          if (stillAlive.length > 0) {
            console.log(`Forcing shutdown of ${stillAlive.length} unresponsive process(es)...`);
            for (const p of stillAlive) signalProcessGroup(p, 'SIGKILL');
            await waitWithTimeout(Promise.all([nestExited, viteExited]), SIGKILL_GRACE_MS);
          }

          removePidFile();
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

      const internalBaseUrl = HostResolver.buildInternalBaseUrl({ host: effectiveHost, port });
      const displayUrl = HostResolver.buildDisplayUrls({ host: effectiveHost, port }).primary;
      const ready = await waitForHealth(`${internalBaseUrl}/health`);
      if (!ready) {
        log('error', 'Server did not become ready in time', { url: internalBaseUrl });
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
        log('info', `Devchain is running at ${displayUrl}`);
        log('info', `API docs: ${displayUrl}/api/docs`);
        console.log(`\nDevchain is running at ${displayUrl}`);
        console.log(`API docs: ${displayUrl}/api/docs`);
        console.log('Press Ctrl+C to stop.\n');
      } else {
        cli.blank();
        cli.success(`Server ready at ${displayUrl}`);
        cli.info(`API docs: ${displayUrl}/api/docs`);
      }

      // Ensure provider rows exist (idempotent) before opening UI
      if (opts.__providersDetected && opts.__providersDetected.size > 0) {
        await ensureProvidersInDb(internalBaseUrl, opts.__providersDetected, log);
      }

      // Determine startup path for MCP validation and URL
      const startupPath = opts.project && typeof opts.project === 'string' && opts.project.trim()
        ? opts.project.trim()
        : process.cwd();

      // Validate MCP for all providers (with project context)
      await validateMcpForProviders(internalBaseUrl, cli, opts, log, startupPath);

      // Note: Claude bypass prompt already handled before server start (in parent process for detach mode)

      // Determine URL to open based on project path
      let urlToOpen = displayUrl;
      try {
        const byPathUrl = `${internalBaseUrl}/api/projects/by-path?path=${encodeURIComponent(startupPath)}`;
        const resByPath = await fetchWithTimeout(byPathUrl, {}, 2500);
        if (resByPath.ok) {
          const project = await resByPath.json();
          urlToOpen = `${displayUrl}/projects?projectId=${encodeURIComponent(project.id)}`;
          if (opts.foreground) {
            log('info', 'Resolved startup path to existing project', { startupPath, projectId: project.id });
          } else if (opts.open) {
            cli.info(`Opening project: ${project.name}`);
          }
        } else {
          // 404 or invalid — fall back to newProjectPath to prefill dialog
          urlToOpen = `${displayUrl}/projects?newProjectPath=${encodeURIComponent(startupPath)}`;
          if (opts.foreground) {
            log('info', 'No project at startup path; prefill create dialog', { startupPath });
          } else if (opts.open) {
            cli.info('Opening Projects page (create new project)');
          }
        }
      } catch (e) {
        // Network/timeouts: still prefer prefilled create dialog
        urlToOpen = `${displayUrl}/projects?newProjectPath=${encodeURIComponent(startupPath)}`;
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

      // Write PID file for stop command
      writePidFile(port, effectiveHost);

      // Clean up PID file on exit (main.ts handles SIGINT/SIGTERM and graceful shutdown)
      process.on('exit', () => {
        removePidFile();
      });

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
    .command('queue <name> [command...]')
    .usage('<name> -- <command> [args…]')
    .description('Run a command when no other command holds this queue for the OS user')
    .action(async (name, commandArgs, _options, queueCommand) => {
      if (!QUEUE_NAME.test(name)) {
        queueCommand.error(`queue name must match ${QUEUE_NAME.source}.`);
      }
      const input = program.rawArgs.slice(2);
      if (input[2] !== '--' || commandArgs.length === 0) {
        queueCommand.error('usage: devchain queue <name> -- <command> [args…]');
      }
      process.exitCode = await runExclusive({
        name,
        command: commandArgs[0],
        args: commandArgs.slice(1),
      });
    });

  const host = program.command('host').description('Manage DevChain hosts');

  host
    .command('install')
    .description('Install DevChain on an Ubuntu or Debian VM over SSH')
    .option('--address <address>', 'VM address (for example, 192.168.1.20:3000)')
    .option('--ssh-user <user>', 'SSH account on the VM')
    .option('--password-stdin', 'Read the SSH password from one line of stdin')
    .option('--key <path>', 'SSH private key file')
    .option('--passphrase-stdin', 'Read the SSH key passphrase from one line of stdin')
    .option('--sudo-password-stdin', 'Read the optional sudo password from one line of stdin')
    .option('--projects <project-ids...>', 'Project ids to include in the disk estimate')
    .option('--no-docker', 'Do not install Docker Engine and Compose on the VM (installed by default)')
    .option(
      '--provider-auth <provider=choice>',
      'Provider login choice: skip, generate, or reuse:<entry-id> (repeatable)',
      (value, previous) => [...(previous || []), value],
    )
    .action(async (options) => {
      const exitCode = await runHostInstallCommand(options, {
        getLocalApiBaseUrl: async () => {
          const pidData = readPidFile();
          if (!pidData || !isProcessRunning(pidData.pid)) return null;
          const { HostResolver } = await import(resolveSharedModuleSpecifier());
          return HostResolver.buildInternalBaseUrl({
            host: pidData.host || '127.0.0.1',
            port: pidData.port,
          });
        },
      });
      process.exitCode = exitCode;
    });

  host
    .command('api-key')
    .description('Manage this VM host API key')
    .command('reset')
    .description(
      'Generate a new host API key, store its SHA-256 hash on this VM, and print the key once',
    )
    .action(() => {
      process.exitCode = runHostApiKeyReset();
    });

  program
    .command('status')
    .description(
      'Show whether this machine is home or a remote DevChain VM, and whether sudo works without a password',
    )
    .action(() => {
      console.log(getMachineRole());
      console.log(`sudo: ${getSudoStatus()}`);
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
        const { pid, port, host } = pidData;

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

  await program.parseAsync(argv);
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  __test__: {
    waitForHealth,
    runHostPreflightChecks,
    getDevUiConfig,
    getPreferredDevApiPort,
    getDevModeSpawnConfig,
    detectGlobalPackageManager,
    detectInstalledProviders,
    checkForUpdates,
    shouldCheckForUpdates,
    askYesNo,
    getMachineRole,
    getSudoStatus,
  },
};
