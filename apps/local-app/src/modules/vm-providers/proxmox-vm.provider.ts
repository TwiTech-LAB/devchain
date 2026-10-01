import {
  ProxmoxClient,
  parseSmbiosUuid,
  type ProxmoxQemuEntry,
  type ProxmoxTarget,
  type ProxmoxVmConfig,
} from '@devchain/proxmox-client';
import { ConflictError, NotFoundError } from '../../common/errors/error-types';
import type { VmProviderConnection } from '../storage/models/domain.models';
import type { VmPowerState, VmProvider } from './vm-provider.port';

const TASK_TIMEOUT_MS = 20 * 60_000;

export const PROXMOX_CAPABILITIES = { create: true, destroy: true, powerState: true } as const;

type VmLocation = ProxmoxQemuEntry & { node: string };

export function proxmoxTarget(
  connection: Pick<VmProviderConnection, 'apiUrl' | 'tokenId' | 'sslFingerprint'> & {
    caPem?: string | null;
  },
  tokenSecret: string,
): ProxmoxTarget {
  return {
    origin: connection.apiUrl,
    tokenId: connection.tokenId,
    tokenSecret,
    tlsFingerprint: connection.sslFingerprint,
    caPem: connection.caPem,
  };
}

export function vmTags(config: ProxmoxVmConfig): string[] {
  return String(config.tags ?? '')
    .split(/[;,\s]+/)
    .filter(Boolean);
}

export async function isInPool(
  client: ProxmoxClient,
  target: ProxmoxTarget,
  pool: string,
  vmid: number,
): Promise<boolean> {
  const response = (await client.request(target, {
    method: 'GET',
    path: `/api2/json/pools/${encodeURIComponent(pool)}`,
  })) as { members?: Array<{ vmid?: number; id?: string }> };
  return (
    response?.members?.some(
      (member) => Number(member.vmid) === vmid || member.id === `qemu/${vmid}`,
    ) ?? false
  );
}

export class ProxmoxVmProvider implements VmProvider {
  readonly kind = 'proxmox' as const;
  readonly capabilities = PROXMOX_CAPABILITIES;
  private readonly target: ProxmoxTarget;

  constructor(
    private readonly client: ProxmoxClient,
    private readonly connection: VmProviderConnection,
    tokenSecret: string,
  ) {
    this.target = proxmoxTarget(connection, tokenSecret);
  }

  async destroyVm(vmIdentity: string): Promise<void> {
    const vm = await this.findVm(vmIdentity);
    if (!vm) throw new NotFoundError('VM', vmIdentity);
    await this.destroyLocation(vm);
  }

  async assertOwnedVmIdentity(vmIdentity: string): Promise<number> {
    return (await this.getOwnedVm(vmIdentity)).vmid;
  }

  async getOwnedVm(vmIdentity: string): Promise<{ vmid: number; name: string }> {
    const vm = await this.findVm(vmIdentity);
    if (!vm) throw new NotFoundError('VM', vmIdentity);
    const name = await this.assertDestroyGuard(vm);
    return { vmid: vm.vmid, name };
  }

  async destroyOwnedVmid(vmid: number): Promise<void> {
    await this.destroyLocation(await this.nodeVm(vmid));
  }

  async assertOwnedVmid(vmid: number): Promise<void> {
    await this.assertDestroyGuard(await this.nodeVm(vmid));
  }

  private async nodeVm(vmid: number): Promise<VmLocation> {
    const vm = (await this.client.getQemuList(this.target, this.connection.node)).find(
      (item) => item.vmid === vmid,
    );
    if (!vm) throw new NotFoundError('VM', String(vmid));
    return { ...vm, node: this.connection.node };
  }

  private async destroyLocation(vm: VmLocation): Promise<void> {
    await this.assertDestroyGuard(vm);
    if (vm.status === 'running') {
      const stop = await this.client.stopVm(this.target, vm.node, vm.vmid);
      await this.client.waitForTask(this.target, vm.node, stop, TASK_TIMEOUT_MS);
    }
    const deletion = await this.client.deleteVm(this.target, vm.node, vm.vmid, {
      purge: true,
      destroyUnreferencedDisks: true,
    });
    await this.waitIfTask(deletion, vm.node);
  }

  async getPowerState(vmIdentity: string): Promise<VmPowerState> {
    const vm = await this.findVm(vmIdentity);
    if (!vm) return 'unknown';
    const status = (await this.client.request(this.target, {
      method: 'GET',
      path: `/api2/json/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.vmid}/status/current`,
    })) as { status?: unknown };
    return status?.status === 'running' || status?.status === 'stopped' ? status.status : 'unknown';
  }

  async checkPermissions(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    let pveMajor: number | null = null;
    try {
      const version = await this.client.getVersion(this.target);
      const match = typeof version.version === 'string' ? /^(\d+)/.exec(version.version) : null;
      pveMajor = match ? Number(match[1]) : null;
    } catch {
      missing.push('API access');
    }
    const missingGuestAgentRight =
      pveMajor === null
        ? 'VM.Monitor or VM.GuestAgent.Audit'
        : pveMajor >= 9
          ? 'VM.GuestAgent.Audit'
          : 'VM.Monitor';
    // PVE 9 split VM.Monitor into VM.GuestAgent.* rights; Unrestricted also covers file reads.
    const fileReadRights =
      pveMajor === null
        ? ['VM.GuestAgent.FileRead', 'VM.GuestAgent.Unrestricted', 'VM.Monitor']
        : pveMajor >= 9
          ? ['VM.GuestAgent.FileRead', 'VM.GuestAgent.Unrestricted']
          : ['VM.Monitor'];
    // Unrestricted is the exec-level right, so the message never asks for it.
    const missingFileReadRight = fileReadRights
      .filter((right) => right !== 'VM.GuestAgent.Unrestricted')
      .join(' or ');
    const probe = async (label: string, call: () => Promise<unknown>): Promise<void> => {
      try {
        await call();
      } catch {
        missing.push(label);
      }
    };
    await probe(`Datastore.Audit on /storage/${this.connection.imageStorage}`, () =>
      this.client.listStorageContent(
        this.target,
        this.connection.node,
        this.connection.imageStorage,
        'import',
      ),
    );
    let nextId: number | null = null;
    try {
      const candidate = await this.client.getNextId(this.target);
      if (candidate < 100 || candidate > 999_999_999) throw new Error('Invalid Proxmox VMID');
      nextId = candidate;
    } catch {
      missing.push('VM.Allocate (nextid)');
    }

    const required: Array<[string, string[]]> = [
      [
        `/pool/${this.connection.pool}`,
        [
          'Pool.Audit',
          'VM.Allocate',
          'VM.Audit',
          'VM.Clone',
          'VM.Config.CPU',
          'VM.Config.Memory',
          'VM.Config.Disk',
          'VM.Config.Network',
          'VM.PowerMgmt',
        ],
      ],
      [`/storage/${this.connection.storage}`, ['Datastore.Audit', 'Datastore.AllocateSpace']],
      [
        `/storage/${this.connection.imageStorage}`,
        ['Datastore.Audit', 'Datastore.AllocateSpace', 'Datastore.AllocateTemplate'],
      ],
      [`/sdn/zones/localnetwork/${this.connection.bridge}`, ['SDN.Use']],
      [`/nodes/${this.connection.node}`, ['Sys.AccessNetwork']],
    ];
    for (const [path, privileges] of required) {
      try {
        const response: unknown = await this.client.request(this.target, {
          method: 'GET',
          path: `/api2/json/access/permissions?path=${encodeURIComponent(path)}`,
        });
        const granted = this.readAclPrivileges(response, path);
        for (const privilege of privileges) {
          if (!(privilege in granted)) missing.push(`${privilege} on ${path}`);
        }
        if (
          path === `/pool/${this.connection.pool}` &&
          !('VM.Monitor' in granted) &&
          !('VM.GuestAgent.Audit' in granted)
        ) {
          missing.push(`${missingGuestAgentRight} on ${path}`);
        }
        if (
          path === `/pool/${this.connection.pool}` &&
          !fileReadRights.some((right) => right in granted)
        ) {
          missing.push(`${missingFileReadRight} on ${path}`);
        }
      } catch {
        for (const privilege of privileges) missing.push(`${privilege} on ${path}`);
        if (path === `/pool/${this.connection.pool}`) {
          missing.push(`${missingGuestAgentRight} on ${path}`);
          missing.push(`${missingFileReadRight} on ${path}`);
        }
      }
    }

    // Proxmox validates VMIDs before create permissions: an invalid-ID POST proves
    // nothing, while a valid-ID POST could create a VM with an overprivileged token.
    if (nextId === null) {
      missing.push('VM.Allocate outside pool (could not verify)');
    } else {
      try {
        const path = `/vms/${nextId}`;
        const permissions: unknown = await this.client.getOwnVmAclPermissions(this.target, nextId);
        if ('VM.Allocate' in this.readAclPrivileges(permissions, path)) {
          missing.push('VM.Allocate outside pool');
        }
      } catch {
        missing.push('VM.Allocate outside pool (could not verify)');
      }
    }
    return { ok: missing.length === 0, missing: [...new Set(missing)] };
  }

  private readAclPrivileges(response: unknown, path: string): Record<string, number> {
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new Error('Invalid permissions response');
    }
    const paths = response as Record<string, unknown>;
    if (Object.keys(paths).length === 0) return {};
    if (!Object.prototype.hasOwnProperty.call(paths, path)) {
      throw new Error('Missing ACL path in permissions response');
    }
    const privileges = paths[path];
    if (typeof privileges !== 'object' || privileges === null || Array.isArray(privileges)) {
      throw new Error('Invalid ACL privileges');
    }
    for (const value of Object.values(privileges)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Invalid ACL privilege value');
      }
    }
    return privileges as Record<string, number>;
  }

  private async findVm(vmIdentity: string): Promise<VmLocation | null> {
    const resources = await this.client.getClusterVmResources(this.target);
    for (const resource of resources) {
      if (!resource.node || resource.template) continue;
      try {
        const config = await this.client.getVmConfig(this.target, resource.node, resource.vmid);
        if (parseSmbiosUuid(config) === vmIdentity.toLowerCase()) {
          return { ...resource, node: resource.node };
        }
      } catch {
        // Permission-filtered inventory may include a VM whose config is unreadable.
      }
    }
    return null;
  }

  private async assertDestroyGuard(vm: VmLocation): Promise<string> {
    const config = await this.client.getVmConfig(this.target, vm.node, vm.vmid);
    const inPool = await isInPool(this.client, this.target, this.connection.pool, vm.vmid);
    const name = typeof config.name === 'string' ? config.name : '';
    const failures = [
      ...(!inPool ? ['pool'] : []),
      ...(!vmTags(config).includes(this.connection.tag) ? ['tag'] : []),
      ...(!name.startsWith(this.connection.namePrefix) ? ['name prefix'] : []),
      ...(vm.vmid < this.connection.vmidMin || vm.vmid > this.connection.vmidMax
        ? ['VMID range']
        : []),
    ];
    if (failures.length > 0)
      throw new ConflictError(`VM destroy guard refused: ${failures.join(', ')}.`);
    return name;
  }

  private async waitIfTask(upid: string | null, node = this.connection.node): Promise<void> {
    if (upid) await this.client.waitForTask(this.target, node, upid, TASK_TIMEOUT_MS);
  }
}
