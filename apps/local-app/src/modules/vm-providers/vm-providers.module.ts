import { Module } from '@nestjs/common';
import { ProxmoxClient } from '@devchain/proxmox-client';
import { StorageModule } from '../storage/storage.module';
import { AddressVmProvider } from './address-vm.provider';
import { VmProvidersController } from './vm-providers.controller';
import { VmProvidersService } from './vm-providers.service';
import { ProxmoxVmLifecycleService } from './proxmox-vm-lifecycle.service';

@Module({
  imports: [StorageModule],
  controllers: [VmProvidersController],
  providers: [
    AddressVmProvider,
    VmProvidersService,
    ProxmoxVmLifecycleService,
    {
      provide: ProxmoxClient,
      useFactory: () =>
        new ProxmoxClient({ requestTimeoutMs: 10_000, maxResponseBytes: 5 * 1024 * 1024 }),
    },
  ],
  exports: [VmProvidersService, ProxmoxVmLifecycleService],
})
export class VmProvidersModule {}
