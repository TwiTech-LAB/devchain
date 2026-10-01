import { Inject, Injectable } from '@nestjs/common';
import {
  ProxmoxClient,
  ProxmoxRemoteError,
  parseSmbiosUuid,
  type ProxmoxQemuEntry,
  type ProxmoxTarget,
  type ProxmoxVmConfig,
} from '@devchain/proxmox-client';
import { ConflictError } from '../../common/errors/error-types';
import { normalizeCertificate } from '../../common/tls/certificate';
import { STORAGE_SERVICE, type RemoteStorage } from '../storage/interfaces/storage.interface';
import type { VmProviderConnection, VmSpec } from '../storage/models/domain.models';
import { isSupportedHostImage } from '../remotes/host-image';
import { HOST_CERTIFICATE_PATH } from '../remotes/host-install/host-install-block';
import { isInPool, proxmoxTarget, vmTags } from './proxmox-vm.provider';
import { VmProvidersService } from './vm-providers.service';

const TASK_TIMEOUT_MS = 20 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const IP_TIMEOUT_MS = 2 * 60_000;
const VM_CERTIFICATE_MAX_BYTES = 16 * 1024;

export interface HostImage {
  url: string;
  sha256: string;
  version: string;
  filename: string;
}

interface Session {
  connection: VmProviderConnection;
  target: ProxmoxTarget;
}

/** The planned VMID holds a VM without this operation's marker; create_vm retries with a new one. */
function vmidTaken(kind: 'template' | 'clone'): ConflictError {
  return new ConflictError(`The selected ${kind} VMID belongs to another VM.`, {
    code: 'VMID_TAKEN',
  });
}

@Injectable()
export class ProxmoxVmLifecycleService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly client: ProxmoxClient,
    private readonly providers: VmProvidersService,
  ) {}

  image(url: string, sha256: string): HostImage {
    const parsed = new URL(url);
    const filename = parsed.pathname.split('/').pop() ?? '';
    const match = /^devchain-host-(.+)\.qcow2$/.exec(filename);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !match ||
      !isSupportedHostImage(match[1]) ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      throw new ConflictError('Configure a reachable DevChain host image URL and SHA-256.');
    }
    const normalizedSha = sha256.toLowerCase();
    return {
      url,
      sha256: normalizedSha,
      version: match[1],
      filename: `devchain-host-${match[1]}-${normalizedSha}.qcow2`,
    };
  }

  async assertReachable(image: HostImage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(image.url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ConflictError('The configured host image URL is unreachable.');
    }
    if (!response.ok) throw new ConflictError('The configured host image URL is unreachable.');
  }

  async plan(
    connectionId: string,
    image: HostImage,
  ): Promise<{ templateVmid: number; vmid: number }> {
    const { connection, target } = await this.session(connectionId);
    if (connection.vmidMin < 100 || connection.vmidMax > 999_999_999) {
      throw new ConflictError('The configured VMID range must be between 100 and 999999999.');
    }
    const template = await this.findTemplate(connection, target, image);
    const ids: number[] = [];
    for (
      let id = connection.vmidMin;
      id <= connection.vmidMax && ids.length < (template ? 1 : 2);
      id++
    ) {
      try {
        await this.client.request(target, {
          method: 'GET',
          path: `/api2/json/cluster/nextid?vmid=${id}`,
        });
        ids.push(id);
      } catch (error) {
        if (
          error instanceof ProxmoxRemoteError &&
          error.code === 'proxmox_api' &&
          error.details?.httpStatus === 400
        )
          continue;
        throw error;
      }
    }
    if (ids.length < (template ? 1 : 2)) {
      throw new ConflictError('No free VMIDs remain in the configured provider range.');
    }
    return { templateVmid: template?.vmid ?? ids[0], vmid: template ? ids[0] : ids[1] };
  }

  async ensureImage(connectionId: string, image: HostImage): Promise<string> {
    const { connection, target } = await this.session(connectionId);
    const volid = `${connection.imageStorage}:import/${image.filename}`;
    const content = await this.client.listStorageContent(
      target,
      connection.node,
      connection.imageStorage,
      'import',
    );
    if (content.some((item) => item.volid === volid)) return volid;
    const upid = await this.client.downloadUrl(target, connection.node, connection.imageStorage, {
      content: 'import',
      filename: image.filename,
      url: image.url,
      checksum: image.sha256,
      checksumAlgorithm: 'sha256',
    });
    await this.client.waitForTask(target, connection.node, upid, DOWNLOAD_TIMEOUT_MS);
    return volid;
  }

  async ensureTemplate(
    connectionId: string,
    image: HostImage,
    vmid: number,
    volid: string,
  ): Promise<number> {
    const { connection, target } = await this.session(connectionId);
    const existing = await this.findTemplate(connection, target, image);
    if (existing) return existing.vmid;
    const name = `${connection.namePrefix}tpl-${image.version}`;
    const marker = `devchain-image-sha256=${image.sha256}`;
    const vm = await this.findVmid(target, connection.node, vmid);
    if (vm) {
      const config = await this.client.getVmConfig(target, connection.node, vmid);
      if (vm.name !== name || config.description !== marker) throw vmidTaken('template');
      await this.assertPoolTag(connection, target, vmid, config);
      if (vm.template) return vmid;
    } else {
      let upid: string | null;
      try {
        upid = await this.client.createVm(target, connection.node, {
          vmid,
          pool: connection.pool,
          tags: connection.tag,
          name,
          scsi0ImportFrom: `${connection.storage}:0,import-from=${volid}`,
          cloudInitDrive: `${connection.storage}:cloudinit`,
          agent: 'enabled=1',
          ipconfig0: 'ip=dhcp',
          net0: `virtio,bridge=${connection.bridge}`,
          cores: 1,
          memory: 1024,
          description: marker,
        });
      } catch (error) {
        if (
          !(await this.recoverExisting(
            target,
            connection.node,
            vmid,
            name,
            marker,
            error,
            'template',
          ))
        )
          throw error;
        upid = null;
      }
      if (upid) await this.client.waitForTask(target, connection.node, upid, TASK_TIMEOUT_MS);
      await this.assertPoolTag(
        connection,
        target,
        vmid,
        await this.client.getVmConfig(target, connection.node, vmid),
      );
    }
    const converted = await this.client.convertToTemplate(target, connection.node, vmid);
    await this.client.waitForTask(target, connection.node, converted, TASK_TIMEOUT_MS);
    return vmid;
  }

  async clone(
    connectionId: string,
    templateVmid: number,
    vmid: number,
    name: string,
    operationId: string,
  ): Promise<string> {
    const { connection, target } = await this.session(connectionId);
    const marker = `devchain-operation-id=${operationId}`;
    const existing = await this.findVmid(target, connection.node, vmid);
    if (existing) {
      const config = await this.client.getVmConfig(target, connection.node, vmid);
      if (existing.name !== name || config.description !== marker) throw vmidTaken('clone');
    } else {
      let upid: string | null;
      try {
        upid = await this.client.cloneVm(target, connection.node, templateVmid, {
          newid: vmid,
          name,
          full: true,
          pool: connection.pool,
          storage: connection.storage,
          description: marker,
        });
      } catch (error) {
        if (
          !(await this.recoverExisting(target, connection.node, vmid, name, marker, error, 'clone'))
        )
          throw error;
        upid = null;
      }
      if (upid) await this.client.waitForTask(target, connection.node, upid, TASK_TIMEOUT_MS);
    }
    const config = await this.client.getVmConfig(target, connection.node, vmid);
    if (config.description !== marker) throw vmidTaken('clone');
    await this.assertPoolTag(connection, target, vmid, config);
    const uuid = parseSmbiosUuid(config);
    if (!uuid) throw new ConflictError('The cloned VM has no valid SMBIOS identity.');
    return uuid;
  }

  async configure(connectionId: string, vmid: number, spec: VmSpec): Promise<void> {
    const { connection, target } = await this.session(connectionId);
    const config = await this.client.getVmConfig(target, connection.node, vmid);
    if (config.cores !== spec.cores || config.memory !== spec.memory) {
      const upid = await this.client.setConfig(
        target,
        connection.node,
        vmid,
        spec.cores,
        spec.memory,
      );
      if (upid) await this.client.waitForTask(target, connection.node, upid, TASK_TIMEOUT_MS);
    }
    const disk = String(config.scsi0 ?? '');
    const size = /(?:^|,)size=(\d+)([KMGTP])(?:,|$)/i.exec(disk);
    const currentGiB = size
      ? Number(size[1]) *
        ({ K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024, P: 1024 ** 2 }[size[2].toUpperCase()] ?? 0)
      : 0;
    if (currentGiB > spec.disk) {
      throw new ConflictError('The requested disk size is smaller than the image disk.');
    }
    if (currentGiB < spec.disk) {
      const upid = await this.client.resizeDisk(
        target,
        connection.node,
        vmid,
        'scsi0',
        `${spec.disk}G`,
      );
      if (upid) await this.client.waitForTask(target, connection.node, upid, TASK_TIMEOUT_MS);
    }
  }

  async start(connectionId: string, vmid: number): Promise<void> {
    const { connection, target } = await this.session(connectionId);
    const vm = await this.findVmid(target, connection.node, vmid);
    if (!vm) throw new ConflictError('The cloned VM is missing.');
    if (vm.status === 'running') return;
    const upid = await this.client.startVm(target, connection.node, vmid);
    await this.client.waitForTask(target, connection.node, upid, TASK_TIMEOUT_MS);
  }

  async waitIp(
    connectionId: string,
    vmid: number,
    port: number,
  ): Promise<{ address: string; bootstrapUrl: string }> {
    const { connection, target } = await this.session(connectionId);
    const deadline = Date.now() + IP_TIMEOUT_MS;
    do {
      try {
        const ip = await this.client.getAgentNetworkInterfaces(target, connection.node, vmid);
        if (ip) {
          const host = ip.includes(':') ? `[${ip}]` : ip;
          return { address: `https://${host}:${port}`, bootstrapUrl: `https://${host}:3000` };
        }
      } catch (error) {
        if (error instanceof ProxmoxRemoteError && error.code === 'proxmox_denied') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } while (Date.now() < deadline);
    throw new ConflictError('The guest agent did not report an IP address within 120 seconds.');
  }

  /**
   * The VM's TLS certificate as read through the guest agent, or null while the
   * agent, the file or its content is not ready yet. Proxmox answers a missing
   * guest file with HTTP 500. A refused token or a Proxmox TLS failure throws.
   */
  async readCertificate(connectionId: string, vmid: number): Promise<string | null> {
    const { connection, target } = await this.session(connectionId);
    let pem: string;
    try {
      pem = await this.client.readAgentFile(
        target,
        connection.node,
        vmid,
        HOST_CERTIFICATE_PATH,
        VM_CERTIFICATE_MAX_BYTES,
      );
    } catch (error) {
      if (
        error instanceof ProxmoxRemoteError &&
        ['proxmox_api', 'proxmox_transport', 'proxmox_timeout'].includes(error.code)
      ) {
        return null;
      }
      throw error;
    }
    try {
      return normalizeCertificate(pem);
    } catch {
      return null;
    }
  }

  /** True only while `vmid` holds the clone that `operationId` created under `name`. */
  async isOperationClone(
    connectionId: string,
    vmid: number,
    name: string,
    operationId: string,
  ): Promise<boolean> {
    const { connection, target } = await this.session(connectionId);
    const vm = await this.findVmid(target, connection.node, vmid);
    if (!vm || vm.name !== name) return false;
    const config = await this.client.getVmConfig(target, connection.node, vmid);
    return config.description === `devchain-operation-id=${operationId}`;
  }

  async destroyCreated(
    connectionId: string,
    vmid: number,
    name: string,
    operationId: string,
  ): Promise<void> {
    const { connection, target } = await this.session(connectionId);
    const vm = await this.findVmid(target, connection.node, vmid);
    if (!vm) return;
    const config = await this.client.getVmConfig(target, connection.node, vmid);
    if (vm.name !== name || config.description !== `devchain-operation-id=${operationId}`) {
      throw new ConflictError(
        "The cancellation guard refused a VM that is not this operation's clone.",
      );
    }
    await (await this.providers.forConnection(connectionId)).destroyOwnedVmid(vmid);
  }

  private async findTemplate(
    connection: VmProviderConnection,
    target: ProxmoxTarget,
    image: HostImage,
  ): Promise<ProxmoxQemuEntry | null> {
    const name = `${connection.namePrefix}tpl-${image.version}`;
    const matches = (await this.client.getQemuList(target, connection.node)).filter(
      (vm) => vm.name === name,
    );
    if (matches.length > 1)
      throw new ConflictError('More than one VM has the image template name.');
    const vm = matches[0];
    if (!vm) return null;
    const config = await this.client.getVmConfig(target, connection.node, vm.vmid);
    if (!vm.template || config.description !== `devchain-image-sha256=${image.sha256}`) {
      throw new ConflictError('The image template name is occupied by another image or VM.');
    }
    await this.assertPoolTag(connection, target, vm.vmid, config);
    return vm;
  }

  private async assertPoolTag(
    connection: VmProviderConnection,
    target: ProxmoxTarget,
    vmid: number,
    config: ProxmoxVmConfig,
  ): Promise<void> {
    const inPool = await isInPool(this.client, target, connection.pool, vmid);
    if (!vmTags(config).includes(connection.tag) || !inPool) {
      throw new ConflictError('The VM is not in the configured pool with the configured tag.');
    }
  }

  private async recoverExisting(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
    name: string,
    marker: string,
    error: unknown,
    kind: 'template' | 'clone',
  ): Promise<boolean> {
    if (
      !(error instanceof ProxmoxRemoteError) ||
      error.code !== 'proxmox_api' ||
      error.details?.httpStatus !== 400
    )
      return false;
    const vm = await this.findVmid(target, node, vmid);
    if (!vm) return false;
    const config = await this.client.getVmConfig(target, node, vmid);
    if (vm.name === name && config.description === marker) return true;
    throw vmidTaken(kind);
  }

  private async session(connectionId: string): Promise<Session> {
    const [connection, tokenSecret] = await Promise.all([
      this.storage.getVmProviderConnection(connectionId),
      this.storage.readVmProviderTokenSecret(connectionId),
    ]);
    return { connection, target: proxmoxTarget(connection, tokenSecret) };
  }

  private async findVmid(
    target: ProxmoxTarget,
    node: string,
    vmid: number,
  ): Promise<ProxmoxQemuEntry | undefined> {
    return (await this.client.getQemuList(target, node)).find((item) => item.vmid === vmid);
  }
}
