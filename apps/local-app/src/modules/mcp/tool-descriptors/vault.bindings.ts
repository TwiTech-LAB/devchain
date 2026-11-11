import type { VaultDiscoveryService } from '../../vault/vault-discovery.service';
import type { VaultRequestService } from '../../vault-requests/vault-request.service';
import { createNullAdapter } from '../services/handlers/null-adapter';
import type { VaultToolContext } from '../services/handlers/vault-context';
import { handleVaultList, handleVaultRequest } from '../services/handlers/vault-tools';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

function createVaultContext(runtime: McpBindingRuntime): VaultToolContext {
  return {
    vaultDiscoveryService:
      runtime.vaultDiscoveryService ??
      createNullAdapter<VaultDiscoveryService>('VaultDiscoveryService'),
    vaultRequestService:
      runtime.vaultRequestService ?? createNullAdapter<VaultRequestService>('VaultRequestService'),
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const vaultBindings = defineToolGroup<VaultToolContext>(createVaultContext, [
  ['devchain_vault_list', handleVaultList],
  ['devchain_vault_request', handleVaultRequest],
]);
