import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fixtureTls } from './tls-fixture';

/** The CLI versions a real claim records: the pins of the installed package, plus agy's report. */
function pinnedCliVersions(): Record<string, string> {
  const pins = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../scripts/host-cli-pins.json'), 'utf8'),
  ) as Record<string, { version?: string }>;
  const versions: Record<string, string> = {};
  for (const name of ['claude', 'codex', 'copilot', 'opencode']) {
    versions[name] = String(pins[name].version);
  }
  versions.agy = 'agy 1.0.0';
  return versions;
}

/**
 * One VM: the bootstrap of an unclaimed image until a claim arrives, then
 * DevChain's host routes, over HTTPS with the fixture VM certificate.
 * Records what home sends.
 */
export class FakeBootstrapServer {
  /** The certificate this VM serves; home must hold it to reach the VM. */
  readonly certificate = fixtureTls.cert;
  version: string | null = null;
  imageVersion = '1.4.0';
  bootId = 'b';
  dockerRequests = 0;
  docker = {
    installed: false,
    engineVersion: null as string | null,
    composeVersion: null as string | null,
    userInGroup: false,
    dataRootFreeBytes: null as number | null,
  };
  dockerStatus: { jobId: string; state: string; at: string } | null = null;
  claims: Array<Record<string, unknown>> = [];
  claimHeaders: Array<string | undefined> = [];
  applied: Array<Record<string, unknown>> = [];
  verifies: string[] = [];
  verifyAnswers: Record<string, { ok: boolean; summary: string; hint: string | null }> = {};
  frozen = new Set<string>();
  freezeLog: string[] = [];
  update: { state: string; version: string } | null = null;
  /** Holds the claim answer until released, to stop home mid-claim. */
  claimGate: Promise<void> | null = null;
  /** Reports an install in progress on `/api/runtime`, as the bootstrap does after a claim arrived. */
  claiming = false;
  /** Recorded by the claim; the claimed runtime reports it, as DevChain does on a host. */
  cliVersions: Record<string, string> | null = null;
  uid: number | null = null;
  gid: number | null = null;
  /** Older validators drop uid; the installed host still reports its actual ids. */
  legacyAllocatedIds: { uid: number; gid: number } | null = null;
  server!: Server;
  url = '';

  async listen(options: { host?: string; port?: number } = {}): Promise<void> {
    const host = options.host ?? '127.0.0.1';
    this.server = createServer({ key: fixtureTls.key, cert: fixtureTls.cert }, (req, res) => {
      void this.handle(req).then(
        ({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body === undefined ? '' : JSON.stringify(body));
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
    // A taken port must fail the caller, not leave it waiting for a listen that never comes.
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(options.port ?? 0, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.url = `https://${host}:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const url = new URL(req.url ?? '/', 'http://vm');
    const body = await readJson(req);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/runtime') {
      return this.version
        ? {
            status: 200,
            body: {
              version: this.version,
              bootId: this.bootId,
              cliVersions: this.cliVersions,
              docker: this.docker,
              uid: this.uid,
              gid: this.gid,
            },
          }
        : {
            status: 200,
            body: {
              state: this.claiming ? 'claiming' : 'unclaimed',
              version: null,
              imageVersion: this.imageVersion,
            },
          };
    }
    if (route === 'GET /api/host/stats') return { status: 200, body: {} };
    if (route === 'POST /api/host/claim') {
      if (this.version) {
        return { status: 409, body: { code: 'conflict', details: { code: 'ALREADY_CLAIMED' } } };
      }
      this.claims.push(body);
      this.claimHeaders.push(req.headers.authorization);
      await this.claimGate;
      this.version = String(body.version);
      this.cliVersions = pinnedCliVersions();
      this.uid = this.legacyAllocatedIds?.uid ?? (typeof body.uid === 'number' ? body.uid : null);
      this.gid =
        this.legacyAllocatedIds?.gid ?? (typeof body.gid === 'number' ? body.gid : this.uid);
      return { status: 200, body: { claimed: true, cliVersions: this.cliVersions } };
    }
    if (route === 'POST /api/host/provider-auth/verify') {
      const provider = String(body.provider);
      this.verifies.push(provider);
      return {
        status: 200,
        body: this.verifyAnswers[provider] ?? { ok: true, summary: 'ok', hint: null },
      };
    }
    if (route === 'POST /api/host/provider-auth') {
      this.applied.push(body);
      return { status: 200, body: { envKeys: [], files: [] } };
    }
    const project = /^POST \/api\/host\/projects\/([^/]+)\/(freeze|thaw)$/.exec(route);
    if (project) {
      const [, projectId, action] = project;
      this.freezeLog.push(`${action}:${projectId}`);
      if (action === 'freeze') {
        this.frozen.add(projectId);
        return { status: 200, body: { projectId, frozenAt: '2026-09-24T00:00:00.000Z' } };
      }
      this.frozen.delete(projectId);
      return { status: 204 };
    }
    if (route === 'POST /api/host/docker') {
      this.dockerRequests++;
      const jobId = `job-${this.dockerRequests}`;
      this.dockerStatus = { jobId, state: 'installing', at: new Date().toISOString() };
      setTimeout(() => {
        this.bootId += '-docker';
        this.docker = {
          installed: true,
          engineVersion: '29',
          composeVersion: '2',
          userInGroup: true,
          dataRootFreeBytes: 1000,
        };
        this.dockerStatus = { jobId, state: 'done', at: new Date().toISOString() };
      }, 50);
      return { status: 202, body: { state: 'pending', jobId } };
    }
    if (route === 'GET /api/host/docker')
      return { status: 200, body: { status: this.dockerStatus } };
    if (route === 'POST /api/host/update') {
      const version = String(body.version);
      this.update = { state: 'installing', version };
      // The install and restart take a moment; the host is unreachable meanwhile.
      const previous = this.version;
      this.version = null;
      setTimeout(() => {
        this.version = version;
        this.update = { state: 'done', version };
      }, 150);
      void previous;
      return { status: 202, body: { version, state: 'pending' } };
    }
    if (route === 'GET /api/host/update') return { status: 200, body: { status: this.update } };
    return { status: 404, body: { code: 'not_found' } };
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
