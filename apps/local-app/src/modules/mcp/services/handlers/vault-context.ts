import type { VaultDiscoveryService } from '../../../vault/vault-discovery.service';
import type { VaultRequestService } from '../../../vault-requests/vault-request.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export interface VaultToolContext {
  vaultDiscoveryService: VaultDiscoveryService;
  vaultRequestService: VaultRequestService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
