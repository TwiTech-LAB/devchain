import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { ProxmoxClient } from '@devchain/proxmox-client';
import { ConflictError } from '../../common/errors/error-types';
import { STORAGE_SERVICE, type RemoteStorage } from '../storage/interfaces/storage.interface';
import type {
  CreateVmProviderConnection,
  Remote,
  VmProviderConnection,
} from '../storage/models/domain.models';
import { AddressVmProvider } from './address-vm.provider';
import { PROXMOX_CAPABILITIES, ProxmoxVmProvider, proxmoxTarget } from './proxmox-vm.provider';
import type { VmProvider } from './vm-provider.port';
import { parseProxmoxConnectionString } from './proxmox/connection-string';

export type PublicVmProviderConnection = Omit<VmProviderConnection, 'tokenSecretCiphertext'> & {
  capabilities: VmProvider['capabilities'];
};

export type ConnectProxmoxPlacement = {
  apiUrl: string;
  node: string;
  pool: string;
  storage: string;
  imageStorage: string;
  bridge: string;
};

export type ConnectProxmoxResult =
  | { confirmationRequired: true; fingerprint: string; placement: ConnectProxmoxPlacement }
  | {
      confirmationRequired: false;
      connection: PublicVmProviderConnection;
      permissions: { ok: boolean; missing: string[] };
    };

@Injectable()
export class VmProvidersService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly addressProvider: AddressVmProvider,
    private readonly client: ProxmoxClient,
  ) {}

  async listConnections(): Promise<PublicVmProviderConnection[]> {
    const rows = await this.storage.listVmProviderConnections();
    return rows.map((row) => this.toPublic(row));
  }

  async createConnection(data: CreateVmProviderConnection): Promise<PublicVmProviderConnection> {
    return this.toPublic(await this.storage.createVmProviderConnection(data));
  }

  async connectFromString(
    connectionString: string,
    confirmFingerprint: boolean,
  ): Promise<ConnectProxmoxResult> {
    const parsed = parseProxmoxConnectionString(connectionString);
    if (!confirmFingerprint) {
      return {
        confirmationRequired: true,
        fingerprint: parsed.sslFingerprint,
        placement: {
          apiUrl: parsed.apiUrl,
          node: parsed.node,
          pool: parsed.pool,
          storage: parsed.storage,
          imageStorage: parsed.imageStorage,
          bridge: parsed.bridge,
        },
      };
    }

    try {
      await this.client.getVersion(proxmoxTarget(parsed, parsed.tokenSecret));
    } catch {
      throw new BadGatewayException(
        'Could not verify the Proxmox connection. Check the host, certificate fingerprint, and token.',
      );
    }

    const connection = await this.createConnection(parsed);
    const permissions = await this.checkPermissions(connection.id);
    return { confirmationRequired: false, connection, permissions };
  }

  async deleteConnection(id: string): Promise<void> {
    await this.storage.deleteVmProviderConnection(id);
  }

  async checkPermissions(id: string): Promise<{ ok: boolean; missing: string[] }> {
    return (await this.forConnection(id)).checkPermissions();
  }

  async forConnection(id: string): Promise<ProxmoxVmProvider> {
    const [connection, secret] = await Promise.all([
      this.storage.getVmProviderConnection(id),
      this.storage.readVmProviderTokenSecret(id),
    ]);
    return new ProxmoxVmProvider(this.client, connection, secret);
  }

  async forRemote(remote: Remote): Promise<VmProvider> {
    if (remote.kind === 'address') return this.addressProvider;
    if (!remote.vmProviderConnectionId)
      throw new ConflictError('Remote has no VM provider connection.');
    return this.forConnection(remote.vmProviderConnectionId);
  }

  private toPublic(connection: VmProviderConnection): PublicVmProviderConnection {
    const { tokenSecretCiphertext: _secret, ...publicConnection } = connection;
    return { ...publicConnection, capabilities: PROXMOX_CAPABILITIES };
  }
}
