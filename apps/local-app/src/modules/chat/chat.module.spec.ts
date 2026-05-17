import { MODULE_METADATA } from '@nestjs/common/constants';
import { ChatModule } from './chat.module';
import { EventsCoreModule } from '../events/events-core.module';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsReadModule } from '../sessions/sessions-read.module';
import { SessionsDeliveryModule } from '../sessions/sessions-delivery.module';

describe('ChatModule', () => {
  it('imports only the final event/read/settings modules', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule) as unknown[]) ?? [];

    expect(imports).toEqual([
      EventsCoreModule,
      StorageModule,
      SettingsModule,
      SessionsReadModule,
      SessionsDeliveryModule,
    ]);
  });
});
