#!/usr/bin/env node
// Syncthing control proof: two dedicated Syncthing instances on this machine,
// each with its own home directory, a loopback-only GUI/API address and a
// generated API key, driven only through the REST API.
//
// For three folder shapes it proves: send-only -> receive-only sync with
// ignore patterns, completion detection, and a direction flip.
//   (a) project root with node_modules ignored
//   (b) one transcript folder under <HOME>/.claude/projects/<encoded path>,
//       with an unrelated sibling folder left untouched
//   (c) a HOME-rooted folder that shares only three credential files
//
// All data is synthetic and lives in a temporary work directory; the user's
// real HOME, transcripts, credentials and any existing Syncthing are never read.
//
// Usage:
//   node apps/local-app/scripts/remote-proofs/syncthing-control.mjs
//     [--syncthing <binary>] [--workdir <dir>] [--keep] [--node-modules-dirs N]
//
// Not part of the build or the test suite.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const args = {
    syncthing: process.env.SYNCTHING_BIN || 'syncthing',
    workdir: null,
    keep: false,
    nodeModulesDirs: 2000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--syncthing') args.syncthing = argv[++i];
    else if (a === '--workdir') args.workdir = argv[++i];
    else if (a === '--keep') args.keep = true;
    else if (a === '--node-modules-dirs') args.nodeModulesDirs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Output

const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
const out = (line) => process.stdout.write(`${line}\n`);
const log = (line) => out(`[${elapsed()}s] ${line}`);

const calls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last?.done) return { ...last, ms: Date.now() - started };
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}: ${JSON.stringify(last?.detail ?? last)}`,
  );
}

// ---------------------------------------------------------------------------
// Instances

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class Instance {
  constructor(name, bin, major, home) {
    this.name = name;
    this.bin = bin;
    this.major = major;
    this.home = home;
    this.apiKey = randomBytes(24).toString('hex');
    this.proc = null;
    this.id = null;
  }

  async start() {
    this.guiPort = await freePort();
    this.syncPort = await freePort();
    await mkdir(this.home, { recursive: true });
    this.logPath = join(this.home, 'syncthing.log');
    this.proc = spawn(
      this.bin,
      [
        'serve',
        `--home=${this.home}`,
        `--gui-address=http://127.0.0.1:${this.guiPort}`,
        `--gui-apikey=${this.apiKey}`,
        '--no-browser',
        '--no-restart',
        '--no-upgrade',
        // v1 spells the flag --logfile.
        this.major >= 2 ? `--log-file=${this.logPath}` : `--logfile=${this.logPath}`,
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          // v1 creates a "Default Folder" at ~/Sync on first start without this.
          STNODEFAULTFOLDER: '1',
          STNOUPGRADE: '1',
          HOME: this.home,
        },
      },
    );
    this.exited = new Promise((resolve) =>
      this.proc.on('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      await waitFor(
        `${this.name} API`,
        async () => {
          try {
            await this.api('GET', '/rest/system/ping', undefined, { quiet: true });
            return { done: true };
          } catch (err) {
            return { done: false, detail: err.message };
          }
        },
        { timeoutMs: 30_000 },
      );
    } catch (err) {
      this.proc.kill('SIGKILL');
      throw err;
    }
  }

  async api(method, path, body, { quiet = false } = {}) {
    const res = await fetch(`http://127.0.0.1:${this.guiPort}${path}`, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!quiet) {
      calls.push(
        `${this.name} ${method} ${path.split('?')[0]}${path.includes('?') ? '?' + path.split('?')[1].replace(/device=[A-Z0-9-]+/, 'device=<id>') : ''} -> ${res.status}`,
      );
    }
    if (!res.ok)
      throw new Error(`${this.name} ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return null;
    try {
      await this.api('POST', '/rest/system/shutdown');
    } catch {
      this.proc.kill('SIGTERM');
    }
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 15_000);
    const result = await this.exited;
    clearTimeout(timer);
    return result;
  }

  /**
   * Linux only: inotify watches held by this instance. `serve` runs a monitor
   * parent that spawns the real Syncthing process, so child processes count too.
   */
  inotifyWatches() {
    try {
      const pids = [this.proc.pid];
      for (let i = 0; i < pids.length; i++) {
        for (const tid of readdirSync(`/proc/${pids[i]}/task`)) {
          const children = readFileSync(`/proc/${pids[i]}/task/${tid}/children`, 'utf8').trim();
          if (children) pids.push(...children.split(/\s+/).map(Number));
        }
      }
      let watches = 0;
      for (const pid of pids) {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          let target;
          try {
            target = readlinkSync(`/proc/${pid}/fd/${fd}`);
          } catch {
            continue;
          }
          if (target !== 'anon_inode:inotify') continue;
          const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
          watches += (info.match(/^inotify wd:/gm) ?? []).length;
        }
      }
      return watches;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
}

async function makeNodeModules(root, dirs) {
  const perPkg = 10;
  for (let i = 0; i < dirs / perPkg; i++) {
    for (let j = 0; j < perPkg; j++) {
      const d = join(root, 'node_modules', `pkg-${i}`, `sub-${j}`);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'index.js'), `module.exports = ${i * perPkg + j};\n`);
    }
  }
}

const exists = (p) => existsSync(p);

// ---------------------------------------------------------------------------
// Folder operations

const WATCHER_DELAY_S = 1;

// Syncthing v1.30 resets fsWatcherDelayS to its default on any folder PATCH
// that omits it, so every PATCH carries it.
function folderPatch(id, fields) {
  return [`/rest/config/folders/${id}`, { ...fields, fsWatcherDelayS: WATCHER_DELAY_S }];
}

function folderConfig(id, path, type, devices, extra = {}) {
  return {
    id,
    label: id,
    path,
    type,
    devices: devices.map((deviceID) => ({ deviceID })),
    // Created paused so ignore patterns are in place before the first scan.
    paused: true,
    fsWatcherEnabled: true,
    fsWatcherDelayS: WATCHER_DELAY_S,
    rescanIntervalS: 3600,
    ...extra,
  };
}

async function addFolderPair(A, B, id, pathA, pathB, ignores) {
  await A.api('POST', '/rest/config/folders', folderConfig(id, pathA, 'sendonly', [A.id, B.id]));
  await B.api('POST', '/rest/config/folders', folderConfig(id, pathB, 'receiveonly', [A.id, B.id]));
  await A.api('POST', `/rest/db/ignores?folder=${id}`, { ignore: ignores });
  await B.api('POST', `/rest/db/ignores?folder=${id}`, { ignore: ignores });
  const t = Date.now();
  await B.api('PATCH', ...folderPatch(id, { paused: false }));
  await A.api('PATCH', ...folderPatch(id, { paused: false }));
  return t;
}

/**
 * Completion = the sender's view of the receiver is 100% with nothing needed,
 * AND the receiver's own folder status is idle with nothing needed and a
 * global file count equal to the sender's local count. Sender-side
 * completion only reflects the receiver index the sender has seen so far.
 */
async function waitSynced(sender, receiver, id, what) {
  return waitFor(
    what,
    async () => {
      const comp = await sender.api(
        'GET',
        `/rest/db/completion?folder=${id}&device=${receiver.id}`,
        undefined,
        { quiet: true },
      );
      const sStat = await sender.api('GET', `/rest/db/status?folder=${id}`, undefined, {
        quiet: true,
      });
      const rStat = await receiver.api('GET', `/rest/db/status?folder=${id}`, undefined, {
        quiet: true,
      });
      const done =
        comp.completion === 100 &&
        comp.needItems === 0 &&
        comp.remoteState === 'valid' &&
        sStat.state === 'idle' &&
        rStat.state === 'idle' &&
        rStat.needTotalItems === 0 &&
        rStat.globalFiles === sStat.localFiles &&
        rStat.globalDirectories === sStat.localDirectories &&
        rStat.localFiles === sStat.localFiles;
      return {
        done,
        detail: {
          completion: comp.completion,
          needItems: comp.needItems,
          remoteState: comp.remoteState,
          sender: `${sStat.state} files=${sStat.localFiles}`,
          receiver: `${rStat.state} need=${rStat.needTotalItems} global=${rStat.globalFiles} local=${rStat.localFiles}`,
        },
      };
    },
    { timeoutMs: 120_000 },
  );
}

async function flip(A, B, id) {
  // New receiver first, so there is never a moment with two senders.
  await A.api('PATCH', ...folderPatch(id, { type: 'receiveonly' }));
  await B.api('PATCH', ...folderPatch(id, { type: 'sendonly' }));
  const [a, b] = await Promise.all([
    A.api('GET', `/rest/config/folders/${id}`),
    B.api('GET', `/rest/config/folders/${id}`),
  ]);
  if (a.type !== 'receiveonly' || b.type !== 'sendonly') {
    throw new Error(`flip not applied: A=${a.type} B=${b.type}`);
  }
}

async function waitFileContent(path, content, timeoutMs = 60_000) {
  return waitFor(
    `${path} content`,
    async () => {
      try {
        return { done: (await readFile(path, 'utf8')) === content };
      } catch {
        return { done: false };
      }
    },
    { timeoutMs },
  );
}

/**
 * After the flip: a change written on the new sender (B) must arrive on A
 * through the file watcher alone (no scan call), and a change written on the
 * new receiver (A) must stay local, show as a receive-only change, and be
 * revertible.
 */
async function proveFlip(A, B, id, pathA, pathB, rel) {
  const flipStart = Date.now();
  await flip(A, B, id);
  const flipApplyMs = Date.now() - flipStart;

  const marker = `flipped ${id} ${Date.now()}\n`;
  const writeAt = Date.now();
  await writeTree(pathB, { [rel]: marker });
  const arrived = await waitFileContent(join(pathA, rel), marker);
  const flowMs = Date.now() - writeAt;

  // Reverse direction must not flow.
  const local = `local-only edit on new receiver ${Date.now()}\n`;
  await writeTree(pathA, { [rel]: local });
  await A.api('POST', `/rest/db/scan?folder=${id}`);
  const changed = await waitFor('receive-only change on A', async () => {
    const s = await A.api('GET', `/rest/db/status?folder=${id}`, undefined, { quiet: true });
    return {
      done: s.receiveOnlyChangedFiles > 0 && s.state === 'idle',
      detail: s.receiveOnlyChangedFiles,
    };
  });
  await sleep(5000);
  const bContent = await readFile(join(pathB, rel), 'utf8');
  if (bContent !== marker) throw new Error(`reverse flow detected: B has "${bContent.trim()}"`);

  await A.api('POST', `/rest/db/revert?folder=${id}`);
  await waitFileContent(join(pathA, rel), marker);
  void arrived;
  void changed;
  return { flipApplyMs, flowMs };
}

// ---------------------------------------------------------------------------
// Shapes

const CRED_FILES = ['.claude/.credentials.json', '.codex/auth.json', '.gemini/oauth_creds.json'];

const SHAPES = {
  a: {
    title: '(a) project root, node_modules ignored',
    ignores: ['(?d)node_modules'],
    flipFile: 'src/index.ts',
    async setup(ctx) {
      const pathA = join(ctx.root, 'A/projects/demo');
      const pathB = join(ctx.root, 'B/projects/demo');
      await writeTree(pathA, {
        'package.json': '{"name":"demo"}\n',
        'src/index.ts': 'export const x = 1;\n',
        'src/lib/util.ts': 'export const y = 2;\n',
        'packages/inner/package.json': '{"name":"inner"}\n',
        'packages/inner/node_modules/dep/index.js': 'nested\n',
      });
      await makeNodeModules(pathA, ctx.nodeModulesDirs);
      await mkdir(pathB, { recursive: true });
      return { pathA, pathB };
    },
    verify({ pathB }) {
      return {
        present: [
          'package.json',
          'src/index.ts',
          'src/lib/util.ts',
          'packages/inner/package.json',
        ].filter((f) => !exists(join(pathB, f))),
        leaked: ['node_modules', 'packages/inner/node_modules'].filter((f) =>
          exists(join(pathB, f)),
        ),
      };
    },
  },
  b: {
    title: '(b) transcript folder, sibling untouched',
    ignores: [],
    flipFile: 'session-1.jsonl',
    async setup(ctx) {
      const enc = '-home-dev-projects-demo';
      const sib = '-home-dev-projects-other';
      const homeA = join(ctx.root, 'A/home');
      const homeB = join(ctx.root, 'B/home');
      const pathA = join(homeA, '.claude/projects', enc);
      const pathB = join(homeB, '.claude/projects', enc);
      await writeTree(pathA, {
        'session-1.jsonl': '{"type":"user","text":"hi"}\n',
        'session-2.jsonl': '{"type":"user","text":"there"}\n',
        'session-1/subagents/agent-1.jsonl': '{"type":"assistant"}\n',
      });
      await writeTree(join(homeA, '.claude/projects', sib), { 'a-only.jsonl': 'A sibling\n' });
      await writeTree(join(homeB, '.claude/projects', sib), { 'b-only.jsonl': 'B sibling\n' });
      await mkdir(pathB, { recursive: true });
      return { pathA, pathB, homeB, sib };
    },
    verify({ pathB, homeB, sib }) {
      const sibB = join(homeB, '.claude/projects', sib);
      const sibEntries = readdirSync(sibB).sort();
      return {
        present: ['session-1.jsonl', 'session-2.jsonl', 'session-1/subagents/agent-1.jsonl'].filter(
          (f) => !exists(join(pathB, f)),
        ),
        leaked:
          sibEntries.join(',') === 'b-only.jsonl' &&
          readFileSync(join(sibB, 'b-only.jsonl'), 'utf8') === 'B sibling\n'
            ? []
            : [`sibling changed: ${sibEntries.join(',')}`],
      };
    },
  },
  c: {
    title: '(c) HOME root, only three credential files',
    ignores: [...CRED_FILES.map((f) => `!/${f}`), '*'],
    flipFile: '.codex/auth.json',
    async setup(ctx) {
      const pathA = join(ctx.root, 'A/home-c');
      const pathB = join(ctx.root, 'B/home-c');
      await writeTree(pathA, {
        '.claude/.credentials.json': '{"dummy":"claude"}\n',
        '.claude/settings.json': '{}\n',
        '.claude/projects/-x/s.jsonl': 'transcript\n',
        '.codex/auth.json': '{"dummy":"codex"}\n',
        '.codex/config.toml': 'model = "x"\n',
        '.codex/sessions/2026/s.jsonl': 'transcript\n',
        '.gemini/oauth_creds.json': '{"dummy":"gemini"}\n',
        '.gemini/settings.json': '{}\n',
        '.gemini/antigravity-cli/conv.db': 'db\n',
        '.bashrc': 'export X=1\n',
        'Documents/notes.txt': 'private\n',
        '.ssh/id_ed25519': 'dummy key\n',
      });
      await mkdir(pathB, { recursive: true });
      return { pathA, pathB };
    },
    verify({ pathB }) {
      const want = new Set(CRED_FILES);
      const leaked = [];
      const walk = (dir, rel = '') => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.name === '.stfolder' || e.name === '.stignore' || e.name === 'syncthing.log')
            continue;
          if (e.isDirectory()) walk(join(dir, e.name), r);
          else if (!want.has(r)) leaked.push(r);
        }
      };
      walk(pathB);
      return { present: CRED_FILES.filter((f) => !exists(join(pathB, f))), leaked };
    },
  },
};

// ---------------------------------------------------------------------------
// Main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.workdir ?? (await mkdtemp(join(tmpdir(), 'devchain-syncthing-proof-')));
  await mkdir(root, { recursive: true });
  const versionLine = execFileSync(args.syncthing, ['--version'], { encoding: 'utf8' }).trim();
  const major = Number(versionLine.match(/\bv(\d+)\./)?.[1] ?? 0);
  const A = new Instance('A', args.syncthing, major, join(root, 'A/st-home'));
  const B = new Instance('B', args.syncthing, major, join(root, 'B/st-home'));
  const results = [];
  let failed = false;

  out(`Syncthing control proof, workdir ${root}`);
  try {
    let t = Date.now();
    await Promise.all([A.start(), B.start()]);
    log(
      `started A (api 127.0.0.1:${A.guiPort}) and B (api 127.0.0.1:${B.guiPort}) in ${Date.now() - t}ms`,
    );

    const version = await A.api('GET', '/rest/system/version');
    log(`version ${version.version} ${version.os}/${version.arch}`);
    [A.id, B.id] = await Promise.all([
      A.api('GET', '/rest/system/status').then((s) => s.myID),
      B.api('GET', '/rest/system/status').then((s) => s.myID),
    ]);
    log(`device IDs A=${A.id.slice(0, 7)} B=${B.id.slice(0, 7)}`);

    for (const inst of [A, B]) {
      await inst.api('PATCH', '/rest/config/options', {
        listenAddresses: [`tcp://127.0.0.1:${inst.syncPort}`],
        globalAnnounceEnabled: false,
        localAnnounceEnabled: false,
        relaysEnabled: false,
        natEnabled: false,
        urAccepted: -1,
        crashReportingEnabled: false,
        autoUpgradeIntervalH: 0,
      });
      const gui = await inst.api('GET', '/rest/config/gui');
      if (!gui.address.startsWith('127.0.0.1:'))
        throw new Error(`${inst.name} GUI not loopback: ${gui.address}`);
    }
    const restart = await Promise.all(
      [A, B].map((i) => i.api('GET', '/rest/config/restart-required')),
    );
    log(
      `options patched (loopback listen, discovery/relays/NAT off); restart-required A=${restart[0].requiresRestart} B=${restart[1].requiresRestart}`,
    );

    t = Date.now();
    await A.api('POST', '/rest/config/devices', {
      deviceID: B.id,
      name: 'B',
      addresses: [`tcp://127.0.0.1:${B.syncPort}`],
    });
    await B.api('POST', '/rest/config/devices', {
      deviceID: A.id,
      name: 'A',
      addresses: [`tcp://127.0.0.1:${A.syncPort}`],
    });
    const conn = await waitFor('A<->B connection', async () => {
      const c = await A.api('GET', '/rest/system/connections', undefined, { quiet: true });
      return { done: c.connections?.[B.id]?.connected === true, detail: c.connections?.[B.id] };
    });
    calls.push('A GET /rest/system/connections (polled) -> 200');
    log(`devices added and connected in ${Date.now() - t}ms (${conn.ms}ms waiting for connection)`);

    const ctx = { root, nodeModulesDirs: args.nodeModulesDirs };
    for (const [key, shape] of Object.entries(SHAPES)) {
      const id = `proof-${key}`;
      try {
        const paths = await shape.setup(ctx);
        const unpausedAt = await addFolderPair(A, B, id, paths.pathA, paths.pathB, shape.ignores);
        await waitSynced(A, B, id, `${id} first sync`);
        calls.push(
          `A GET /rest/db/completion?folder=${id}&device=<id> + A,B GET /rest/db/status?folder=${id} (polled) -> 200`,
        );
        const firstSyncMs = Date.now() - unpausedAt;
        const check = shape.verify(paths);
        if (check.present.length || check.leaked.length) {
          throw new Error(
            `content check failed: missing=[${check.present}] leaked=[${check.leaked}]`,
          );
        }
        const watchesA = A.inotifyWatches();
        log(
          `${shape.title}: first sync ${firstSyncMs}ms, expected files present, excluded files absent`,
        );

        const f = await proveFlip(A, B, id, paths.pathA, paths.pathB, shape.flipFile);
        log(
          `${shape.title}: flip applied in ${f.flipApplyMs}ms, B->A change arrived in ${f.flowMs}ms via watcher, A->B blocked and reverted`,
        );
        results.push({
          shape: shape.title,
          ok: true,
          firstSyncMs,
          ...f,
          watchesA,
          ignores: shape.ignores,
        });
      } catch (err) {
        failed = true;
        log(`${shape.title}: FAILED ${err.message}`);
        results.push({ shape: shape.title, ok: false, error: err.message, ignores: shape.ignores });
      }
    }
  } catch (err) {
    failed = true;
    log(`FATAL ${err.message}`);
  } finally {
    const [ea, eb] = await Promise.all([A.stop(), B.stop()]);
    log(`stopped A=${JSON.stringify(ea)} B=${JSON.stringify(eb)}`);
    if (!args.keep && !args.workdir) await rm(root, { recursive: true, force: true });
  }

  out('\nREST calls (in order):');
  const seen = new Set();
  for (const c of calls) {
    if (seen.has(c)) continue;
    seen.add(c);
    out(`  ${c}`);
  }
  out('\nResults:');
  for (const r of results) {
    out(
      `  ${r.ok ? 'PASS' : 'FAIL'} ${r.shape} | ignores=${JSON.stringify(r.ignores)}` +
        (r.ok
          ? ` | firstSync=${r.firstSyncMs}ms flipApply=${r.flipApplyMs}ms flipFlow=${r.flowMs}ms inotifyWatchesA=${r.watchesA}`
          : ` | ${r.error}`),
    );
  }
  out(
    `inotify max_user_watches: ${(() => {
      try {
        return readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim();
      } catch {
        return 'n/a';
      }
    })()}`,
  );
  out(`Result: ${failed ? 'FAILED' : 'PASSED'}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  out(`fatal: ${err.message}`);
  process.exitCode = 1;
});
