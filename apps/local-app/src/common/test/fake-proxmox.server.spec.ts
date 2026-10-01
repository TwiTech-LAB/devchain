import { ProxmoxClient } from '@devchain/proxmox-client';
import { FakeProxmoxServer } from './fake-proxmox.server';
import { fixtureTls } from './tls-fixture';

describe('FakeProxmoxServer HTTPS contract', () => {
  let server: FakeProxmoxServer;
  const client = new ProxmoxClient({ requestTimeoutMs: 2_000, maxResponseBytes: 64 * 1024 });

  beforeEach(async () => {
    server = new FakeProxmoxServer();
    await server.listen();
  });
  afterEach(async () => server.close());

  const target = (server: FakeProxmoxServer) => ({
    origin: server.origin,
    tokenId: server.tokenId,
    tokenSecret: server.tokenSecret,
    caPem: server.caPem,
    tlsFingerprint: server.fingerprint,
  });

  it('verifies the self-signed certificate and rejects a changed leaf before HTTP', async () => {
    await expect(client.getVersion(target(server))).resolves.toMatchObject({ version: '8.4' });
    const before = server.calls.length;
    await expect(
      client.getVersion({
        ...target(server),
        tlsFingerprint: '00'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'proxmox_tls' });
    expect(server.calls).toHaveLength(before);
    expect(JSON.stringify(server.calls)).not.toContain(server.tokenSecret);
  });

  it('validates VMID before authorization and denies valid out-of-pool create', async () => {
    const request = (vmid: number) =>
      client.request(target(server), {
        method: 'POST',
        path: '/api2/json/nodes/hw/qemu',
        body: { vmid: String(vmid), name: 'probe' },
      });
    await expect(request(0)).rejects.toMatchObject({
      code: 'proxmox_api',
      details: { httpStatus: 400 },
    });
    await expect(request(101)).rejects.toMatchObject({ code: 'proxmox_denied' });
    expect(server.vms.has(101)).toBe(false);
    expect(await client.getNextId(target(server))).toBe(100);
    expect(await client.getOwnVmAclPermissions(target(server), 100)).toEqual({ '/vms/100': {} });
  });

  it('applies pool ACL grants to mutation and effective-permissions reads', async () => {
    server.deny('/pool/devchain', 'VM.Allocate');
    expect(
      await client.request(target(server), {
        method: 'GET',
        path: '/api2/json/access/permissions?path=%2Fpool%2Fdevchain',
      }),
    ).not.toMatchObject({ '/pool/devchain': { 'VM.Allocate': 0 } });
    await expect(
      client.createVm(target(server), 'hw', {
        vmid: 100,
        pool: 'devchain',
        tags: 'devchain',
        name: 'devchain-test',
        scsi0ImportFrom: 'local-lvm:0,import-from=local:import/image.qcow2',
        cloudInitDrive: 'local-lvm:cloudinit',
        agent: 'enabled=1',
        ipconfig0: 'ip=dhcp',
        net0: 'virtio,bridge=vmbr0',
        cores: 1,
        memory: 1024,
      }),
    ).rejects.toMatchObject({ code: 'proxmox_denied' });
    expect(server.vms.has(100)).toBe(false);
  });

  it('serves the guest certificate through agent/file-read like PVE 8', async () => {
    const read = () =>
      client.readAgentFile(target(server), 'hw', 199, '/etc/devchain-host/tls/cert.pem', 16_384);
    await expect(read()).rejects.toMatchObject({ details: { httpStatus: 500 } });
    server.vms.get(199)!.status = 'running';
    await expect(read()).resolves.toBe(fixtureTls.cert);
    server.guestCertificate = null;
    await expect(read()).rejects.toMatchObject({ details: { httpStatus: 500 } });
    server.guestCertificate = fixtureTls.cert;
    server.deny('/pool/devchain', 'VM.Monitor');
    await expect(read()).rejects.toMatchObject({ code: 'proxmox_denied' });
  });
});
