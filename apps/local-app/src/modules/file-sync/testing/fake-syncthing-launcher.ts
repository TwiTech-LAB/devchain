import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server } from 'http';
import { join } from 'path';
import {
  SyncthingLauncher,
  type SyncthingBinaryLookup,
  type SyncthingProcess,
} from '../syncthing-launcher';

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

/** One `syncthing serve`: a monitor parent, a child, and the child's REST server. */
export class FakeSyncthingRun implements SyncthingProcess {
  readonly exited: Promise<void>;
  readonly requests: FakeRequest[] = [];
  readonly spawnedAt = Date.now();
  parentAlive = true;
  childAlive = true;
  private resolveExited!: () => void;

  constructor(
    readonly pid: number,
    readonly childPid: number,
    readonly args: string[],
    readonly env: Record<string, string>,
    readonly server: Server,
  ) {
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));
  }

  hasExited(): boolean {
    return !this.parentAlive;
  }

  get home(): string {
    return argValue(this.args, '--home');
  }

  get apiPort(): number {
    return Number(/:(\d+)$/.exec(argValue(this.args, '--gui-address'))?.[1]);
  }

  /** The child dies; with --no-restart the monitor parent exits after it. */
  crashChild(): void {
    this.stopChild();
    this.exitParent();
  }

  /** The child dies while the parent stays up. */
  loseChild(): void {
    this.stopChild();
  }

  stopChild(): void {
    this.childAlive = false;
    this.server.closeAllConnections();
    this.server.close();
  }

  exitParent(): void {
    if (!this.parentAlive) return;
    this.parentAlive = false;
    this.resolveExited();
  }
}

/**
 * A SyncthingLauncher whose "processes" are loopback HTTP servers speaking the
 * REST calls the manager makes. The device id lives in a file under --home,
 * so a restart on the same home keeps it, as the real certificate does.
 */
export class FakeSyncthingLauncher extends SyncthingLauncher {
  lookup: SyncthingBinaryLookup = { found: true, path: '/fake/syncthing', version: 'v2.1.5' };
  /** What POST /rest/system/shutdown does. */
  onShutdown: 'exit' | 'ignore' = 'exit';
  /** Answers to successive GET /rest/config/restart-required; false once exhausted. */
  restartRequired: boolean[] = [];
  folders: Array<{ id: string; path?: string }> = [];
  readonly runs: FakeSyncthingRun[] = [];
  readonly kills: number[] = [];
  private nextPid = 40_000;

  findBinary(): Promise<SyncthingBinaryLookup> {
    return Promise.resolve(this.lookup);
  }

  spawn(
    _binaryPath: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<FakeSyncthingRun> {
    return Promise.resolve(this.spawnRun(args, env));
  }

  spawnRun(args: string[], env: Record<string, string>): FakeSyncthingRun {
    const server = createServer();
    const run = new FakeSyncthingRun(this.nextPid++, this.nextPid++, args, env, server);
    server.on('request', (req, res) => {
      void readBody(req).then((body) => {
        const path = (req.url ?? '').split('?')[0];
        run.requests.push({ method: req.method ?? '', path, body });
        if (req.headers['x-api-key'] !== env.STGUIAPIKEY) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        const json = (value: unknown) =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        const route = `${req.method} ${path}`;
        if (route === 'GET /rest/system/ping') return json({ ping: 'pong' });
        if (route === 'GET /rest/system/version') return json({ version: this.lookup.version });
        if (route === 'GET /rest/system/status') return json({ myID: deviceIdFor(run.home) });
        if (route === 'GET /rest/config/folders') return json(this.folders);
        if (req.method === 'DELETE' && path.startsWith('/rest/config/folders/')) {
          this.folders = this.folders.filter(
            (f) => f.id !== decodeURIComponent(path.slice('/rest/config/folders/'.length)),
          );
          return json({});
        }
        if (route === 'PATCH /rest/config/options') return json({});
        if (route === 'GET /rest/config/restart-required') {
          return json({ requiresRestart: this.restartRequired.shift() ?? false });
        }
        if (route === 'POST /rest/system/shutdown') {
          if (this.onShutdown === 'exit') res.once('finish', () => run.crashChild());
          return json({ ok: 'shutting down' });
        }
        res.writeHead(404).end();
      });
    });
    // A taken port makes the real binary exit at startup.
    server.once('error', () => run.crashChild());
    server.listen(run.apiPort, '127.0.0.1');
    this.runs.push(run);
    return run;
  }

  findChildPid(pid: number): Promise<number | null> {
    const run = this.runs.find((r) => r.pid === pid);
    return Promise.resolve(run?.childAlive ? run.childPid : null);
  }

  isAlive(pid: number): boolean {
    return this.runs.some(
      (r) => (r.pid === pid && r.parentAlive) || (r.childPid === pid && r.childAlive),
    );
  }

  kill(pid: number): void {
    this.kills.push(pid);
    for (const run of this.runs) {
      // Killing only the parent leaves the child serving, as with the real binary.
      if (run.pid === pid) run.exitParent();
      if (run.childPid === pid) run.stopChild();
    }
  }

  get last(): FakeSyncthingRun {
    const run = this.runs.at(-1);
    if (!run) throw new Error('Syncthing was never spawned');
    return run;
  }
}

function argValue(args: string[], flag: string): string {
  const arg = args.find((a) => a.startsWith(`${flag}=`));
  if (!arg) throw new Error(`${flag} missing from ${args.join(' ')}`);
  return arg.slice(flag.length + 1);
}

function deviceIdFor(home: string): string {
  const file = join(home, 'fake-device-id');
  if (!existsSync(file)) writeFileSync(file, randomBytes(8).toString('hex').toUpperCase());
  return readFileSync(file, 'utf8');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : undefined;
}
