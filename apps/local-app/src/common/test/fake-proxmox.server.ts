import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureTls } from './tls-fixture';

type Vm = {
  vmid: number;
  name: string;
  description: string;
  tags: string;
  pool: string;
  template: number;
  status: 'stopped' | 'running';
  cores: number;
  memory: number;
  scsi0: string;
  smbios1: string;
};

export interface ProxmoxCall {
  method: string;
  path: string;
  body: Record<string, string>;
}

const VM_CERTIFICATE_PATH = '/etc/devchain-host/tls/cert.pem';

const REQUIRED_RIGHTS: Record<string, string[]> = {
  '/pool/devchain': [
    'Pool.Audit',
    'VM.Allocate',
    'VM.Audit',
    'VM.Clone',
    'VM.Config.CPU',
    'VM.Config.Memory',
    'VM.Config.Disk',
    'VM.Config.Network',
    'VM.PowerMgmt',
    'VM.Monitor',
  ],
  '/storage/local-lvm': ['Datastore.Audit', 'Datastore.AllocateSpace'],
  '/storage/local': ['Datastore.Audit', 'Datastore.AllocateSpace', 'Datastore.AllocateTemplate'],
  '/sdn/zones/localnetwork/vmbr0': ['SDN.Use'],
  '/nodes/hw': ['Sys.AccessNetwork'],
};

/** HTTPS Proxmox fixture with real TLS verification and a pool-scoped token. */
export class FakeProxmoxServer {
  readonly tokenId = 'devchain@pve!agent';
  readonly tokenSecret = 'fake-proxmox-secret';
  readonly imageSha256 = 'a'.repeat(64);
  readonly calls: ProxmoxCall[] = [];
  readonly vms = new Map<number, Vm>();
  readonly images = new Set<string>();
  readonly destroyed: number[] = [];
  readonly rights = new Map(
    Object.entries(REQUIRED_RIGHTS).map(([path, names]) => [path, new Set(names)]),
  );
  guestIp = '127.0.0.2';
  /** What a running VM's bootstrap wrote to its certificate path; null before it did. */
  guestCertificate: string | null = fixtureTls.cert;
  outsidePoolAllocate = false;
  onDelete: ((vmid: number) => Promise<void>) | null = null;
  origin = '';
  imageUrl = '';
  caPem = '';
  fingerprint = '';
  private server!: HttpsServer;
  private imageServer!: ReturnType<typeof createHttpServer>;
  private certificateDir = '';
  private nextTask = 0;
  private nextIdentity = 99;

  async listen(): Promise<void> {
    this.certificateDir = mkdtempSync(join(tmpdir(), 'devchain-fake-proxmox-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'server.key',
        '-out',
        'server.crt',
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { cwd: this.certificateDir, stdio: 'ignore' },
    );
    this.caPem = readFileSync(join(this.certificateDir, 'server.crt'), 'utf8');
    this.fingerprint = new X509Certificate(this.caPem).fingerprint256;
    this.server = createHttpsServer(
      {
        key: readFileSync(join(this.certificateDir, 'server.key')),
        cert: this.caPem,
      },
      (request, response) => {
        void this.handle(request).then(
          ({ status, data }) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data }));
          },
          () => {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: null }));
          },
        );
      },
    );
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.imageServer = createHttpServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://image').pathname;
      if (path === '/devchain-host-1.3.0.qcow2.sha256') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`${this.imageSha256}  devchain-host-1.3.0.qcow2\n`);
        return;
      }
      if (path !== '/devchain-host-1.3.0.qcow2') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : 'fake-image');
    });
    await new Promise<void>((resolve) => this.imageServer.listen(0, '127.0.0.1', resolve));
    this.imageUrl = `http://127.0.0.1:${(this.imageServer.address() as AddressInfo).port}/devchain-host-1.3.0.qcow2`;
    this.vms.set(199, {
      vmid: 199,
      name: 'unrelated',
      description: 'outside',
      tags: 'other',
      pool: 'other',
      template: 0,
      status: 'stopped',
      cores: 1,
      memory: 1024,
      scsi0: 'local-lvm:vm-199-disk-0,size=8G',
      smbios1: 'uuid=00000000-0000-4000-8000-000000000199',
    });
  }

  async close(): Promise<void> {
    for (const server of [this.server, this.imageServer]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.certificateDir) rmSync(this.certificateDir, { recursive: true, force: true });
  }

  connectionString(): string {
    const url = new URL(`devchain-proxmox://127.0.0.1:${new URL(this.origin).port}/hw`);
    for (const [key, value] of Object.entries({
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      fp: this.fingerprint,
      token: `${this.tokenId}:${this.tokenSecret}`,
      ca: Buffer.from(this.caPem).toString('base64'),
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }

  deny(path: string, privilege: string): void {
    this.rights.get(path)?.delete(privilege);
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; data: unknown }> {
    const url = new URL(req.url ?? '/', this.origin);
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    const body = Object.fromEntries(new URLSearchParams(raw));
    const path = url.pathname.replace(/^\/api2\/json/, '');
    this.calls.push({ method, path: `${path}${url.search}`, body });

    // PVE validates the VMID schema before the create handler checks the token.
    if (method === 'POST' && path === '/nodes/hw/qemu' && Number(body.vmid) < 100) {
      return { status: 400, data: null };
    }
    if (req.headers.authorization !== `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`) {
      return { status: 403, data: null };
    }
    if (method === 'GET' && path === '/version') return { status: 200, data: { version: '8.4' } };
    if (method === 'GET' && path === '/cluster/nextid') {
      const exact = url.searchParams.get('vmid');
      if (exact !== null) {
        const vmid = Number(exact);
        return Number.isInteger(vmid) && vmid >= 100 && !this.vms.has(vmid)
          ? { status: 200, data: String(vmid) }
          : { status: 400, data: null };
      }
      let vmid = 100;
      while (this.vms.has(vmid)) vmid++;
      return { status: 200, data: String(vmid) };
    }
    if (method === 'GET' && path === '/access/permissions') {
      const acl = url.searchParams.get('path') ?? '';
      if (acl.startsWith('/vms/')) {
        return {
          status: 200,
          data: { [acl]: this.outsidePoolAllocate ? { 'VM.Allocate': 1 } : {} },
        };
      }
      return {
        status: 200,
        data: {
          [acl]: Object.fromEntries([...(this.rights.get(acl) ?? [])].map((right) => [right, 0])),
        },
      };
    }
    if (method === 'GET' && path === '/cluster/resources') {
      return {
        status: 200,
        data: [...this.vms.values()].map(({ vmid, name, template, status }) => ({
          vmid,
          name,
          template,
          status,
          node: 'hw',
        })),
      };
    }
    if (method === 'GET' && path === '/nodes/hw/qemu') {
      return {
        status: 200,
        data: [...this.vms.values()].map(({ vmid, name, template, status }) => ({
          vmid,
          name,
          template,
          status,
        })),
      };
    }
    if (method === 'GET' && path === '/pools/devchain') {
      return {
        status: 200,
        data: {
          members: [...this.vms.values()]
            .filter((vm) => vm.pool === 'devchain')
            .map(({ vmid }) => ({ vmid })),
        },
      };
    }
    const content = /^\/nodes\/hw\/storage\/([^/]+)\/content$/.exec(path);
    if (method === 'GET' && content) {
      return { status: 200, data: [...this.images].map((volid) => ({ volid, content: 'import' })) };
    }
    if (method === 'POST' && path === '/nodes/hw/storage/local/download-url') {
      if (!this.allowed('/storage/local', 'Datastore.AllocateTemplate')) {
        return { status: 403, data: null };
      }
      if (
        body.content !== 'import' ||
        body['checksum-algorithm'] !== 'sha256' ||
        body.checksum !== this.imageSha256
      ) {
        return { status: 400, data: null };
      }
      this.images.add(`local:import/${body.filename}`);
      return { status: 200, data: this.task() };
    }
    if (method === 'POST' && path === '/nodes/hw/qemu') {
      if (
        body.pool
          ? body.pool !== 'devchain' || !this.allowed('/pool/devchain', 'VM.Allocate')
          : !this.outsidePoolAllocate
      )
        return { status: 403, data: null };
      const vmid = Number(body.vmid);
      if (!Number.isInteger(vmid) || this.vms.has(vmid)) return { status: 400, data: null };
      this.vms.set(vmid, {
        vmid,
        name: body.name,
        description: body.description ?? '',
        tags: body.tags,
        pool: body.pool ?? '',
        template: 0,
        status: 'stopped',
        cores: Number(body.cores),
        memory: Number(body.memory),
        scsi0: `local-lvm:vm-${vmid}-disk-0,size=8G`,
        smbios1: uuid(++this.nextIdentity),
      });
      return { status: 200, data: this.task() };
    }
    const vmRoute = /^\/nodes\/hw\/qemu\/(\d+)(?:\/(.*))?$/.exec(path);
    if (vmRoute) {
      const vmid = Number(vmRoute[1]);
      const action = vmRoute[2] ?? '';
      const vm = this.vms.get(vmid);
      if (!vm) return { status: 404, data: null };
      if (method === 'GET' && action === 'config') return { status: 200, data: { ...vm } };
      if (method === 'POST' && action === 'template') {
        vm.template = 1;
        return { status: 200, data: this.task() };
      }
      if (method === 'POST' && action === 'clone') {
        const newid = Number(body.newid);
        if (!Number.isInteger(newid) || newid < 100 || this.vms.has(newid))
          return { status: 400, data: null };
        if (body.pool !== 'devchain' || !this.allowed('/pool/devchain', 'VM.Clone')) {
          return { status: 403, data: null };
        }
        this.vms.set(newid, {
          ...vm,
          vmid: newid,
          name: body.name,
          description: body.description ?? '',
          template: 0,
          status: 'stopped',
          smbios1: uuid(++this.nextIdentity),
        });
        return { status: 200, data: this.task() };
      }
      if (method === 'PUT' && action === 'config') {
        vm.cores = Number(body.cores);
        vm.memory = Number(body.memory);
        return { status: 200, data: null };
      }
      if (method === 'PUT' && action === 'resize') {
        vm.scsi0 = `local-lvm:vm-${vmid}-disk-0,size=${body.size}`;
        return { status: 200, data: null };
      }
      if (method === 'POST' && action === 'status/start') {
        vm.status = 'running';
        return { status: 200, data: this.task() };
      }
      if (method === 'POST' && action === 'status/stop') {
        vm.status = 'stopped';
        return { status: 200, data: this.task() };
      }
      if (method === 'GET' && action === 'status/current') {
        return { status: 200, data: { status: vm.status } };
      }
      if (method === 'GET' && action === 'agent/network-get-interfaces') {
        return {
          status: 200,
          data: {
            result: [
              {
                name: 'eth0',
                'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': this.guestIp }],
              },
            ],
          },
        };
      }
      if (method === 'GET' && action === 'agent/file-read') {
        // PVE 8 guards guest file reads with VM.Monitor; the guest agent reports a missing file as 500.
        if (!this.allowed('/pool/devchain', 'VM.Monitor')) return { status: 403, data: null };
        const file = url.searchParams.get('file');
        if (vm.status !== 'running' || file !== VM_CERTIFICATE_PATH || !this.guestCertificate) {
          return { status: 500, data: null };
        }
        return {
          status: 200,
          data: {
            content: this.guestCertificate,
            'bytes-read': Buffer.byteLength(this.guestCertificate),
          },
        };
      }
      if (method === 'DELETE' && action === '') {
        if (
          url.searchParams.get('purge') !== '1' ||
          url.searchParams.get('destroy-unreferenced-disks') !== '1'
        ) {
          return { status: 400, data: null };
        }
        this.vms.delete(vmid);
        this.destroyed.push(vmid);
        await this.onDelete?.(vmid);
        return { status: 200, data: this.task() };
      }
    }
    const task = /^\/nodes\/hw\/tasks\/[^/]+\/status$/.exec(path);
    if (method === 'GET' && task)
      return { status: 200, data: { status: 'stopped', exitstatus: 'OK' } };
    return { status: 404, data: null };
  }

  private task(): string {
    return `UPID:fake:${++this.nextTask}`;
  }

  private allowed(path: string, privilege: string): boolean {
    return this.rights.get(path)?.has(privilege) ?? false;
  }
}

function uuid(vmid: number): string {
  return `uuid=00000000-0000-4000-8000-${String(vmid).padStart(12, '0')}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
