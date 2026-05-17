import { Module } from '@nestjs/common';
import { CloudModule } from '../cloud/cloud.module';
import { StorageModule } from '../storage/storage.module';
import { TunnelKeypairService } from './services/tunnel-keypair.service';
import { TunnelHandlerService } from './services/tunnel-handler.service';
import { TunnelClientService } from './services/tunnel-client.service';

@Module({
  imports: [CloudModule, StorageModule],
  providers: [TunnelKeypairService, TunnelHandlerService, TunnelClientService],
})
export class CloudTunnelModule {}
