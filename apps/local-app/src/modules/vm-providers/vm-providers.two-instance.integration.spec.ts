import { X509Certificate } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resetEnvConfig } from '../../common/config/env.config';
import { FakeBootstrapServer } from '../../common/test/fake-bootstrap.server';
import { FakeProxmoxServer } from '../../common/test/fake-proxmox.server';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import type { RemoteOperation } from '../storage/models/domain.models';
import { ProviderAuthWritebackService } from '../provider-auth/provider-auth-writeback.service';
import { RemoteOperationRunner } from '../remotes/operations/remote-operation.runner';
import { ProviderAuthVaultService } from '../provider-auth/provider-auth-vault.service';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import type { ConnectProxmoxPlacement } from './vm-providers.service';

const VM_PORT = 4000;
const VM_IP = '127.0.0.2';
/** The VM bootstrap port is fixed in product code; the fake VM must listen on it. */
const BOOTSTRAP_PORT = 3000;

// A DevChain running on this PC usually holds 0.0.0.0:3000, which makes the
// fake VM's bootstrap address unavailable. Skip with the reason instead of hanging.
const bootstrapPortFree =
  spawnSync(
    process.execPath,
    [
      '-e',
      `const s = require('node:net').createServer();
       s.once('error', () => process.exit(1));
       s.listen(${BOOTSTRAP_PORT}, '${VM_IP}', () => s.close(() => process.exit(0)));`,
    ],
    { timeout: 5_000 },
  ).status === 0;
const describeWithBootstrapPort = bootstrapPortFree ? describe : describe.skip;
// Jest lists no titles for a fully skipped file, so say why here.
if (!bootstrapPortFree) {
  console.warn(
    `Proxmox two-instance suite skipped: ${VM_IP}:${BOOTSTRAP_PORT} is in use; stop the local DevChain to run it.`,
  );
}

function expectCallsInOrder(
  calls: ReadonlyArray<{ method: string; path: string }>,
  expected: RegExp[],
): void {
  const lines = calls.map((call) => `${call.method} ${call.path}`);
  let previous = -1;
  for (const pattern of expected) {
    const index = lines.findIndex((line, offset) => offset > previous && pattern.test(line));
    if (index <= previous) {
      throw new Error(`Missing ${pattern} after call ${previous}:\n${lines.join('\n')}`);
    }
    previous = index;
  }
}

async function post<T>(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

async function done(homeUrl: string, operationId: string): Promise<RemoteOperation> {
  return waitForValue(
    async () => {
      const response = await fetch(`${homeUrl}/api/remotes/operations/${operationId}`);
      const operation = (await response.json()) as RemoteOperation;
      if (operation.state === 'failed') {
        throw new Error(
          `Operation ${operation.kind} failed at ${operation.steps.find((step) => step.state === 'failed')?.id}: ${JSON.stringify(operation.steps.find((step) => step.state === 'failed')?.error)}`,
        );
      }
      return operation.state === 'done' ? operation : null;
    },
    90_000,
    100,
  );
}

describeWithBootstrapPort('Proxmox create and reset through two DevChain instances', () => {
  let instances: TwoInstances;
  let proxmox: FakeProxmoxServer;
  let bootstrap: FakeBootstrapServer;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of ['PORT', 'HOST_IMAGE_URL', 'HOST_IMAGE_SHA256', 'DEVCHAIN_HOST_ETC_DIR']) {
      savedEnv.set(key, process.env[key]);
    }
    proxmox = new FakeProxmoxServer();
    await proxmox.listen();
    process.env.PORT = String(VM_PORT);
    process.env.HOST_IMAGE_URL = proxmox.imageUrl;
    process.env.HOST_IMAGE_SHA256 = proxmox.imageSha256;
    resetEnvConfig();
    bootstrap = new FakeBootstrapServer();
    await bootstrap.listen({ host: VM_IP, port: BOOTSTRAP_PORT });
    proxmox.guestCertificate = bootstrap.certificate;
    instances = await startTwoInstances({
      hostBind: { address: VM_IP, port: VM_PORT },
      healthIntervalMs: 200,
      timeSettleTimeoutMs: 1_000,
    });
    const etcDir = join(instances.rootDir, 'host-etc');
    mkdirSync(etcDir, { recursive: true });
    writeFileSync(join(etcDir, 'claim.json'), '{}');
    process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
    resetEnvConfig();
    proxmox.onDelete = async (vmid) => {
      if (vmid === 199) throw new Error('Outside-pool VM must never be deleted');
      bootstrap.version = null;
      await instances.replaceHost();
    };
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
    await bootstrap?.close();
    await proxmox?.close();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvConfig();
  }, 30_000);

  it('connects, creates, claims, attaches, resets and reattaches with exact Proxmox calls', async () => {
    const uri = proxmox.connectionString();
    const preview = await post<{
      confirmationRequired: boolean;
      fingerprint: string;
      placement: ConnectProxmoxPlacement;
    }>(instances.home.url, '/api/vm-providers/proxmox/connect', {
      connectionString: uri,
    });
    expect(preview).toMatchObject({
      status: 200,
      data: {
        confirmationRequired: true,
        fingerprint: proxmox.fingerprint,
        placement: {
          apiUrl: `https://127.0.0.1:${new URL(proxmox.origin).port}`,
          node: 'hw',
          pool: 'devchain',
          storage: 'local-lvm',
          imageStorage: 'local',
          bridge: 'vmbr0',
        },
      },
    });
    expect(proxmox.calls).toEqual([]);
    const connected = await post<{
      confirmationRequired: boolean;
      connection: { id: string; caPem: string };
      permissions: { ok: boolean; missing: string[] };
    }>(instances.home.url, '/api/vm-providers/proxmox/connect', {
      connectionString: uri,
      confirmFingerprint: true,
    });
    expect(connected.status).toBe(200);
    expect(connected.data.permissions).toEqual({ ok: true, missing: [] });
    expect(connected.data.connection.caPem).toBe(proxmox.caPem);
    expect(proxmox.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(proxmox.calls.some((call) => call.path === '/cluster/nextid')).toBe(true);
    expect(
      proxmox.calls.some((call) => call.path.startsWith('/access/permissions?path=%2Fvms%2F')),
    ).toBe(true);

    const createCallStart = proxmox.calls.length;
    const create = await post<RemoteOperation>(
      instances.home.url,
      `/api/vm-providers/${connected.data.connection.id}/create-vm`,
      {
        name: 'alpha',
        cores: 2,
        memory: 4096,
        disk: 30,
        port: VM_PORT,
        providerAuth: {},
      },
    );
    expect(create.status).toBe(202);
    const created = await done(instances.home.url, create.data.id);
    expect(created.steps.every((step) => step.state === 'done' || step.state === 'skipped')).toBe(
      true,
    );
    expect(created.steps.map((step) => step.id)).toEqual([
      'vm_preflight',
      'ensure_image',
      'ensure_template',
      'clone',
      'configure',
      'start',
      'wait_ip',
      'claim_preflight',
      'claim_provider_auth_resolve',
      'claim_build_bundle',
      'claim_claim',
      'claim_verify_providers',
      'claim_ssh_keys',
      'claim_register_remote',
      'claim_docker',
    ]);
    const original = await instances.home.storage.getRemote(created.remoteId);
    expect(original).toMatchObject({
      kind: 'proxmox',
      name: 'alpha',
      baseUrl: `https://${VM_IP}:${VM_PORT}`,
      vmIdentity: '00000000-0000-4000-8000-000000000101',
      tlsCertificate: new X509Certificate(bootstrap.certificate).toString(),
    });
    expect(bootstrap.claims).toHaveLength(1);
    expectCallsInOrder(proxmox.calls.slice(createCallStart), [
      /^GET \/version$/,
      /^GET \/cluster\/nextid$/,
      /^GET \/access\/permissions\?path=%2Fvms%2F100$/,
      /^GET \/cluster\/nextid\?vmid=100$/,
      /^GET \/nodes\/hw\/storage\/local\/content\?content=import$/,
      /^POST \/nodes\/hw\/storage\/local\/download-url$/,
      /^GET \/nodes\/hw\/tasks\/UPID%3Afake%3A\d+\/status$/,
      /^POST \/nodes\/hw\/qemu$/,
      /^GET \/nodes\/hw\/qemu\/100\/config$/,
      /^GET \/pools\/devchain$/,
      /^POST \/nodes\/hw\/qemu\/100\/template$/,
      /^POST \/nodes\/hw\/qemu\/100\/clone$/,
      /^GET \/nodes\/hw\/qemu\/101\/config$/,
      /^PUT \/nodes\/hw\/qemu\/101\/config$/,
      /^PUT \/nodes\/hw\/qemu\/101\/resize$/,
      /^POST \/nodes\/hw\/qemu\/101\/status\/start$/,
      /^GET \/nodes\/hw\/qemu\/101\/agent\/network-get-interfaces$/,
      /^GET \/nodes\/hw\/qemu\/101\/agent\/file-read\?file=%2Fetc%2Fdevchain-host%2Ftls%2Fcert\.pem$/,
    ]);
    expect(
      proxmox.calls.find(
        (call) => call.method === 'POST' && call.path === '/nodes/hw/storage/local/download-url',
      )?.body,
    ).toMatchObject({ checksum: proxmox.imageSha256, 'checksum-algorithm': 'sha256' });
    expect(
      proxmox.calls.find((call) => call.path === '/nodes/hw/qemu' && call.method === 'POST')?.body,
    ).toMatchObject({ pool: 'devchain', tags: 'devchain' });

    const projectRoot = join(instances.home.dataDir, 'workspace');
    mkdirSync(projectRoot, { recursive: true });
    const project = await instances.home.storage.createProject({
      name: 'Project on VM',
      description: null,
      rootPath: projectRoot,
      isTemplate: false,
    });
    const attach = await post<RemoteOperation>(
      instances.home.url,
      `/api/remotes/${original.id}/attach`,
      { projectId: project.id },
    );
    expect(attach.status).toBe(202);
    expect((await done(instances.home.url, attach.data.id)).state).toBe('done');
    expect(await instances.home.storage.getRemoteProjectBinding(project.id)).toMatchObject({
      remoteId: original.id,
      state: 'remote',
    });

    const resetCallStart = proxmox.calls.length;
    const reset = await post<RemoteOperation>(
      instances.home.url,
      `/api/remotes/${original.id}/reset`,
      {
        force: false,
        port: VM_PORT,
        providerAuth: {},
      },
    );
    expect(reset.status).toBe(202);
    const completed = await done(instances.home.url, reset.data.id);
    expect(completed.steps.every((step) => step.state === 'done' || step.state === 'skipped')).toBe(
      true,
    );
    const steps = completed.steps.map((step) => step.id);
    expect(steps.indexOf('pull_families')).toBeLessThan(steps.indexOf('destroy'));
    expect(steps.indexOf(`detach:${project.id}:final_pull`)).toBeLessThan(steps.indexOf('destroy'));
    expect(steps.indexOf('destroy')).toBeLessThan(steps.indexOf('create_clone'));
    expect(steps.indexOf('create_claim_claim')).toBeLessThan(
      steps.indexOf(`attach:${project.id}:bind_remote`),
    );
    expect(completed.details.familyPull).toMatchObject({ pulled: true, families: [] });
    expectCallsInOrder(proxmox.calls.slice(resetCallStart), [
      /^GET \/cluster\/resources\?type=vm$/,
      /^GET \/nodes\/hw\/qemu\/101\/config$/,
      /^GET \/pools\/devchain$/,
      /^GET \/nodes\/hw\/qemu\/101\/config$/,
      /^GET \/pools\/devchain$/,
      /^POST \/nodes\/hw\/qemu\/101\/status\/stop$/,
      /^GET \/nodes\/hw\/tasks\/UPID%3Afake%3A\d+\/status$/,
      /^DELETE \/nodes\/hw\/qemu\/101\?.*purge=1.*destroy-unreferenced-disks=1$/,
      /^GET \/nodes\/hw\/tasks\/UPID%3Afake%3A\d+\/status$/,
      /^GET \/nodes\/hw\/storage\/local\/content\?content=import$/,
      /^POST \/nodes\/hw\/qemu\/100\/clone$/,
      /^PUT \/nodes\/hw\/qemu\/101\/config$/,
      /^PUT \/nodes\/hw\/qemu\/101\/resize$/,
      /^POST \/nodes\/hw\/qemu\/101\/status\/start$/,
      /^GET \/nodes\/hw\/qemu\/101\/agent\/network-get-interfaces$/,
      /^GET \/nodes\/hw\/qemu\/101\/agent\/file-read\?file=%2Fetc%2Fdevchain-host%2Ftls%2Fcert\.pem$/,
    ]);
    expect(proxmox.destroyed).toEqual([101]);
    expect(proxmox.vms.has(199)).toBe(true);
    expect(proxmox.vms.has(100)).toBe(true);
    expect(proxmox.vms.get(101)?.smbios1).toBe('uuid=00000000-0000-4000-8000-000000000102');
    expect(
      proxmox.calls.filter(
        (call) => call.method === 'POST' && call.path === '/nodes/hw/storage/local/download-url',
      ),
    ).toHaveLength(1);
    expect(
      proxmox.calls.filter((call) => call.method === 'POST' && call.path === '/nodes/hw/qemu'),
    ).toHaveLength(1);
    expect(
      proxmox.calls.filter(
        (call) => call.method === 'DELETE' && call.path.startsWith('/nodes/hw/qemu/101?'),
      ),
    ).toHaveLength(1);
    expect(bootstrap.claims).toHaveLength(2);
    const current = await instances.home.storage.getRemote(original.id);
    expect(current).toMatchObject({
      id: original.id,
      name: original.name,
      baseUrl: `https://${VM_IP}:${VM_PORT}`,
      vmIdentity: '00000000-0000-4000-8000-000000000102',
      tlsCertificate: original.tlsCertificate,
    });
    expect(completed.details.tlsCertificate).toBe(original.tlsCertificate);
    expect(await instances.home.storage.getRemoteProjectBinding(project.id)).toMatchObject({
      remoteId: original.id,
      state: 'remote',
    });
    expect(
      instances.host.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id),
    ).toBeTruthy();
    expect(JSON.stringify(proxmox.calls)).not.toContain(proxmox.tokenSecret);
  }, 120_000);

  it('runs the opt-in proof through claim and guarded cleanup against the fake services', async () => {
    const envPath = join(instances.rootDir, 'proxmox-proof.env');
    writeFileSync(
      envPath,
      [
        `PROXMOX_API_URL=${proxmox.origin}/api2/json`,
        `PROXMOX_TOKEN_ID=${proxmox.tokenId}`,
        `PROXMOX_TOKEN_SECRET=${proxmox.tokenSecret}`,
        'PROXMOX_NODE=hw',
        'PROXMOX_POOL=devchain',
        'PROXMOX_STORAGE=local-lvm',
        'PROXMOX_ISO_STORAGE=local',
        'PROXMOX_BRIDGE=vmbr0',
        'PROXMOX_VMID_MIN=100',
        'PROXMOX_VMID_MAX=198',
        'PROXMOX_NAME_PREFIX=devchain-',
        'PROXMOX_TAG=devchain',
        'PROXMOX_VERIFY_SSL=false',
        `PROXMOX_SSL_FINGERPRINT=${proxmox.fingerprint}`,
        `HOST_IMAGE_URL=${proxmox.imageUrl}`,
        `HOST_IMAGE_SHA256=${proxmox.imageSha256}`,
      ].join('\n'),
    );
    const oldVmids = new Set(proxmox.vms.keys());
    const firstCall = proxmox.calls.length;
    const firstClaim = bootstrap.claims.length;
    const firstDestroy = proxmox.destroyed.length;
    bootstrap.version = null;
    proxmox.onDelete = null;
    const proof = resolve(__dirname, '../../../scripts/remote-proofs/proxmox-live-acceptance.mjs');
    const child = spawn(process.execPath, [proof, '--env', envPath, '--port', String(VM_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exit = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolveExit(code ?? 1));
    });
    expect(exit).toBe(0);
    expect(output).toContain('[OK] Published image and SHA-256 reachable');
    expect(output).toContain('[OK]   POST bootstrap claim');
    expect(output).toContain('[OK]   clone: DELETE /nodes/hw/qemu/');
    expect(output).toContain('Result: PASSED');
    expect(output).not.toContain(proxmox.tokenSecret);
    expect(bootstrap.claims).toHaveLength(firstClaim + 1);
    expect(bootstrap.claims.at(-1)).toMatchObject({ port: VM_PORT });
    expect(proxmox.destroyed).toHaveLength(firstDestroy + 2);
    expect([...proxmox.vms.keys()].sort()).toEqual([...oldVmids].sort());
    expect(proxmox.calls.slice(firstCall)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/nodes/hw/qemu' }),
        expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/clone$/) }),
        expect.objectContaining({ method: 'DELETE', path: expect.stringMatching(/\/qemu\/\d+\?/) }),
      ]),
    );
  }, 120_000);

  it('refuses a bound remote, then pulls families and destroys its VM through the HTTP route', async () => {
    bootstrap.version = null;
    proxmox.onDelete = null;
    const connected = await post<{
      connection: { id: string };
    }>(instances.home.url, '/api/vm-providers/proxmox/connect', {
      connectionString: proxmox.connectionString(),
      confirmFingerprint: true,
    });
    expect(connected.status).toBe(200);
    const create = await post<RemoteOperation>(
      instances.home.url,
      `/api/vm-providers/${connected.data.connection.id}/create-vm`,
      {
        name: 'discard',
        cores: 2,
        memory: 4096,
        disk: 30,
        port: VM_PORT,
        providerAuth: {},
      },
    );
    expect(create.status).toBe(202);
    const created = await done(instances.home.url, create.data.id);
    const remote = await instances.home.storage.getRemote(created.remoteId);
    const vmid = [...proxmox.vms].find(([, vm]) => vm.smbios1 === `uuid=${remote.vmIdentity}`)?.[0];
    expect(vmid).toBeDefined();
    const project = await instances.home.storage.createProject({
      name: 'Must disconnect first',
      description: null,
      rootPath: join(instances.home.dataDir, 'bound-discard'),
      isTemplate: false,
    });
    await instances.home.storage.createRemoteProjectBinding({
      projectId: project.id,
      remoteId: remote.id,
    });
    const beforeCalls = proxmox.calls.length;
    const beforeOperations = await instances.home.storage.listRemoteOperations({
      remoteId: remote.id,
    });
    const refused = await post<{ details: { code: string } }>(
      instances.home.url,
      `/api/remotes/${remote.id}/destroy-vm`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.data.details.code).toBe('REMOTE_HAS_PROJECT_BINDINGS');
    expect(proxmox.calls).toHaveLength(beforeCalls);
    expect(await instances.home.storage.listRemoteOperations({ remoteId: remote.id })).toEqual(
      beforeOperations,
    );
    await instances.home.storage.deleteRemoteProjectBinding(project.id);

    const vm = proxmox.vms.get(vmid!)!;
    for (const [field, value] of [
      ['pool', 'other'],
      ['tags', 'other'],
    ] as const) {
      const original = vm[field];
      vm[field] = value;
      const firstGuardCall = proxmox.calls.length;
      const guarded = await post<RemoteOperation>(
        instances.home.url,
        `/api/remotes/${remote.id}/destroy-vm`,
        {},
      );
      expect(guarded.status).toBe(202);
      const failed = await waitForValue(async () => {
        const response = await fetch(
          `${instances.home.url}/api/remotes/operations/${guarded.data.id}`,
        );
        const operation = (await response.json()) as RemoteOperation;
        return operation.state === 'failed' ? operation : null;
      }, 10_000);
      expect(failed.steps[0]).toMatchObject({ id: 'preflight', state: 'failed' });
      expect(proxmox.vms.has(vmid!)).toBe(true);
      expect(await instances.home.storage.getRemote(remote.id)).toMatchObject({ id: remote.id });
      expect(proxmox.calls.slice(firstGuardCall).some((call) => call.method === 'DELETE')).toBe(
        false,
      );
      const cancelled = await post<RemoteOperation>(
        instances.home.url,
        `/api/remotes/operations/${guarded.data.id}/cancel`,
        {},
      );
      expect(cancelled).toMatchObject({ status: 200, data: { state: 'cancelled' } });
      vm[field] = original;
    }

    const events: string[] = [];
    const writeback = instances.home.app.get(ProviderAuthWritebackService);
    const originalPull = writeback.pullFamiliesNow.bind(writeback);
    const pull = jest.spyOn(writeback, 'pullFamiliesNow').mockImplementation(async (id) => {
      events.push('pull');
      return originalPull(id);
    });
    proxmox.onDelete = async () => {
      events.push('delete');
    };
    try {
      const firstCall = proxmox.calls.length;
      const started = await post<RemoteOperation>(
        instances.home.url,
        `/api/remotes/${remote.id}/destroy-vm`,
        {},
      );
      expect(started.status).toBe(202);
      expect(started.data).toMatchObject({ kind: 'destroy_vm', remoteId: remote.id });
      await waitForValue(
        async () =>
          (await instances.home.storage.listRemotes()).items.some((item) => item.id === remote.id)
            ? null
            : true,
        10_000,
      );
      expect(events).toEqual(['pull', 'delete']);
      expect(proxmox.vms.has(vmid!)).toBe(false);
      expect(proxmox.vms.has(199)).toBe(true);
      expect(await instances.home.storage.listRemoteOperations({ remoteId: remote.id })).toEqual(
        [],
      );
      expectCallsInOrder(proxmox.calls.slice(firstCall), [
        /^GET \/cluster\/resources\?type=vm$/,
        new RegExp(`^GET /nodes/hw/qemu/${vmid}/config$`),
        /^GET \/pools\/devchain$/,
        new RegExp(`^POST /nodes/hw/qemu/${vmid}/status/stop$`),
        new RegExp(`^DELETE /nodes/hw/qemu/${vmid}\\?purge=1&destroy-unreferenced-disks=1$`),
      ]);
    } finally {
      pull.mockRestore();
      proxmox.onDelete = null;
    }
  }, 120_000);

  it('keeps a completed destroy after cleanup failure so registration-only DELETE can finish', async () => {
    proxmox.onDelete = null;
    const connection = await instances.home.storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'Cleanup test',
      apiUrl: proxmox.origin,
      node: 'hw',
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 198,
      namePrefix: 'devchain-',
      tag: 'devchain',
      sslFingerprint: proxmox.fingerprint,
      caPem: proxmox.caPem,
      tokenId: proxmox.tokenId,
      tokenSecret: proxmox.tokenSecret,
    });
    const vmid = 150;
    const identity = '00000000-0000-4000-8000-000000000150';
    proxmox.vms.set(vmid, {
      vmid,
      name: 'devchain-cleanup-test',
      description: '',
      tags: 'devchain',
      pool: 'devchain',
      template: 0,
      status: 'running',
      cores: 2,
      memory: 4096,
      scsi0: 'local-lvm:vm-150-disk-0,size=30G',
      smbios1: `uuid=${identity}`,
    });
    const remote = await instances.home.storage.createRemote({
      name: 'cleanup-test',
      kind: 'proxmox',
      baseUrl: `https://${VM_IP}:${VM_PORT}`,
      vmProviderConnectionId: connection.id,
      vmIdentity: identity,
      vmSpec: { cores: 2, memory: 4096, disk: 30 },
    });
    const cleanup = jest
      .spyOn(instances.home.storage, 'deleteRemote')
      .mockRejectedValueOnce(new Error('cleanup unavailable'));
    try {
      const started = await post<RemoteOperation>(
        instances.home.url,
        `/api/remotes/${remote.id}/destroy-vm`,
        {},
      );
      expect(started.status).toBe(202);
      await instances.home.app.get(RemoteOperationRunner).whenIdle(started.data.id);
      expect(proxmox.vms.has(vmid)).toBe(false);
      expect(await instances.home.storage.getRemoteOperation(started.data.id)).toMatchObject({
        state: 'done',
      });
      expect(await instances.home.storage.getRemote(remote.id)).toMatchObject({
        baseUrl: null,
        vmIdentity: null,
      });
      const deleted = await fetch(`${instances.home.url}/api/remotes/${remote.id}`, {
        method: 'DELETE',
      });
      expect(deleted.status).toBe(200);
      expect(
        (await instances.home.storage.listRemotes()).items.some((item) => item.id === remote.id),
      ).toBe(false);
    } finally {
      cleanup.mockRestore();
    }
  }, 120_000);

  it('reclaims a renamed VM with the prior user and static Claude login', async () => {
    bootstrap.version = null;
    const verify = jest
      .spyOn(instances.home.app.get(RemoteHostClient), 'verifyProviderAuth')
      .mockResolvedValue({ ok: true, summary: 'verified by fake host', hint: null });
    proxmox.onDelete = async (vmid) => {
      if (vmid === 199) throw new Error('Outside-pool VM must never be deleted');
      bootstrap.version = null;
      await instances.replaceHost();
    };
    const connection = await instances.home.storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'Remembered claim',
      apiUrl: proxmox.origin,
      node: 'hw',
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 198,
      namePrefix: 'devchain-',
      tag: 'devchain',
      sslFingerprint: proxmox.fingerprint,
      caPem: proxmox.caPem,
      tokenId: proxmox.tokenId,
      tokenSecret: proxmox.tokenSecret,
    });
    const claude = await instances.home.app.get(ProviderAuthVaultService).createStatic({
      provider: 'claude',
      label: 'Reset Claude token',
      token: 'test-static-claude-token',
    });
    const create = await post<RemoteOperation>(
      instances.home.url,
      `/api/vm-providers/${connection.id}/create-vm`,
      {
        name: 'remembered',
        cores: 2,
        memory: 4096,
        disk: 30,
        port: VM_PORT,
        providerAuth: { claude: `reuse:${claude.id}` },
      },
    );
    expect(create.status).toBe(202);
    const created = await done(instances.home.url, create.data.id);
    const original = await instances.home.storage.getRemote(created.remoteId);
    const vm = [...proxmox.vms.values()].find(
      (item) => item.smbios1 === `uuid=${original.vmIdentity}`,
    );
    expect(vm).toBeDefined();
    const oldVmName = vm!.name;
    const rename = await fetch(`${instances.home.url}/api/remotes/${original.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My VM' }),
    });
    expect(rename.status).toBe(200);
    const firstClaim = bootstrap.claims.length;
    const firstVerify = verify.mock.calls.length;
    const reset = await post<RemoteOperation>(
      instances.home.url,
      `/api/remotes/${original.id}/reset`,
      {},
    );
    expect(reset.status).toBe(202);
    const completed = await done(instances.home.url, reset.data.id);
    expect(completed.details).toMatchObject({
      port: VM_PORT,
      vmName: oldVmName,
      providerAuth: { claude: { entryIds: [claude.id] } },
    });
    expect(JSON.stringify(completed.details)).not.toContain('test-static-claude-token');
    expect(bootstrap.claims).toHaveLength(firstClaim + 1);
    expect(bootstrap.claims.at(-1)).toMatchObject({
      providerAuth: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-static-claude-token' } },
    });
    expect(verify.mock.calls.slice(firstVerify).some(([, provider]) => provider === 'claude')).toBe(
      true,
    );
    const current = await instances.home.storage.getRemote(original.id);
    expect(current.name).toBe('My VM');
    expect(current.vmIdentity).not.toBe(original.vmIdentity);
    expect(
      [...proxmox.vms.values()].find((item) => item.smbios1 === `uuid=${current.vmIdentity}`)?.name,
    ).toBe(oldVmName);
    verify.mockRestore();
    proxmox.onDelete = null;
  }, 120_000);
});
