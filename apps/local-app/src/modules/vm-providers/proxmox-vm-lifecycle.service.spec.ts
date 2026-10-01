import { X509Certificate } from 'node:crypto';
import type { ProxmoxClient, ProxmoxTarget } from '@devchain/proxmox-client';
import { ProxmoxRemoteError } from '@devchain/proxmox-client';
import type { RemoteStorage } from '../storage/interfaces/storage.interface';
import type { VmProviderConnection } from '../storage/models/domain.models';
import { ProxmoxVmLifecycleService } from './proxmox-vm-lifecycle.service';
import { ProxmoxVmProvider } from './proxmox-vm.provider';
import type { VmProvidersService } from './vm-providers.service';
import { fixtureTls } from '../../common/test/tls-fixture';

interface FakeVm {
  vmid: number;
  name: string;
  description: string;
  template: number;
  status: string;
  tags: string;
  cores: number;
  memory: number;
  scsi0: string;
  smbios1: string;
}

const SHA = 'a'.repeat(64);
const connection: VmProviderConnection = {
  id: 'b4066493-c9d4-4b55-ae7f-fc73907f6bb2',
  kind: 'proxmox',
  name: 'Lab',
  apiUrl: 'https://proxmox.example',
  node: 'hw',
  pool: 'devchain',
  storage: 'local-lvm',
  imageStorage: 'local',
  bridge: 'vmbr0',
  vmidMin: 100,
  vmidMax: 200,
  namePrefix: 'dc-',
  tag: 'devchain',
  sslFingerprint: SHA,
  caPem: null,
  tokenId: 'root@pam!devchain',
  tokenSecretCiphertext: 'encrypted',
  createdAt: '2026-09-24T00:00:00Z',
  updatedAt: '2026-09-24T00:00:00Z',
};

class FakeProxmoxApi {
  readonly vms = new Map<number, FakeVm>();
  readonly images = new Set<string>();
  readonly calls: string[] = [];
  cloneRace: 'owned' | 'other' | null = null;

  constructor() {
    this.vms.set(199, {
      vmid: 199,
      name: 'unrelated',
      description: 'someone else',
      template: 0,
      status: 'stopped',
      tags: 'other',
      cores: 1,
      memory: 1024,
      scsi0: 'local-lvm:vm-199-disk-0,size=8G',
      smbios1: 'uuid=12345678-1234-1234-1234-123456789199',
    });
  }

  async request(_target: ProxmoxTarget, options: { method: string; path: string }) {
    this.calls.push(`${options.method} ${options.path}`);
    if (options.path.startsWith('/api2/json/cluster/nextid?vmid=')) {
      const vmid = Number(new URL(options.path, 'https://fake').searchParams.get('vmid'));
      if (this.vms.has(vmid))
        throw new ProxmoxRemoteError('proxmox_api', 'occupied', 502, { httpStatus: 400 });
      return String(vmid);
    }
    if (options.path === '/api2/json/pools/devchain') {
      return {
        members: [...this.vms.values()]
          .filter((vm) => vm.tags === 'devchain')
          .map((vm) => ({ vmid: vm.vmid })),
      };
    }
    throw new Error(`Unexpected ${options.method} ${options.path}`);
  }

  async getQemuList() {
    this.calls.push('GET qemu');
    return [...this.vms.values()].map(({ vmid, name, template, status }) => ({
      vmid,
      name,
      template,
      status,
    }));
  }

  async listStorageContent() {
    this.calls.push('GET content');
    return [...this.images].map((volid) => ({ volid }));
  }

  async downloadUrl(
    _target: ProxmoxTarget,
    _node: string,
    _storage: string,
    options: { filename: string; checksum?: string },
  ) {
    expect(options.checksum).toBe(SHA);
    this.images.add(`local:import/${options.filename}`);
    this.calls.push('POST download-url');
    return 'UPID:download';
  }

  async waitForTask() {
    this.calls.push('GET task');
  }

  async createVm(
    _target: ProxmoxTarget,
    _node: string,
    options: { vmid: number; name: string; description?: string; tags: string },
  ) {
    this.calls.push('POST create-template');
    this.vms.set(options.vmid, {
      vmid: options.vmid,
      name: options.name,
      description: options.description ?? '',
      template: 0,
      status: 'stopped',
      tags: options.tags,
      cores: 1,
      memory: 1024,
      scsi0: `local-lvm:vm-${options.vmid}-disk-0,size=8G`,
      smbios1: `uuid=12345678-1234-1234-1234-${String(options.vmid).padStart(12, '0')}`,
    });
    return 'UPID:create';
  }

  async convertToTemplate(_target: ProxmoxTarget, _node: string, vmid: number) {
    this.vms.get(vmid)!.template = 1;
    this.calls.push('POST template');
    return 'UPID:template';
  }

  async cloneVm(
    _target: ProxmoxTarget,
    _node: string,
    templateVmid: number,
    options: { newid: number; name: string; description?: string },
  ) {
    const source = this.vms.get(templateVmid)!;
    this.calls.push('POST clone');
    this.vms.set(options.newid, {
      ...source,
      vmid: options.newid,
      name: options.name,
      description: options.description ?? '',
      template: 0,
      status: 'stopped',
      smbios1: `uuid=12345678-1234-1234-1234-${String(options.newid).padStart(12, '0')}`,
    });
    if (this.cloneRace) {
      if (this.cloneRace === 'other') {
        Object.assign(this.vms.get(options.newid)!, { name: 'intruder', description: 'unrelated' });
      }
      this.cloneRace = null;
      throw new ProxmoxRemoteError('proxmox_api', 'occupied', 502, { httpStatus: 400 });
    }
    return 'UPID:clone';
  }

  async getVmConfig(_target: ProxmoxTarget, _node: string, vmid: number) {
    const vm = this.vms.get(vmid);
    if (!vm) throw new Error('VM missing');
    return { ...vm };
  }

  async setConfig(
    _target: ProxmoxTarget,
    _node: string,
    vmid: number,
    cores: number,
    memory: number,
  ) {
    Object.assign(this.vms.get(vmid)!, { cores, memory });
    this.calls.push('PUT config');
    return null;
  }

  async resizeDisk(
    _target: ProxmoxTarget,
    _node: string,
    vmid: number,
    _disk: string,
    size: string,
  ) {
    this.vms.get(vmid)!.scsi0 = `local-lvm:vm-${vmid}-disk-0,size=${size}`;
    this.calls.push('PUT resize');
    return null;
  }

  async startVm(_target: ProxmoxTarget, _node: string, vmid: number) {
    this.vms.get(vmid)!.status = 'running';
    this.calls.push('POST start');
    return 'UPID:start';
  }

  async getAgentNetworkInterfaces() {
    return '10.0.0.5';
  }
  agentFile: () => Promise<string> = async () => fixtureTls.cert;
  async readAgentFile(
    _target: ProxmoxTarget,
    node: string,
    vmid: number,
    file: string,
    maxBytes: number,
  ) {
    this.calls.push(`READ ${node}/${vmid} ${file} ${maxBytes}`);
    return this.agentFile();
  }
  async stopVm(_target: ProxmoxTarget, _node: string, vmid: number) {
    this.vms.get(vmid)!.status = 'stopped';
    this.calls.push('POST stop');
    return 'UPID:stop';
  }
  async deleteVm(_target: ProxmoxTarget, _node: string, vmid: number) {
    this.vms.delete(vmid);
    this.calls.push('DELETE vm');
    return 'UPID:delete';
  }
}

describe('Proxmox VM lifecycle against a fake API', () => {
  let api: FakeProxmoxApi;
  let lifecycle: ProxmoxVmLifecycleService;

  beforeEach(() => {
    api = new FakeProxmoxApi();
    const client = api as unknown as ProxmoxClient;
    const storage = {
      getVmProviderConnection: async () => connection,
      readVmProviderTokenSecret: async () => 'private-token',
    } as unknown as RemoteStorage;
    const providers = {
      forConnection: async () => new ProxmoxVmProvider(client, connection, 'private-token'),
    } as unknown as VmProvidersService;
    lifecycle = new ProxmoxVmLifecycleService(storage, client, providers);
  });

  it('downloads once, reuses the tagged template, and guards cancellation', async () => {
    const image = lifecycle.image('https://images.example/devchain-host-1.3.0.qcow2', SHA);
    const first = await lifecycle.plan(connection.id, image);
    expect(first).toEqual({ templateVmid: 100, vmid: 101 });
    const volid = await lifecycle.ensureImage(connection.id, image);
    await lifecycle.ensureTemplate(connection.id, image, first.templateVmid, volid);
    const identity = await lifecycle.clone(connection.id, 100, 101, 'dc-alpha', 'operation-one');
    await lifecycle.clone(connection.id, 100, 101, 'dc-alpha', 'operation-one');
    expect(api.calls.filter((call) => call === 'POST clone')).toHaveLength(1);
    await lifecycle.configure(connection.id, 101, { cores: 2, memory: 4096, disk: 30 });
    await lifecycle.start(connection.id, 101);
    expect(await lifecycle.waitIp(connection.id, 101, 4000)).toEqual({
      address: 'https://10.0.0.5:4000',
      bootstrapUrl: 'https://10.0.0.5:3000',
    });
    expect(identity).toBe('12345678-1234-1234-1234-000000000101');

    const second = await lifecycle.plan(connection.id, image);
    expect(second).toEqual({ templateVmid: 100, vmid: 102 });
    await lifecycle.ensureImage(connection.id, image);
    await lifecycle.ensureTemplate(connection.id, image, second.templateVmid, volid);
    expect(api.calls.filter((call) => call === 'POST download-url')).toHaveLength(1);
    expect(api.calls.filter((call) => call === 'POST create-template')).toHaveLength(1);

    expect(await lifecycle.isOperationClone(connection.id, 101, 'dc-alpha', 'operation-one')).toBe(
      true,
    );
    expect(await lifecycle.isOperationClone(connection.id, 101, 'dc-alpha', 'operation-two')).toBe(
      false,
    );
    expect(await lifecycle.isOperationClone(connection.id, 101, 'dc-beta', 'operation-one')).toBe(
      false,
    );
    expect(await lifecycle.isOperationClone(connection.id, 199, 'dc-alpha', 'operation-one')).toBe(
      false,
    );
    expect(await lifecycle.isOperationClone(connection.id, 150, 'dc-alpha', 'operation-one')).toBe(
      false,
    );
    await expect(
      lifecycle.destroyCreated(connection.id, 199, 'dc-alpha', 'operation-one'),
    ).rejects.toThrow('cancellation guard');
    await lifecycle.destroyCreated(connection.id, 101, 'dc-alpha', 'operation-one');
    expect(api.vms.has(101)).toBe(false);
    expect(api.vms.has(199)).toBe(true);
    expect(api.vms.has(100)).toBe(true);
  });

  it('recovers its own clone after a lost response and refuses a competing VMID', async () => {
    const image = lifecycle.image('https://images.example/devchain-host-1.3.0.qcow2', SHA);
    const volid = await lifecycle.ensureImage(connection.id, image);
    await lifecycle.ensureTemplate(connection.id, image, 100, volid);
    api.cloneRace = 'owned';
    await expect(
      lifecycle.clone(connection.id, 100, 101, 'dc-alpha', 'operation-one'),
    ).resolves.toBe('12345678-1234-1234-1234-000000000101');
    api.cloneRace = 'other';
    await expect(
      lifecycle.clone(connection.id, 100, 102, 'dc-beta', 'operation-two'),
    ).rejects.toMatchObject({
      message: 'The selected clone VMID belongs to another VM.',
      details: { code: 'VMID_TAKEN' },
    });
    expect(api.vms.get(102)?.name).toBe('intruder');
  });

  it('refuses an image older than the minimum and accepts a LAN build of it', () => {
    expect(() => lifecycle.image('https://images.example/devchain-host-1.2.0.qcow2', SHA)).toThrow(
      'Configure a reachable DevChain host image URL and SHA-256.',
    );
    expect(
      lifecycle.image('http://lan.example/devchain-host-1.3.0-lan.202610010000.qcow2', SHA).version,
    ).toBe('1.3.0-lan.202610010000');
  });

  it('reads the VM certificate from the bootstrap path with a bounded size', async () => {
    api.agentFile = async () => `\n${fixtureTls.cert}`;
    await expect(lifecycle.readCertificate(connection.id, 101)).resolves.toBe(
      new X509Certificate(fixtureTls.cert).toString(),
    );
    expect(api.calls).toContain('READ hw/101 /etc/devchain-host/tls/cert.pem 16384');
  });

  it.each([
    [
      'a missing guest file',
      new ProxmoxRemoteError('proxmox_api', 'missing', 502, { httpStatus: 500 }),
    ],
    ['an unreachable Proxmox', new ProxmoxRemoteError('proxmox_transport', 'unreachable')],
    ['a Proxmox timeout', new ProxmoxRemoteError('proxmox_timeout', 'slow', 504)],
    ['a partly written certificate', '-----BEGIN CERTIFICATE-----\nMIIB'],
  ])('reports no certificate yet for %s', async (_case, outcome) => {
    api.agentFile = async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    await expect(lifecycle.readCertificate(connection.id, 101)).resolves.toBeNull();
  });

  it.each([
    ['a refused token', 'proxmox_denied'],
    ['a Proxmox TLS failure', 'proxmox_tls'],
    ['an oversized file', 'proxmox_response'],
  ] as const)('throws for %s instead of waiting', async (_case, code) => {
    api.agentFile = async () => {
      throw new ProxmoxRemoteError(code, 'refused');
    };
    await expect(lifecycle.readCertificate(connection.id, 101)).rejects.toMatchObject({ code });
  });
});
