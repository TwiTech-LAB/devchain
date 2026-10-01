import { FakeProxmoxServer } from '../../../common/test/fake-proxmox.server';
import { startTwoInstances, type TwoInstances } from '../../../common/test/two-instance.fixture';
import type { Remote } from '../../storage/models/domain.models';

const OWNED_VMID = 150;
const FOREIGN_VMID = 160;

function identity(vmid: number): string {
  return `00000000-0000-4000-8000-${String(vmid).padStart(12, '0')}`;
}

async function post(url: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const response = await fetch(
    url,
    body === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  return { status: response.status, data: await response.json() };
}

// Integration: the route through the real app, storage and ProxmoxClient against
// the HTTPS Proxmox fake, so the ownership guard reads real VM config and pools.
describe('POST /api/remotes/:id/power-on', () => {
  let instances: TwoInstances;
  let proxmox: FakeProxmoxServer;
  let connectionId: string;

  async function proxmoxRemote(name: string, vmIdentity: string | null): Promise<Remote> {
    return instances.home.storage.createRemote({
      name,
      kind: 'proxmox',
      baseUrl: 'http://127.0.0.1:1',
      vmProviderConnectionId: connectionId,
      vmIdentity,
      vmSpec: { cores: 2, memory: 4096, disk: 30 },
    });
  }

  function seedVm(vmid: number, owned: boolean): void {
    proxmox.vms.set(vmid, {
      vmid,
      name: owned ? 'devchain-worker' : 'someone-else',
      description: '',
      tags: owned ? 'devchain' : 'other',
      pool: owned ? 'devchain' : 'other',
      template: 0,
      status: 'stopped',
      cores: 2,
      memory: 4096,
      scsi0: `local-lvm:vm-${vmid}-disk-0,size=30G`,
      smbios1: `uuid=${identity(vmid)}`,
    });
  }

  function startCalls(vmid: number): number {
    return proxmox.calls.filter(
      (call) => call.method === 'POST' && call.path === `/nodes/hw/qemu/${vmid}/status/start`,
    ).length;
  }

  beforeAll(async () => {
    proxmox = new FakeProxmoxServer();
    await proxmox.listen();
    instances = await startTwoInstances({ healthIntervalMs: 600_000 });
    const connectionString = proxmox.connectionString();
    await post(`${instances.home.url}/api/vm-providers/proxmox/connect`, { connectionString });
    const connected = await post(`${instances.home.url}/api/vm-providers/proxmox/connect`, {
      connectionString,
      confirmFingerprint: true,
    });
    expect(connected.status).toBe(200);
    connectionId = (connected.data as { connection: { id: string } }).connection.id;
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
    await proxmox?.close();
  }, 30_000);

  beforeEach(() => {
    seedVm(OWNED_VMID, true);
    seedVm(FOREIGN_VMID, false);
  });

  it('starts a stopped DevChain-owned VM', async () => {
    const remote = await proxmoxRemote('owned', identity(OWNED_VMID));
    const before = startCalls(OWNED_VMID);

    const result = await post(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

    expect(result).toEqual({ status: 200, data: { powerState: 'running' } });
    expect(proxmox.vms.get(OWNED_VMID)?.status).toBe('running');
    expect(startCalls(OWNED_VMID)).toBe(before + 1);
    expect(await instances.home.storage.listRemoteOperations({ remoteId: remote.id })).toEqual([]);
  });

  it('refuses a VM that is not DevChain’s and leaves it stopped', async () => {
    const remote = await proxmoxRemote('foreign', identity(FOREIGN_VMID));

    const result = await post(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({
      message: 'VM destroy guard refused: pool, tag, name prefix.',
    });
    expect(proxmox.vms.get(FOREIGN_VMID)?.status).toBe('stopped');
    expect(startCalls(FOREIGN_VMID)).toBe(0);
  });

  it('refuses an address remote', async () => {
    const remote = await instances.home.storage.createRemote({
      name: 'by-address',
      kind: 'address',
      baseUrl: 'http://127.0.0.1:2',
    });

    const result = await post(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({
      message: 'Only a registered managed VM can be powered on.',
      details: { code: 'REMOTE_NOT_VM_MANAGED' },
    });
  });

  it('refuses a Proxmox remote without a VM identity', async () => {
    const remote = await proxmoxRemote('no-identity', null);

    const result = await post(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({
      message: 'Only a registered managed VM can be powered on.',
      details: { code: 'REMOTE_NOT_VM_MANAGED' },
    });
  });

  it('refuses while a host operation is open and starts nothing', async () => {
    const remote = await proxmoxRemote('busy', identity(OWNED_VMID));
    await instances.home.storage.createRemoteOperation({
      kind: 'update_host',
      remoteId: remote.id,
      projectId: null,
      steps: [],
      details: {},
    });
    const before = startCalls(OWNED_VMID);

    const result = await post(`${instances.home.url}/api/remotes/${remote.id}/power-on`);

    expect(result.status).toBe(409);
    expect(proxmox.vms.get(OWNED_VMID)?.status).toBe('stopped');
    expect(startCalls(OWNED_VMID)).toBe(before);
  });
});
