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
const { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } = require('fs');
const { homedir, platform } = require('os');
const { spawn, execSync } = require('child_process');
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
        cli.info('Updating devchain...');
        try {
          // Try without sudo first (works for nvm/fnm/Windows)
          // Use npm install -g instead of update -g (update can remove packages)
          execSync(`npm install -g ${packageName}@latest`, { stdio: 'inherit' });
          cli.success('Update complete! Please restart devchain.');
          process.exit(0);
        } catch (e) {
          // On Linux/Mac, might need sudo for system npm
          if (platform() !== 'win32') {
            cli.info('Retrying with sudo...');
            try {
              execSync(`sudo npm install -g ${packageName}@latest`, { stdio: 'inherit' });
              cli.success('Update complete! Please restart devchain.');
              process.exit(0);
            } catch (e2) {
              cli.error('Update failed. You can manually run: sudo npm install -g ' + packageName);
            }
          } else {
            cli.error('Update failed. You can manually run: npm install -g ' + packageName);
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
    .option('--internal-detached-child', '[internal] Marker for detached child process')
    .action(async (args, opts) => {
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
        opts.open = true;
      }
      // Detached mode by default, unless foreground is explicitly requested
      // Don't detach again if we're already the detached child process
      const isDetachedChild = opts.internalDetachedChild;
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

      // Check for updates (parent process only, skip in dev mode)
      if (!isDetachedChild && !opts.dev) {
        await checkForUpdates(cli, askYesNo);
      }

      // Show startup banner (interactive mode only)
      if (!opts.foreground) {
        cli.blank();
        cli.info('Starting Devchain...');
        cli.blank();
      }

      // Tmux preflight check
      const skipTmuxCheck = process.env.DEVCHAIN_SKIP_TMUX_CHECK === '1';
      if (skipTmuxCheck) {
        if (opts.foreground) {
          log('info', 'Skipping tmux check (DEVCHAIN_SKIP_TMUX_CHECK=1)', { skipReason: 'env_var' });
        } else {
          cli.info('Skipping tmux check (DEVCHAIN_SKIP_TMUX_CHECK=1)');
        }
      } else {
        const osType = getOSType();

        if (osType === 'windows') {
          if (opts.foreground) {
            log('info', 'Skipping tmux check on Windows', { skipReason: 'windows', platform: 'win32' });
          } else {
            cli.info('Skipping tmux check on Windows');
          }
        } else {
          // Interactive: show step
          if (!opts.foreground) {
            cli.step('Checking tmux');
          }

          // Check if tmux is installed
          if (!isTmuxInstalled()) {
            if (opts.foreground) {
              log('error', 'tmux not found; aborting startup', { platform: osType, checked: 'which tmux' });
            } else {
              cli.stepDone('✗ not found');
              cli.blank();
            }
            console.error('\n' + getTmuxErrorMessage(osType));
            process.exit(1);
          }

          // tmux found, log success
          try {
            const tmuxPath = execSync('which tmux', { encoding: 'utf8' }).trim();
            if (opts.foreground) {
              log('info', 'tmux found', { tmuxPath });
            } else {
              cli.stepDone('✓ found');
            }
          } catch {
            // Shouldn't happen since we just checked, but handle gracefully
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
      const plat = platform();
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
        // Interactive: show step
        if (!opts.foreground) {
          cli.step('Detecting providers');
        }

        const providersDetected = detectInstalledProviders();
        if (providersDetected.size === 0) {
          // Provide guidance and exit prior to server startup
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

        // stash on opts for later ensure step after server ready
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
        await ensureClaudeBypassPermissions(cli);
      }

      const preferPort = opts.port ? Number(opts.port) : 3000;
      const port = await getPort({ port: preferPort });

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
        const nestProcess = spawn('pnpm', ['--filter', 'local-app', 'dev:api'], {
          stdio: 'inherit',
          env: { ...process.env, PORT: String(port) },
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
        if (opts.__providersDetected && opts.__providersDetected.size > 0) {
          await ensureProvidersInDb(baseUrl, opts.__providersDetected, log);
        }

        // Determine startup path for MCP validation
        const startupPath = opts.project && typeof opts.project === 'string' && opts.project.trim()
          ? opts.project.trim()
          : process.cwd();

        // Validate MCP for all providers
        await validateMcpForProviders(baseUrl, cli, opts, log, startupPath);

        // Note: Claude bypass prompt already handled before server start

        cli.blank();
        cli.info('Starting UI (dev mode)...');

        // Spawn Vite for UI hot reload (pass API port, detached to create process group)
        const viteProcess = spawn('pnpm', ['--filter', 'local-app', 'dev:ui'], {
          stdio: 'inherit',
          env: { ...process.env, VITE_API_PORT: String(port) },
          shell: true,
          detached: platform() !== 'win32', // Create process group on Unix
        });

        cli.blank();
        cli.success('Development servers running');
        cli.info(`UI: http://127.0.0.1:5175 (Vite dev server)`);
        cli.info(`API: ${baseUrl}`);
        cli.blank();

        // Write PID file
        writePidFile(port);

        // Handle cleanup on exit - kill entire process groups
        const cleanup = () => {
          console.log('\nShutting down development servers...');
          killProcessGroup(nestProcess);
          killProcessGroup(viteProcess);
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
      if (opts.__providersDetected && opts.__providersDetected.size > 0) {
        await ensureProvidersInDb(baseUrl, opts.__providersDetected, log);
      }

      // Determine startup path for MCP validation and URL
      const startupPath = opts.project && typeof opts.project === 'string' && opts.project.trim()
        ? opts.project.trim()
        : process.cwd();

      // Validate MCP for all providers (with project context)
      await validateMcpForProviders(baseUrl, cli, opts, log, startupPath);

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

      // Write PID file for stop command
      writePidFile(port);

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
    .command('stop')
    .description('Stop the running Devchain instance')
    .action(() => {
      const pidData = readPidFile();

      if (!pidData) {
        console.log('No running Devchain instance found.');
        process.exit(1);
      }

      const { pid, port } = pidData;

      if (!isProcessRunning(pid)) {
        console.log(`Devchain process (PID ${pid}) is not running. Cleaning up stale PID file.`);
        removePidFile();
        process.exit(1);
      }

      console.log(`Stopping Devchain (PID ${pid}, port ${port})...`);

      try {
        process.kill(pid, 'SIGTERM');

        // Wait a bit for graceful shutdown
        let attempts = 0;
        const checkInterval = setInterval(() => {
          attempts++;
          if (!isProcessRunning(pid)) {
            clearInterval(checkInterval);
            removePidFile();
            console.log('Devchain stopped successfully.');
            process.exit(0);
          }

          if (attempts > 20) {
            // After 2 seconds, force kill
            clearInterval(checkInterval);
            console.log('Graceful shutdown timed out, forcing...');
            try {
              process.kill(pid, 'SIGKILL');
              removePidFile();
              console.log('Devchain stopped (forced).');
            } catch (err) {
              console.error('Failed to stop Devchain:', err.message);
              process.exit(1);
            }
            process.exit(0);
          }
        }, 100);
      } catch (err) {
        console.error('Failed to stop Devchain:', err.message);
        process.exit(1);
      }
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
