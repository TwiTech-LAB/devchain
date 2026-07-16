'use strict';

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { MobileIngressFixture } = require('./mobile-ingress-fixture');
const { sampleSystem } = require('./procfs');
const { captureTargetProvenance } = require('./provenance');

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const TRANSPORT_STALL_CONTROL_EVENT = 'memory-soak:stall-engine-transport';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function acknowledgeApplicationHeartbeat(socket, envelope) {
  if (envelope?.type !== 'ping') return false;
  socket.emit('pong');
  return true;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parsePositivePid(value, context) {
  const pid = Number(String(value).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${context} must be a positive integer; received ${JSON.stringify(value)}`);
  }
  return pid;
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateProcessGroup(child, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    return;
  }
  if (await waitForChildExit(child, timeoutMs)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await waitForChildExit(child, 2_000);
}

class DisposableAppFixture {
  constructor(options) {
    if (
      options.historyLimit !== undefined &&
      (!Number.isSafeInteger(options.historyLimit) || options.historyLimit <= 0)
    ) {
      throw new Error('Fixture historyLimit must be a positive integer');
    }
    this.options = options;
    this.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-app-soak-'));
    this.homeDir = path.join(this.tempRoot, 'home');
    this.storageDir = path.join(this.tempRoot, 'storage');
    this.workspaceDir = path.join(this.tempRoot, 'workspace');
    this.tmuxRoot = path.join(this.tempRoot, 'tmux');
    this.runtimePortFile = path.join(this.tempRoot, 'runtime-port.json');
    this.logFile = path.join(this.tempRoot, 'app.log');
    this.runtimeToken = crypto.randomUUID();
    this.sessionName = options.uuidSession
      ? crypto.randomUUID()
      : `fixture-${process.pid}-${options.seed}`;
    this.projectId = options.uuidSession ? crypto.randomUUID() : null;
    this.agentId = options.uuidSession ? crypto.randomUUID() : null;
    this.metricsFile = path.join(this.tempRoot, 'scratch-session-metrics.json');
    this.anchorMetricsFile = path.join(this.tempRoot, 'workload-anchor-metrics.json');
    this.transportStallStateFile = path.join(this.tempRoot, 'transport-stall-state.json');
    this.lifecycleStateFile = path.join(this.tempRoot, 'lifecycle-resource-state.json');
    this.transportStallToken = options.enableTransportStall ? crypto.randomUUID() : null;
    this.appProcess = null;
    this.socket = null;
    this.sockets = new Set();
    this.appPids = new Set();
    this.generatorPaused = false;
    this.generatorOutputPaused = false;
    this.port = null;
    this.targetProvenance = null;
    this.tmuxServerPid = null;
    this.panePid = null;
    this.generatorPid = null;
    this.socketEvidence = {
      connected: false,
      runtimeTokenVerified: false,
      handshakeTokenPresented: false,
      subscribed: false,
      seedObserved: false,
      receivedTypes: [],
    };
    this.samples = [];
    this.cleanup = null;
    this.mobileIngress = options.enableMobileIngress
      ? new MobileIngressFixture({ sessionId: null, projectId: this.projectId })
      : null;

    for (const directory of [this.homeDir, this.storageDir, this.workspaceDir, this.tmuxRoot]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(this.tmuxRoot, 0o700);

    this.childEnv = { ...process.env };
    delete this.childEnv.TMUX;
    delete this.childEnv.TMUX_PANE;
    Object.assign(this.childEnv, {
      HOME: this.homeDir,
      DB_PATH: this.storageDir,
      DB_FILENAME: 'devchain.db',
      DEVCHAIN_CLOUD_UI_ENABLED: 'false',
      DEVCHAIN_MODE: 'normal',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      NODE_ENV: 'production',
      PORT: '0',
      REPO_ROOT: this.workspaceDir,
      RUNTIME_PORT_FILE: this.runtimePortFile,
      RUNTIME_TOKEN: this.runtimeToken,
      TMUX_TMPDIR: this.tmuxRoot,
      WORKTREES_DATA_ROOT: path.join(this.tempRoot, 'worktrees-data'),
      WORKTREES_ROOT: path.join(this.tempRoot, 'worktrees'),
    });
    if (this.transportStallToken) {
      const preload = path.join(__dirname, '..', 'fixtures', 'stall-engine-transport.js');
      const existingNodeOptions = this.childEnv.NODE_OPTIONS?.trim();
      this.childEnv.NODE_OPTIONS = [existingNodeOptions, `--require=${preload}`]
        .filter(Boolean)
        .join(' ');
      this.childEnv.MEMORY_SOAK_TRANSPORT_STALL_TOKEN = this.transportStallToken;
      this.childEnv.MEMORY_SOAK_TRANSPORT_STALL_STATE_FILE = this.transportStallStateFile;
    }
    if (this.options.enableLifecycleProbe) {
      const preload = path.join(__dirname, '..', 'fixtures', 'lifecycle-resource-probe.js');
      const existingNodeOptions = this.childEnv.NODE_OPTIONS?.trim();
      this.childEnv.NODE_OPTIONS = [existingNodeOptions, `--require=${preload}`]
        .filter(Boolean)
        .join(' ');
      this.childEnv.MEMORY_SOAK_LIFECYCLE_STATE_FILE = this.lifecycleStateFile;
    }
    if (this.mobileIngress) {
      Object.assign(this.childEnv, {
        MEMORY_SOAK_BACKGROUND_RATE: String(this.options.backgroundRate),
        MEMORY_SOAK_CHUNK_BYTES: String(this.options.chunkBytes),
        MEMORY_SOAK_FOREGROUND_RATE: String(this.options.foregroundRate),
        MEMORY_SOAK_METRICS_FILE: this.metricsFile,
        MEMORY_SOAK_SEED: String(this.options.seed),
      });
    }
  }

  runTmux(args, options = {}) {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      env: this.childEnv,
      input: options.input,
      stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: options.timeout || 10_000,
    }).trim();
  }

  async startMobileIngress() {
    if (!this.mobileIngress) throw new Error('Mobile ingress is not enabled for this fixture');
    const baseUrl = await this.mobileIngress.start();
    this.childEnv.BRIDGE_SERVICE_URL = baseUrl;
    this.childEnv.IDENTITY_SERVICE_URL = baseUrl;
    return baseUrl;
  }

  async startApp() {
    if (!fs.existsSync(this.options.appEntry)) {
      throw new Error(
        `Disposable app entry not found: ${this.options.appEntry}; build local-app or pass --app-entry`,
      );
    }
    fs.rmSync(this.runtimePortFile, { force: true });
    const logFd = fs.openSync(this.logFile, 'a');
    try {
      this.appProcess = spawn(process.execPath, [this.options.appEntry], {
        cwd: this.options.appCwd,
        detached: true,
        env: this.childEnv,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd);
    }
    this.appProcess.unref();
    this.appPids.add(this.appProcess.pid);

    const portInfo = await waitFor(() => {
      if (!isProcessAlive(this.appProcess.pid)) {
        const logTail = fs.existsSync(this.logFile)
          ? fs.readFileSync(this.logFile, 'utf8').slice(-2_000)
          : '';
        throw new Error(`Disposable app exited before readiness${logTail ? `: ${logTail}` : ''}`);
      }
      const parsed = readJson(this.runtimePortFile);
      return parsed?.runtimeToken === this.runtimeToken && Number.isSafeInteger(parsed.port)
        ? parsed
        : null;
    }, this.options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS);
    if (!portInfo) throw new Error('Disposable app did not publish a matching runtime port');
    this.port = portInfo.port;

    const runtimeVerified = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/runtime`);
        if (!response.ok) return null;
        const body = await response.json();
        return body.runtimeToken === this.runtimeToken;
      } catch {
        return null;
      }
    }, this.options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS);
    if (!runtimeVerified) throw new Error('Disposable app runtime-token authentication failed');

    this.socketEvidence.runtimeTokenVerified = true;
    this.targetProvenance = captureTargetProvenance(this.appProcess.pid);
  }

  async stopApp() {
    await terminateProcessGroup(this.appProcess);
  }

  async restartApp() {
    await this.stopApp();
    await this.startApp();
  }

  async createScratchSession() {
    const bootstrapName = this.options.historyLimit
      ? `${this.sessionName}-history-bootstrap`
      : null;
    if (bootstrapName) {
      this.runTmux([
        'new-session',
        '-d',
        '-s',
        bootstrapName,
        process.execPath,
        '-e',
        'setTimeout(() => {}, 60000)',
      ]);
      this.runTmux(['set-option', '-g', 'history-limit', String(this.options.historyLimit)]);
    }
    try {
      this.runTmux([
        'new-session',
        '-d',
        '-s',
        this.sessionName,
        process.execPath,
        '--expose-gc',
        path.join(__dirname, '..', 'output-generator.js'),
        '--seed',
        String(this.options.seed),
        '--foreground-rate',
        String(this.options.foregroundRate),
        '--background-rate',
        String(this.options.backgroundRate),
        '--chunk-bytes',
        String(this.options.chunkBytes),
        '--metrics',
        this.metricsFile,
      ]);
    } finally {
      if (bootstrapName) {
        try {
          this.runTmux(['kill-session', '-t', `=${bootstrapName}`]);
        } catch {
          // Target-session creation failures can also stop the bootstrap server.
        }
      }
    }
    this.runTmux(['set-option', '-t', `=${this.sessionName}:`, 'status', 'off']);
    this.tmuxServerPid = parsePositivePid(
      this.runTmux(['display-message', '-p', '#{pid}']),
      'fixture tmux server PID',
    );
    this.panePid = parsePositivePid(
      this.runTmux(['display-message', '-p', '-t', `=${this.sessionName}:`, '#{pane_pid}']),
      'fixture pane PID',
    );
    const ready = await waitFor(() => {
      const metrics = readJson(this.metricsFile);
      return metrics?.seed === this.options.seed && metrics.outputBytes > 0 ? metrics : null;
    }, 5_000);
    if (!ready) throw new Error('Scratch tmux session did not emit deterministic output');
    this.generatorPid = parsePositivePid(ready.pid, 'fixture generator PID');

    const database = new Database(path.join(this.storageDir, 'devchain.db'));
    try {
      database.pragma('busy_timeout = 5000');
      const now = new Date().toISOString();
      let sessionAgentId = null;
      if (this.projectId && this.agentId) {
        database
          .prepare(
            `INSERT INTO projects
               (id, name, root_path, is_template, is_private, created_at, updated_at)
             VALUES (?, ?, ?, 0, 1, ?, ?)`,
          )
          .run(this.projectId, 'Memory soak scratch project', this.workspaceDir, now, now);
        let provider = database.prepare('SELECT id FROM providers ORDER BY id LIMIT 1').get();
        if (!provider) {
          provider = { id: crypto.randomUUID() };
          database
            .prepare(
              `INSERT INTO providers
                 (id, name, mcp_configured, one_million_context_enabled, created_at, updated_at)
               VALUES (?, 'claude', 0, 0, ?, ?)`,
            )
            .run(provider.id, now, now);
        }
        let providerConfig = database
          .prepare(
            'SELECT id, profile_id FROM profile_provider_configs ORDER BY position, id LIMIT 1',
          )
          .get();
        if (!providerConfig) {
          const profileId = crypto.randomUUID();
          const providerConfigId = crypto.randomUUID();
          database
            .prepare(
              `INSERT INTO agent_profiles
                 (id, project_id, name, created_at, updated_at)
               VALUES (?, ?, 'Memory soak mobile profile', ?, ?)`,
            )
            .run(profileId, this.projectId, now, now);
          database
            .prepare(
              `INSERT INTO profile_provider_configs
                 (id, profile_id, provider_id, name, position, created_at, updated_at)
               VALUES (?, ?, ?, 'Memory soak provider', 0, ?, ?)`,
            )
            .run(providerConfigId, profileId, provider.id, now, now);
          providerConfig = { id: providerConfigId, profile_id: profileId };
        }
        database
          .prepare(
            `INSERT INTO agents
               (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.agentId,
            this.projectId,
            providerConfig.profile_id,
            providerConfig.id,
            'Memory soak mobile fixture',
            now,
            now,
          );
        sessionAgentId = this.agentId;
      }
      database
        .prepare(
          `INSERT INTO sessions
             (id, agent_id, tmux_session_id, status, started_at, provider_name_at_launch, created_at, updated_at)
           VALUES (?, ?, ?, 'running', ?, 'claude', ?, ?)`,
        )
        .run(this.sessionName, sessionAgentId, this.sessionName, now, now, now);
    } finally {
      database.close();
    }
  }

  async createWorkloadAnchor() {
    const anchorName = `lifecycle-anchor-${process.pid}-${this.options.seed}`;
    this.runTmux([
      'new-session',
      '-d',
      '-s',
      anchorName,
      process.execPath,
      '--expose-gc',
      path.join(__dirname, '..', 'output-generator.js'),
      '--seed',
      String(this.options.seed),
      '--foreground-rate',
      String(this.options.foregroundRate),
      '--background-rate',
      String(this.options.backgroundRate),
      '--chunk-bytes',
      String(this.options.chunkBytes),
      '--metrics',
      this.anchorMetricsFile,
    ]);
    this.runTmux(['set-option', '-t', `=${anchorName}:`, 'status', 'off']);
    this.tmuxServerPid = parsePositivePid(
      this.runTmux(['display-message', '-p', '#{pid}']),
      'fixture tmux server PID',
    );
    this.panePid = parsePositivePid(
      this.runTmux(['display-message', '-p', '-t', `=${anchorName}:`, '#{pane_pid}']),
      'fixture pane PID',
    );
    const ready = await waitFor(() => {
      const metrics = readJson(this.anchorMetricsFile);
      return metrics?.seed === this.options.seed && metrics.outputBytes > 0 ? metrics : null;
    }, 5_000);
    if (!ready) throw new Error('Lifecycle workload anchor emitted no deterministic output');
    this.generatorPid = parsePositivePid(ready.pid, 'fixture generator PID');
    this.anchorSessionName = anchorName;
    return this.workloadAnchorEvidence();
  }

  workloadAnchorEvidence() {
    const metrics = readJson(this.anchorMetricsFile) || {};
    return {
      sessionName: this.anchorSessionName,
      tmuxServerPid: this.tmuxServerPid,
      panePid: this.panePid,
      generatorPid: this.generatorPid,
      deterministicSeed: this.options.seed,
      outputBytes: metrics.outputBytes || 0,
    };
  }

  createMobileScratchProject() {
    if (!this.mobileIngress || !this.projectId || !this.agentId) {
      throw new Error('Mobile scratch project requires the mobile fixture');
    }
    const database = new Database(path.join(this.storageDir, 'devchain.db'));
    try {
      database.pragma('busy_timeout = 5000');
      const now = new Date().toISOString();
      const providerRuntime = path.join(__dirname, '..', 'fixtures', 'mobile-provider-runtime.js');
      database
        .prepare(
          `INSERT INTO projects
             (id, name, root_path, is_template, is_private, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1, ?, ?)`,
        )
        .run(this.projectId, 'Memory soak mobile project', this.workspaceDir, now, now);
      let provider = database.prepare("SELECT id FROM providers WHERE name = 'claude'").get();
      if (provider) {
        database
          .prepare("UPDATE providers SET bin_path = ?, updated_at = ? WHERE name = 'claude'")
          .run(providerRuntime, now);
      } else {
        provider = { id: crypto.randomUUID() };
        database
          .prepare(
            `INSERT INTO providers
               (id, name, bin_path, mcp_configured, one_million_context_enabled, created_at, updated_at)
             VALUES (?, 'claude', ?, 0, 0, ?, ?)`,
          )
          .run(provider.id, providerRuntime, now, now);
      }
      const profileId = crypto.randomUUID();
      const providerConfigId = crypto.randomUUID();
      database
        .prepare(
          `INSERT INTO agent_profiles
             (id, project_id, name, created_at, updated_at)
           VALUES (?, ?, 'Memory soak mobile profile', ?, ?)`,
        )
        .run(profileId, this.projectId, now, now);
      database
        .prepare(
          `INSERT INTO profile_provider_configs
             (id, profile_id, provider_id, name, position, created_at, updated_at)
           VALUES (?, ?, ?, 'Memory soak provider', 0, ?, ?)`,
        )
        .run(providerConfigId, profileId, provider.id, now, now);
      database
        .prepare(
          `INSERT INTO agents
             (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.agentId,
          this.projectId,
          profileId,
          providerConfigId,
          'Memory soak mobile fixture',
          now,
          now,
        );
    } finally {
      database.close();
    }
  }

  async adoptLaunchedSession(sessionId) {
    const launched = await waitFor(() => {
      const database = new Database(path.join(this.storageDir, 'devchain.db'), { readonly: true });
      try {
        database.pragma('busy_timeout = 5000');
        return (
          database
            .prepare(
              `SELECT tmux_session_id AS tmuxSessionId
               FROM sessions WHERE id = ? AND status = 'running'`,
            )
            .get(sessionId) || null
        );
      } finally {
        database.close();
      }
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!launched?.tmuxSessionId) throw new Error('Mobile launch did not create a running session');
    this.sessionName = sessionId;
    this.tmuxSessionName = launched.tmuxSessionId;
    this.tmuxServerPid = parsePositivePid(
      this.runTmux(['display-message', '-p', '#{pid}']),
      'fixture tmux server PID',
    );
    this.panePid = parsePositivePid(
      this.runTmux(['display-message', '-p', '-t', `=${this.tmuxSessionName}:`, '#{pane_pid}']),
      'fixture pane PID',
    );
    const metrics = await waitFor(() => {
      const value = readJson(this.metricsFile);
      return value?.seed === this.options.seed && value.outputBytes > 0 ? value : null;
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!metrics) throw new Error('Mobile-launched provider emitted no deterministic output');
    this.generatorPid = parsePositivePid(metrics.pid, 'fixture generator PID');
  }

  async waitForLaunchedSessionId() {
    const row = await waitFor(() => {
      const database = new Database(path.join(this.storageDir, 'devchain.db'), { readonly: true });
      try {
        database.pragma('busy_timeout = 5000');
        return (
          database
            .prepare(
              `SELECT id FROM sessions
               WHERE agent_id = ? AND status = 'running'
               ORDER BY started_at DESC LIMIT 1`,
            )
            .get(this.agentId) || null
        );
      } finally {
        database.close();
      }
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!row?.id) throw new Error('Mobile launch did not persist a running scratch session');
    return row.id;
  }

  prepareLifecycleLaunch() {
    fs.rmSync(this.metricsFile, { force: true });
  }

  async adoptLifecycleSession(sessionId) {
    const launched = await waitFor(() => {
      const database = new Database(path.join(this.storageDir, 'devchain.db'), { readonly: true });
      try {
        database.pragma('busy_timeout = 5000');
        return (
          database
            .prepare(
              `SELECT tmux_session_id AS tmuxSessionId
               FROM sessions WHERE id = ? AND status = 'running'`,
            )
            .get(sessionId) || null
        );
      } finally {
        database.close();
      }
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!launched?.tmuxSessionId) throw new Error('Lifecycle launch created no running session');
    const panePid = await waitFor(() => {
      try {
        const value = this.runTmux([
          'display-message',
          '-p',
          '-t',
          `=${launched.tmuxSessionId}:`,
          '#{pane_pid}',
        ]);
        return /^[1-9]\d*$/.test(value) ? Number(value) : null;
      } catch {
        return null;
      }
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!panePid) throw new Error('Lifecycle launch did not publish a pane PID');
    const provider = await waitFor(() => {
      const metrics = readJson(this.metricsFile);
      return metrics?.seed === this.options.seed && isProcessAlive(metrics.pid) ? metrics : null;
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!provider) throw new Error('Lifecycle provider emitted no deterministic output');
    return {
      sessionId,
      tmuxSessionName: launched.tmuxSessionId,
      panePid,
      generatorPid: parsePositivePid(provider.pid, 'lifecycle generator PID'),
      outputBytes: provider.outputBytes || 0,
    };
  }

  sessionLifecycleStatus(sessionId) {
    const database = new Database(path.join(this.storageDir, 'devchain.db'), { readonly: true });
    try {
      database.pragma('busy_timeout = 5000');
      return (
        database
          .prepare(
            `SELECT status, ended_at AS endedAt, updated_at AS updatedAt
             FROM sessions WHERE id = ?`,
          )
          .get(sessionId) || null
      );
    } finally {
      database.close();
    }
  }

  ptyFdCount() {
    const fdRoot = `/proc/${this.appProcess.pid}/fd`;
    let count = 0;
    for (const entry of fs.readdirSync(fdRoot)) {
      try {
        const target = fs.readlinkSync(path.join(fdRoot, entry));
        if (target === '/dev/ptmx' || target.startsWith('/dev/pts/')) count += 1;
      } catch {
        // File descriptors can close between readdir and readlink.
      }
    }
    return count;
  }

  async lifecycleResources(sessionId) {
    const probe = readJson(this.lifecycleStateFile);
    const metrics = await this.fetchMetrics();
    const session = probe?.session?.sessionId === sessionId ? probe.session : null;
    return {
      sessionId,
      status: this.sessionLifecycleStatus(sessionId)?.status ?? null,
      ptyFdCount: this.ptyFdCount(),
      registryEntry: session?.registryEntry ?? null,
      frameListener: session?.frameListener ?? null,
      ptySession: session?.ptySession ?? null,
      frameBuffer: session?.frameBuffer ?? null,
      globalCounts: probe?.counts ?? null,
      metricCounts: {
        ptySessions: metrics.pty?.activeSessions ?? null,
        frameBuffers: metrics.frameBuffers?.sessions ?? null,
        frameBufferFrames: metrics.frameBuffers?.totalFrames ?? null,
        frameBufferBytes: metrics.frameBuffers?.bytesEstimated ?? null,
      },
    };
  }

  async attachSocketClient() {
    const client = await this.connectSocketClient();
    this.socket = client.socket;
    Object.assign(this.socketEvidence, {
      connected: client.connected,
      handshakeTokenPresented: true,
      subscribed: client.subscribed,
      seedObserved: client.seedData.includes(`seed=${this.options.seed}`),
      receivedTypes: client.receivedTypes,
    });
  }

  async authenticateMobileIngress() {
    if (!this.mobileIngress) throw new Error('Mobile ingress is not enabled for this fixture');
    const response = await fetch(`http://127.0.0.1:${this.port}/api/auth/cloud/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: this.mobileIngress.accessToken,
        refreshToken: this.mobileIngress.refreshToken,
      }),
    });
    if (!response.ok) {
      throw new Error(`Disposable mobile authentication failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    await this.mobileIngress.waitForReady(
      this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS,
    );
    return {
      localAppAccepted: body.userId === this.mobileIngress.userId,
      credentials: this.mobileIngress.credentialEvidence(),
    };
  }

  sessionActivity() {
    const database = new Database(path.join(this.storageDir, 'devchain.db'), { readonly: true });
    try {
      database.pragma('busy_timeout = 5000');
      return (
        database
          .prepare(
            `SELECT last_activity_at AS lastActivityAt,
                    activity_state AS activityState,
                    updated_at AS updatedAt
             FROM sessions WHERE id = ?`,
          )
          .get(this.sessionName) || null
      );
    } finally {
      database.close();
    }
  }

  async connectSocketClient({
    sessionId = this.sessionName,
    lastSequence,
    expectSeed = true,
    cols,
    rows = 24,
    autoCompleteResync = true,
  } = {}) {
    const socket = io(`http://127.0.0.1:${this.port}`, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { runtimeToken: this.runtimeToken },
    });
    this.sockets.add(socket);
    const client = {
      socket,
      socketId: null,
      connected: false,
      subscribed: false,
      subscribedPayload: null,
      receivedTypes: [],
      envelopes: [],
      seedChunks: [],
      seedData: '',
      dataFrames: [],
      resyncRequired: null,
      pendingResyncCompletions: [],
      resyncCompletions: [],
    };

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Disposable Socket.IO client did not complete subscribe: ${JSON.stringify({ subscribed: client.subscribed, receivedTypes: client.receivedTypes })}`,
          ),
        );
      }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
      const finishIfComplete = () => {
        if (!client.subscribed || (expectSeed && client.seedChunks.length === 0)) return;
        clearTimeout(timeout);
        socket.off('connect_error', onConnectError);
        resolve();
      };
      const onConnectError = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      socket.on('connect_error', onConnectError);
      socket.on('message', (envelope) => {
        if (!envelope || typeof envelope !== 'object') return;
        acknowledgeApplicationHeartbeat(socket, envelope);
        client.envelopes.push(envelope);
        if (typeof envelope.type === 'string') {
          client.receivedTypes.push(envelope.type);
        }
        if (envelope.type === 'subscribed') {
          client.subscribed = true;
          client.subscribedPayload = envelope.payload;
        }
        if (envelope.type === 'resync_required') client.resyncRequired = envelope.payload;
        if (envelope.type === 'seed_ansi' && typeof envelope.payload?.data === 'string') {
          client.seedChunks.push(envelope.payload);
          client.seedData += envelope.payload.data;
          if (
            envelope.payload.chunk === envelope.payload.totalChunks - 1 &&
            Number.isSafeInteger(envelope.payload.recoveryEpoch) &&
            Number.isSafeInteger(envelope.payload.capturedSequence)
          ) {
            const completion = {
              sessionId,
              recoveryEpoch: envelope.payload.recoveryEpoch,
              capturedSequence: envelope.payload.capturedSequence,
            };
            if (autoCompleteResync) this.completeResync(client, completion);
            else client.pendingResyncCompletions.push(completion);
          }
        }
        if (envelope.type === 'data' && Number.isSafeInteger(envelope.payload?.sequence)) {
          client.dataFrames.push({ ...envelope.payload, receivedAtMs: Date.now() });
        }
        finishIfComplete();
      });
      socket.on('connect', () => {
        client.connected = true;
        client.socketId = socket.id;
        socket.emit('terminal:subscribe', {
          sessionId,
          cols: cols ?? Math.max(80, this.options.chunkBytes + 32),
          rows,
          ...(lastSequence !== undefined ? { lastSequence } : {}),
        });
      });
    });
    return client;
  }

  completeResync(client, completion = client.pendingResyncCompletions.shift()) {
    if (!completion) throw new Error('Socket client has no pending resync completion');
    const evidence = {
      ...completion,
      envelopeIndex: client.envelopes.length,
      completedAt: new Date().toISOString(),
    };
    client.resyncCompletions.push(evidence);
    client.socket.emit('terminal:resync_complete', completion);
    return evidence;
  }

  async stallClientTransport(client) {
    if (!this.transportStallToken) {
      throw new Error('Transport-stall control is not enabled for this fixture');
    }
    fs.rmSync(this.transportStallStateFile, { force: true });
    client.socket.emit(TRANSPORT_STALL_CONTROL_EVENT, { token: this.transportStallToken });
    const state = await waitFor(() => {
      const value = readJson(this.transportStallStateFile);
      return value?.socketId === client.socketId ? value : null;
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!state) throw new Error('Disposable app did not activate the requested transport stall');
    return state;
  }

  async waitForClient(client, predicate, context) {
    const result = await waitFor(
      () => (predicate(client) ? client : null),
      this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS,
    );
    if (!result) throw new Error(`Timed out waiting for ${context}`);
    return result;
  }

  disconnectClient(client) {
    // Teardown owns registry clearing so its cleanup evidence includes clients disconnected earlier.
    client.socket.disconnect();
    client.socket.removeAllListeners();
  }

  async fetchMetrics() {
    const response = await fetch(`http://127.0.0.1:${this.port}/api/debug/metrics`);
    if (!response.ok) throw new Error(`Metrics request failed with HTTP ${response.status}`);
    return response.json();
  }

  async waitForOutputChunks(minimumChunks) {
    const metrics = await waitFor(() => {
      const value = readJson(this.metricsFile);
      return value?.chunks >= minimumChunks ? value : null;
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!metrics) throw new Error(`Scratch generator did not reach ${minimumChunks} chunks`);
    return metrics;
  }

  generatorMetrics() {
    return readJson(this.metricsFile) || {};
  }

  tmuxHistoryState() {
    const [size, limit] = this.runTmux([
      'display-message',
      '-p',
      '-t',
      `=${this.sessionName}:`,
      '#{history_size} #{history_limit}',
    ])
      .split(/\s+/)
      .map(Number);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(limit)) {
      throw new Error('Scratch tmux history state is unavailable');
    }
    return { size, limit };
  }

  async warmTmuxHistoryToLimit() {
    const initial = this.tmuxHistoryState();
    const initialMetrics = this.generatorMetrics();
    const requiredChunks = Math.max(32, initial.limit - initial.size + 32);
    this.resumeGenerator();
    await this.waitForOutputChunks((initialMetrics.chunks ?? 0) + requiredChunks);
    await this.pauseGeneratorOutput();
    const historyFill = await this.fillTmuxHistoryToLimit();
    await this.quiesceGenerator();
    const generated = this.generatorMetrics();
    const finalMarker = `n=${generated.chunks - 1}`;
    const rendered = await waitFor(() => {
      const history = this.tmuxHistoryState();
      const capture = this.captureStrict(this.sessionName, history.limit);
      return history.size === history.limit &&
        capture.includes(finalMarker) &&
        (!historyFill.lastMarker || capture.includes(historyFill.lastMarker))
        ? history
        : null;
    }, this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS);
    if (!rendered) {
      throw new Error('Scratch tmux history did not reach its bounded rendered-state baseline');
    }
    return {
      criterion: 'history-at-limit-output-paused-and-final-generator-marker-rendered',
      initialHistoryLines: initial.size,
      historyLines: rendered.size,
      historyLimit: rendered.limit,
      historyFillLines: historyFill.lines,
      historyFillMarker: historyFill.lastMarker,
      historyFillMaximumAttempts: historyFill.maximumAttempts,
      historyFillTimeoutMs: historyFill.timeoutMs,
      generatorChunks: generated.chunks,
      generatorOutputBytes: generated.outputBytes,
      generatorChurnCycles: generated.churnCycles,
      finalMarker,
    };
  }

  async fillTmuxHistoryToLimit() {
    const initial = this.tmuxHistoryState();
    let history = initial;
    let lines = 0;
    let lastMarker = null;
    const maximumAttempts = initial.limit - initial.size;
    const timeoutMs = Math.min(this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS, 10_000);
    const deadlineAt = Date.now() + timeoutMs;
    while (history.size < history.limit) {
      if (lines >= maximumAttempts || Date.now() >= deadlineAt) {
        throw new Error('Scratch tmux history fill exceeded its configured bound');
      }
      const previousFlushed = this.generatorMetrics().historyFillFlushedCount ?? 0;
      const previousSize = history.size;
      this.signalGenerator('SIGXFSZ');
      const flushed = await waitFor(
        () => {
          const metrics = this.generatorMetrics();
          return metrics.historyFillFlushedCount > previousFlushed ? metrics : null;
        },
        Math.min(2_000, Math.max(1, deadlineAt - Date.now())),
      );
      if (!flushed) throw new Error('Scratch generator did not flush its history fill marker');
      const advanced = await waitFor(
        () => {
          const candidate = this.tmuxHistoryState();
          return candidate.size > previousSize ? candidate : null;
        },
        Math.min(2_000, Math.max(1, deadlineAt - Date.now())),
      );
      if (!advanced) throw new Error('Scratch tmux history did not advance after a fill marker');
      history = advanced;
      lines += 1;
      lastMarker = flushed.lastHistoryFillMarker;
    }
    if (history.size !== history.limit) {
      throw new Error('Scratch tmux history fill did not stop at its configured bound');
    }
    return {
      initialHistoryLines: initial.size,
      lines,
      lastMarker,
      maximumAttempts,
      timeoutMs,
      ...history,
    };
  }

  async emitLatencyMarker() {
    const previousCount = this.generatorMetrics().latencyMarkerCount ?? 0;
    this.signalGenerator('SIGURG');
    const metrics = await waitFor(() => {
      const value = this.generatorMetrics();
      return value.latencyMarkerCount > previousCount ? value : null;
    }, 2_000);
    if (!metrics) throw new Error('Scratch generator did not emit a latency marker');
    return {
      emittedAtMs: metrics.lastLatencyMarkerAtMs,
      marker: `latency=${metrics.lastLatencyMarkerAtMs}`,
    };
  }

  signalGenerator(signal) {
    if (!isProcessAlive(this.generatorPid)) throw new Error('Scratch generator is not alive');
    process.kill(this.generatorPid, signal);
  }

  pauseGenerator() {
    if (this.generatorPaused) return;
    this.signalGenerator('SIGSTOP');
    this.generatorPaused = true;
  }

  async quiesceGenerator() {
    if (this.generatorPaused) return;
    this.signalGenerator('SIGUSR1');
    const background = await waitFor(
      () => (this.generatorMetrics().mode === 'background' ? true : null),
      2_000,
    );
    if (!background) throw new Error('Scratch generator did not enter background mode');
    await sleep(100);
    this.pauseGenerator();
  }

  async pauseGeneratorOutput() {
    if (this.generatorOutputPaused) return;
    const previousMarkerCount = this.generatorMetrics().pauseMarkerFlushedCount ?? 0;
    this.signalGenerator('SIGTTIN');
    const paused = await waitFor(() => {
      const metrics = this.generatorMetrics();
      return metrics.outputPaused === true && metrics.pauseMarkerFlushedCount > previousMarkerCount
        ? metrics
        : null;
    }, 2_000);
    if (!paused) throw new Error('Scratch generator did not pause output at a burst boundary');
    this.generatorOutputPaused = true;
    return { marker: paused.lastPauseMarker, markerCount: paused.pauseMarkerFlushedCount };
  }

  resumeGenerator() {
    let resumed = false;
    if (this.generatorPaused) {
      this.signalGenerator('SIGCONT');
      this.generatorPaused = false;
      resumed = true;
    }
    if (this.generatorOutputPaused) {
      this.signalGenerator('SIGTTOU');
      this.generatorOutputPaused = false;
      resumed = true;
    }
    if (!resumed) return;
    this.signalGenerator('SIGUSR2');
  }

  async churnGeneratorAndPause() {
    const previousChurnCycles = this.generatorMetrics().churnCycles ?? 0;
    this.resumeGenerator();
    const churned = await waitFor(
      () => (this.generatorMetrics().churnCycles > previousChurnCycles ? true : null),
      2_000,
    );
    this.pauseGenerator();
    if (!churned) throw new Error('Scratch generator did not complete its churn cycle');
  }

  async churnGeneratorWhileOutputPaused() {
    if (!this.generatorOutputPaused) {
      throw new Error('Scratch generator output must remain paused during retained-state churn');
    }
    const previousChurnCycles = this.generatorMetrics().churnCycles ?? 0;
    if (this.generatorPaused) {
      this.signalGenerator('SIGCONT');
      this.generatorPaused = false;
    }
    this.signalGenerator('SIGUSR2');
    const churned = await waitFor(
      () => (this.generatorMetrics().churnCycles > previousChurnCycles ? true : null),
      2_000,
    );
    this.pauseGenerator();
    if (!churned) throw new Error('Scratch generator did not complete its churn cycle');
  }

  captureStrict(sessionName = this.sessionName, tailLines = 0) {
    sessionName =
      sessionName === this.sessionName && this.tmuxSessionName ? this.tmuxSessionName : sessionName;
    return this.runTmux([
      'capture-pane',
      '-p',
      '-S',
      `-${Math.max(0, Math.floor(tailLines))}`,
      '-t',
      `=${sessionName}:`,
    ]);
  }

  captureEscaped(sessionName = this.sessionName, tailLines = 0) {
    sessionName =
      sessionName === this.sessionName && this.tmuxSessionName ? this.tmuxSessionName : sessionName;
    return this.runTmux([
      'capture-pane',
      '-p',
      '-e',
      '-S',
      `-${Math.max(0, Math.floor(tailLines))}`,
      '-t',
      `=${sessionName}:`,
    ]);
  }

  paneDimensions(sessionName = this.sessionName) {
    sessionName =
      sessionName === this.sessionName && this.tmuxSessionName ? this.tmuxSessionName : sessionName;
    const [cols, rows] = this.runTmux([
      'display-message',
      '-p',
      '-t',
      `=${sessionName}:`,
      '#{pane_width} #{pane_height}',
    ])
      .split(/\s+/)
      .map(Number);
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) {
      throw new Error(`Invalid pane dimensions for ${sessionName}`);
    }
    return { cols, rows };
  }

  async renderBytesStrict(data, suffix) {
    const renderSession = `${this.sessionName}-render-${suffix}`;
    const bufferName = `render-${process.pid}-${suffix}`;
    const doneFile = path.join(this.tempRoot, `${bufferName}.done`);
    const sentinel = '\0DEVCHAIN_RENDER_DONE\0';
    const { cols, rows } = this.paneDimensions();
    try {
      this.runTmux([
        'new-session',
        '-d',
        '-x',
        String(cols),
        '-y',
        String(rows),
        '-s',
        renderSession,
        process.execPath,
        path.join(__dirname, '..', 'fixtures', 'terminal-sink.js'),
        doneFile,
      ]);
      await sleep(100);
      this.runTmux(['load-buffer', '-b', bufferName, '-'], { input: `${data}${sentinel}` });
      this.runTmux(['paste-buffer', '-d', '-r', '-b', bufferName, '-t', `=${renderSession}:`]);
      const rendered = await waitFor(() => fs.existsSync(doneFile), 5_000);
      if (!rendered) throw new Error('Comparison terminal did not finish rendering');
      const markers = [...data.matchAll(/\bn=(\d+)\b/g)];
      const lastMarker = markers.at(-1)?.[1];
      const capture = await waitFor(() => {
        const value = this.captureStrict(renderSession);
        return !lastMarker || value.includes(`n=${lastMarker}`) ? value : null;
      }, 5_000);
      if (!capture) throw new Error('Comparison terminal did not reach the final output marker');
      return capture;
    } finally {
      try {
        this.runTmux(['kill-session', '-t', `=${renderSession}`]);
      } catch {
        // The comparison session may fail before tmux creates it.
      }
    }
  }

  stateDigest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  sample(phase = 'fixture-ready') {
    const system = sampleSystem(this.appProcess.pid, this.tmuxServerPid);
    const sample = {
      index: this.samples.length,
      phase,
      elapsedMs: 0,
      system,
      generators: {
        expectedPids: [this.generatorPid],
        alivePids: isProcessAlive(this.generatorPid) ? [this.generatorPid] : [],
      },
    };
    this.samples.push(sample);
    return sample;
  }

  scratchEvidence() {
    const metrics = readJson(this.metricsFile) || {};
    return {
      sessionName: this.sessionName,
      tmuxServerPid: this.tmuxServerPid,
      panePid: this.panePid,
      generatorPid: this.generatorPid,
      deterministicSeed: this.options.seed,
      outputBytes: metrics.outputBytes || 0,
    };
  }

  async teardown() {
    if (this.cleanup) return this.cleanup;
    const observedPids = new Set(
      [...this.appPids, this.tmuxServerPid, this.panePid, this.generatorPid]
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
        .concat(
          this.samples.flatMap((sample) => [
            ...(sample.system?.target?.processes || []).map((entry) => entry.pid),
            ...(sample.system?.workload?.processes || []).map((entry) => entry.pid),
          ]),
        ),
    );

    if (this.generatorPaused && isProcessAlive(this.panePid)) this.resumeGenerator();
    const socketWaitTimeoutMs = this.options.socketTimeoutMs || DEFAULT_SOCKET_TIMEOUT_MS;
    const socketSnapshot = [...this.sockets].map((socket, index) => ({
      index,
      socket,
      socketId: typeof socket.id === 'string' && socket.id.length > 0 ? socket.id : null,
      connectedBeforeDisconnect: Boolean(socket.connected),
      disconnectError: null,
    }));
    for (const entry of socketSnapshot) {
      try {
        entry.socket.disconnect();
      } catch (error) {
        entry.disconnectError = String(error);
      }
    }
    const socketsReachedDisconnectedState = await waitFor(
      () => (socketSnapshot.every((entry) => !entry.socket.connected) ? true : null),
      socketWaitTimeoutMs,
    );
    const socketOutcomes = socketSnapshot.map((entry) => ({
      index: entry.index,
      socketId: entry.socketId,
      connectedBeforeDisconnect: entry.connectedBeforeDisconnect,
      disconnectAttempted: true,
      disconnectError: entry.disconnectError,
      connectedAfterWait: Boolean(entry.socket.connected),
      disconnected: !entry.socket.connected,
    }));
    const socketObservation = {
      observedCount: socketOutcomes.length,
      disconnectedCount: socketOutcomes.filter((outcome) => outcome.disconnected).length,
      disconnectErrorCount: socketOutcomes.filter((outcome) => outcome.disconnectError !== null)
        .length,
      timedOut: !socketsReachedDisconnectedState,
      waitTimeoutMs: socketWaitTimeoutMs,
      outcomes: socketOutcomes,
    };
    const socketDisconnected =
      socketObservation.disconnectErrorCount === 0 &&
      !socketObservation.timedOut &&
      socketObservation.disconnectedCount === socketObservation.observedCount;
    for (const { socket } of socketSnapshot) socket.removeAllListeners();
    this.sockets.clear();
    await terminateProcessGroup(this.appProcess);
    if (this.mobileIngress) await this.mobileIngress.stop();
    try {
      this.runTmux(['kill-server']);
    } catch {
      // An early fixture failure may leave no tmux server to stop.
    }

    const processesGone = await waitFor(
      () => [...observedPids].every((pid) => !isProcessAlive(pid)),
      3_000,
    );
    let tmuxServerAliveAfterCleanup = false;
    try {
      this.runTmux(['list-sessions']);
      tmuxServerAliveAfterCleanup = true;
    } catch {
      tmuxServerAliveAfterCleanup = false;
    }
    const storageCreated = fs.existsSync(this.storageDir);
    let removalError = null;
    try {
      fs.rmSync(this.tempRoot, { recursive: true, force: true });
    } catch (error) {
      removalError = error;
    }
    const alivePidsAfterCleanup = [...observedPids].filter((pid) => isProcessAlive(pid));
    const residuePaths = [this.tempRoot, this.storageDir, this.tmuxRoot].filter((entry) =>
      fs.existsSync(entry),
    );
    this.cleanup = {
      attempted: true,
      socketDisconnected,
      socketObservation,
      processAliveAfterCleanup: isProcessAlive(this.appProcess?.pid),
      tmuxServerAliveAfterCleanup,
      storageCreated,
      storageExistsAfterCleanup: fs.existsSync(this.storageDir),
      tempRootExistsAfterCleanup: fs.existsSync(this.tempRoot),
      alivePidsAfterCleanup,
      residuePaths,
      removalError: removalError ? String(removalError) : null,
      processesGone: Boolean(processesGone),
      mobileIngressStopped: !this.mobileIngress?.server,
    };
    return this.cleanup;
  }
}

module.exports = {
  acknowledgeApplicationHeartbeat,
  DisposableAppFixture,
  isProcessAlive,
  terminateProcessGroup,
  waitFor,
};
