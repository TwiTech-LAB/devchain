import { Injectable } from '@nestjs/common';
import { ConflictError } from '../../common/errors/error-types';
import type { VmPowerState, VmProvider } from './vm-provider.port';

@Injectable()
export class AddressVmProvider implements VmProvider {
  readonly kind = 'address' as const;
  readonly capabilities = { create: false, destroy: false, powerState: false } as const;

  async destroyVm(_vmIdentity: string): Promise<void> {
    throw new ConflictError('An address remote has no VM lifecycle.');
  }

  async getPowerState(_vmIdentity: string): Promise<VmPowerState> {
    return 'unknown';
  }

  async checkPermissions(): Promise<{ ok: boolean; missing: string[] }> {
    return { ok: true, missing: [] };
  }
}
