import { MODULE_METADATA } from '@nestjs/common/constants';
import { CloudModule } from '../cloud/cloud.module';
import { StorageModule } from '../storage/storage.module';
import { CloudTunnelModule } from './cloud-tunnel.module';

describe('CloudTunnelModule', () => {
  it('imports dependencies required by tunnel services', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, CloudTunnelModule) ??
      []) as unknown[];

    expect(imports).toContain(CloudModule);
    expect(imports).toContain(StorageModule);
  });
});
