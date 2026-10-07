import { MODULE_METADATA } from '@nestjs/common/constants';
import { CloudTunnelModule } from './cloud-tunnel.module';
import { TunnelEventForwarderService } from './services/tunnel-event-forwarder.service';

describe('CloudTunnelModule', () => {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CloudTunnelModule) ??
    []) as unknown[];

  it('registers TunnelEventForwarderService (push events up the tunnel)', () => {
    expect(providers).toContain(TunnelEventForwarderService);
  });
});
