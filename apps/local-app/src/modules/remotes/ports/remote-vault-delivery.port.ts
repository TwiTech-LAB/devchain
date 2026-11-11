export const REMOTE_VAULT_DELIVERY_PORT = Symbol('RemoteVaultDeliveryPort');

export interface RemoteVaultDeliveryPort {
  /**
   * Sends home's Vault to the VM now and resolves once the VM acknowledged the pushed
   * revision. Rejects when nothing could be sent (Vault locked) or the VM refused it.
   * Runs after any push already running for the remote, never beside it.
   */
  pushConfirmed(remoteId: string): Promise<void>;
}
