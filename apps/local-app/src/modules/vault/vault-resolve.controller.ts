import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ValidationError } from '../../common/errors/error-types';
import { VaultResolveSchema } from './vault.dto';
import { VaultLocalPeerGuard } from './vault-local-peer.guard';
import { VaultResolveService, type VaultResolveResult } from './vault-resolve.service';

/**
 * The one route that returns Vault values. It skips `IntegrationAdmissionGuard`: a NIC
 * bind must still serve agents on this machine, and the peer guard keeps everyone else
 * out. Nothing here logs the body or the response.
 */
@UseGuards(VaultLocalPeerGuard)
@Controller('api/vault')
export class VaultResolveController {
  constructor(private readonly resolver: VaultResolveService) {}

  @Post('sessions/resolve')
  @HttpCode(200)
  resolve(@Body() body: unknown): Promise<VaultResolveResult> {
    const parsed = VaultResolveSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Send {sessionId, names?} with entry names only.', {
        code: 'VAULT_RESOLVE_BODY_INVALID',
      });
    }
    return this.resolver.resolve(parsed.data.sessionId, parsed.data.names);
  }
}
