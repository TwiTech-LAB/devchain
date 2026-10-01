import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { RemoteApiKeyService } from './remote-api-key.service';

@Module({
  imports: [StorageModule],
  providers: [RemoteApiKeyService],
  exports: [RemoteApiKeyService],
})
export class RemoteApiKeyModule {}
