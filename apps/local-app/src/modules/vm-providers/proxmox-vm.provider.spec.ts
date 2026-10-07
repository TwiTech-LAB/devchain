import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { ProxmoxClient } from '@devchain/proxmox-client';
import type { VmProviderConnection } from '../storage/models/domain.models';
import { ProxmoxVmProvider } from './proxmox-vm.provider';

type Handler = (
  method: string,
  url: URL,
  body: string,
  respond: (status: number, data: unknown) => void,
) => void;
const TOKEN_SECRET = 'private-proxmox-token';
const VM_IDENTITY = '12345678-1234-1234-1234-123456789abc';

let dir = '';
let caPem = '';
let certPem = '';
let server: https.Server;
let port = 0;
let handler: Handler;
const seen: Array<{ method: string; path: string; body: string }> = [];
const createdProbeVmids: number[] = [];

function connection(overrides: Partial<VmProviderConnection> = {}): VmProviderConnection {
  return {
    id: 'c0ffeec0-0000-4000-8000-000000000001',
    kind: 'proxmox',
    name: 'Lab',
    apiUrl: `https://127.0.0.1:${port}`,
    node: 'hw',
    pool: 'devchain',
    storage: 'local-lvm',
    imageStorage: 'local',
    bridge: 'vmbr0',
    vmidMin: 100,
    vmidMax: 200,
    namePrefix: 'dc-',
    tag: 'devchain',
    sslFingerprint: new X509Certificate(certPem).fingerprint256,
    caPem,
    tokenId: 'root@pam!devchain',
    tokenSecretCiphertext: 'encrypted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function provider(overrides: Partial<VmProviderConnection> = {}): ProxmoxVmProvider {
  return new ProxmoxVmProvider(
    new ProxmoxClient({ requestTimeoutMs: 1000, maxResponseBytes: 64 * 1024 }),
    connection(overrides),
    TOKEN_SECRET,
  );
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-vm-provider-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '2',
      '-subj',
      '/CN=test-ca',
    ],
    { cwd: dir, stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
      '-subj',
      '/CN=localhost',
    ],
    { cwd: dir, stdio: 'ignore' },
  );
  fs.writeFileSync(
    path.join(dir, 'san.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'server.crt',
      '-days',
      '2',
      '-extfile',
      'san.ext',
    ],
    { cwd: dir, stdio: 'ignore' },
  );
  caPem = fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8');
  certPem = fs.readFileSync(path.join(dir, 'server.crt'), 'utf8');
  server = https.createServer(
    { key: fs.readFileSync(path.join(dir, 'server.key')), cert: certPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', `https://127.0.0.1:${port}`);
        seen.push({ method: req.method ?? '', path: url.pathname + url.search, body });
        handler(req.method ?? '', url, body, (status, data) => {
          res.statusCode = status;
          res.end(JSON.stringify({ data }));
        });
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  createdProbeVmids.length = 0;
});

const RIGHTS: Record<string, string[]> = {
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

function permissionHandler(
  options: {
    without?: string[];
    outsidePoolAllocate?: boolean;
    nextId?: string;
    candidateAcl?: unknown;
    version?: string;
    guestAgentAudit?: boolean;
    guestAgentFileRead?: boolean;
  } = {},
): void {
  handler = (method, url, body, respond) => {
    if (url.pathname === '/api2/json/version') {
      return respond(200, { version: options.version ?? '8.4.1' });
    }
    if (url.pathname === '/api2/json/nodes/hw/storage/local/content') return respond(200, []);
    if (url.pathname === '/api2/json/cluster/nextid') return respond(200, options.nextId ?? '101');
    if (url.pathname === '/api2/json/access/permissions') {
      const aclPath = url.searchParams.get('path') ?? '';
      if (aclPath === '/vms/101') {
        if (Object.prototype.hasOwnProperty.call(options, 'candidateAcl')) {
          return respond(200, options.candidateAcl);
        }
        return respond(200, { [aclPath]: options.outsidePoolAllocate ? { 'VM.Allocate': 1 } : {} });
      }
      const versionMajor = Number.parseInt((options.version ?? '8').split('.')[0], 10);
      const availableRights = [...(RIGHTS[aclPath] ?? [])].filter(
        (right) => !(versionMajor >= 9 && right === 'VM.Monitor'),
      );
      if (aclPath === '/pool/devchain' && options.guestAgentAudit) {
        availableRights.push('VM.GuestAgent.Audit');
      }
      if (aclPath === '/pool/devchain' && options.guestAgentFileRead) {
        availableRights.push('VM.GuestAgent.FileRead');
      }
      return respond(200, {
        [aclPath]: Object.fromEntries(
          availableRights
            .filter((right) => !(options.without ?? []).includes(right))
            .map((right) => [right, 0]),
        ),
      });
    }
    if (method === 'POST' && url.pathname === '/api2/json/nodes/hw/qemu') {
      const params = Object.fromEntries(new URLSearchParams(body));
      const vmid = Number(params.vmid);
      if (!Number.isInteger(vmid) || vmid < 100) return respond(400, null);
      if (!params.pool && !options.outsidePoolAllocate) return respond(403, null);
      createdProbeVmids.push(vmid);
      return respond(200, 'UPID:created');
    }
    throw new Error(`Unexpected ${method} ${url.pathname} ${body}`);
  };
}

describe('ProxmoxVmProvider over fake HTTPS', () => {
  it('accepts pool-scoped rights after checking a free VMID without creating anything', async () => {
    permissionHandler();
    await expect(provider().checkPermissions()).resolves.toEqual({ ok: true, missing: [] });
    expect(
      seen.some(
        (request) => request.path === '/api2/json/nodes/hw/storage/local/content?content=import',
      ),
    ).toBe(true);
    expect(
      seen.filter((request) => request.path.startsWith('/api2/json/access/permissions?')),
    ).toHaveLength(6);
    expect(
      seen.some((request) => request.path === '/api2/json/access/permissions?path=%2Fvms%2F101'),
    ).toBe(true);
    expect(seen.some((request) => request.method === 'POST')).toBe(false);
    expect(createdProbeVmids).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN_SECRET);
  });

  it.each([
    [{ version: '9.0.0', guestAgentAudit: true, guestAgentFileRead: true }, []],
    [{ version: '9.0.0', guestAgentAudit: true }, ['VM.GuestAgent.FileRead on /pool/devchain']],
    [{ without: ['VM.Monitor'] }, ['VM.Monitor on /pool/devchain']],
    [
      { version: '9.0.0' },
      ['VM.GuestAgent.Audit on /pool/devchain', 'VM.GuestAgent.FileRead on /pool/devchain'],
    ],
  ])('reports guest-agent permission partitions %p', async (options, missing) => {
    permissionHandler(options as Parameters<typeof permissionHandler>[0]);
    const result = await provider().checkPermissions();
    expect(result.ok).toBe(missing.length === 0);
    expect(result.missing).toEqual(missing);
  });

  it('names each missing ACL privilege', async () => {
    permissionHandler({
      without: ['VM.Clone', 'Datastore.AllocateTemplate', 'SDN.Use', 'Sys.AccessNetwork'],
    });
    const result = await provider().checkPermissions();
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        'VM.Clone on /pool/devchain',
        'Datastore.AllocateTemplate on /storage/local',
        'SDN.Use on /sdn/zones/localnetwork/vmbr0',
        'Sys.AccessNetwork on /nodes/hw',
      ]),
    );
  });

  it('rejects excessive allocation rights on a free VMID without submitting a create', async () => {
    permissionHandler({ outsidePoolAllocate: true });
    const result = await provider().checkPermissions();
    expect(result).toMatchObject({ ok: false });
    expect(result.missing).toContain('VM.Allocate outside pool');
    expect(seen.some((request) => request.method === 'POST')).toBe(false);
    expect(createdProbeVmids).toEqual([]);
  });

  it('treats an empty effective ACL map as no rights', async () => {
    permissionHandler({ candidateAcl: {} });
    await expect(provider().checkPermissions()).resolves.toEqual({ ok: true, missing: [] });
    expect(seen.some((request) => request.method === 'POST')).toBe(false);
  });

  it.each([
    null,
    [],
    'invalid',
    { '/vms/101': null },
    { '/vms/101': [] },
    { '/unexpected': {} },
    { '/vms/101': { 'VM.Allocate': '0' } },
  ])('fails closed on malformed candidate ACL %j', async (candidateAcl) => {
    permissionHandler({ candidateAcl });
    const result = await provider().checkPermissions();
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('VM.Allocate outside pool (could not verify)');
    expect(seen.some((request) => request.method === 'POST')).toBe(false);
  });

  it.each(['invalid-id', '1'])(
    'models validation before permission checks and fails closed on nextid %s',
    async (nextId) => {
      permissionHandler({ nextId });
      const result = await provider().checkPermissions();
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(
        expect.arrayContaining([
          'VM.Allocate (nextid)',
          'VM.Allocate outside pool (could not verify)',
        ]),
      );
      expect(createdProbeVmids).toEqual([]);
    },
  );

  it('does not send a token to a self-signed node without CA trust', async () => {
    permissionHandler();
    const result = await provider({ caPem: null }).checkPermissions();
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('API access');
    expect(seen).toEqual([]);
  });

  function destroyHandler(
    options: { inPool?: boolean; tags?: string; name?: string; status?: string } = {},
  ): void {
    handler = (method, url, _body, respond) => {
      if (url.pathname === '/api2/json/nodes/hw/qemu')
        return respond(200, [
          { vmid: 101, name: options.name ?? 'dc-vm', status: options.status ?? 'stopped' },
        ]);
      if (url.pathname === '/api2/json/cluster/resources')
        return respond(200, [
          {
            vmid: 101,
            node: 'hw',
            name: options.name ?? 'dc-vm',
            status: options.status ?? 'stopped',
          },
        ]);
      if (url.pathname === '/api2/json/nodes/hw/qemu/101/config')
        return respond(200, {
          smbios1: `uuid=${VM_IDENTITY}`,
          tags: options.tags ?? 'devchain',
          name: options.name ?? 'dc-vm',
        });
      if (url.pathname === '/api2/json/pools/devchain')
        return respond(200, {
          members: options.inPool === false ? [] : [{ vmid: 101, id: 'qemu/101' }],
        });
      if (method === 'DELETE' && url.pathname === '/api2/json/nodes/hw/qemu/101')
        return respond(200, 'UPID:delete');
      if (method === 'POST' && url.pathname === '/api2/json/nodes/hw/qemu/101/status/stop')
        return respond(200, 'UPID:stop');
      if (
        url.pathname === '/api2/json/nodes/hw/tasks/UPID%3Adelete/status' ||
        url.pathname === '/api2/json/nodes/hw/tasks/UPID%3Astop/status'
      )
        return respond(200, { status: 'stopped', exitstatus: 'OK' });
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    };
  }

  it.each([
    ['outside pool', { inPool: false }, {}, 'pool'],
    ['without tag', { tags: 'other' }, {}, 'tag'],
    ['wrong prefix', { name: 'other-vm' }, {}, 'name prefix'],
    ['outside VMID range', {}, { vmidMax: 100 }, 'VMID range'],
  ] as const)('refuses destroy %s', async (_case, state, config, expected) => {
    destroyHandler(state);
    await expect(provider(config).destroyVm(VM_IDENTITY)).rejects.toThrow(expected);
    expect(seen.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('deletes only a guarded VM with purge and unreferenced disk cleanup', async () => {
    destroyHandler();
    await provider().destroyVm(VM_IDENTITY);
    expect(seen.find((request) => request.method === 'DELETE')?.path).toBe(
      '/api2/json/nodes/hw/qemu/101?purge=1&destroy-unreferenced-disks=1',
    );
    expect(
      seen.some((request) => request.path === '/api2/json/nodes/hw/tasks/UPID%3Adelete/status'),
    ).toBe(true);
  });

  it('returns the current guarded Proxmox name for reset', async () => {
    destroyHandler({ name: 'dc-original-name' });
    await expect(provider().getOwnedVm(VM_IDENTITY)).resolves.toEqual({
      vmid: 101,
      name: 'dc-original-name',
    });
    expect(seen.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('checks the VMID guard before recovery cleanup', async () => {
    destroyHandler({ tags: 'other' });
    await expect(provider().assertOwnedVmid(101)).rejects.toThrow('tag');
    expect(seen.some((request) => request.method === 'DELETE')).toBe(false);
    destroyHandler();
    await expect(provider().assertOwnedVmid(101)).resolves.toBeUndefined();
    await provider().destroyOwnedVmid(101);
    expect(seen.find((request) => request.method === 'DELETE')?.path).toBe(
      '/api2/json/nodes/hw/qemu/101?purge=1&destroy-unreferenced-disks=1',
    );
  });

  it('stops a running VM before guarded deletion', async () => {
    destroyHandler({ status: 'running' });
    await provider().destroyVm(VM_IDENTITY);
    const stop = seen.findIndex((request) => request.path.endsWith('/status/stop'));
    const deletion = seen.findIndex((request) => request.method === 'DELETE');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(stop);
  });
});
