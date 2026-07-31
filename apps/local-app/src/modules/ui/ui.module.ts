import { Module } from '@nestjs/common';
import { UiController } from './ui.controller';
import { getEnvConfig } from '../../common/config/env.config';
import { resolveUiAssetPaths, resolveUiRoot } from './ui-root';
import { UI_ASSET_PATHS, UI_ASSET_SERVING_ENABLED, UI_ROOT } from './ui.tokens';

@Module({
  controllers: [UiController],
  providers: [
    { provide: UI_ROOT, useFactory: resolveUiRoot },
    {
      provide: UI_ASSET_PATHS,
      inject: [UI_ROOT],
      useFactory: resolveUiAssetPaths,
    },
    {
      provide: UI_ASSET_SERVING_ENABLED,
      useFactory: () => getEnvConfig().NODE_ENV === 'production',
    },
  ],
  exports: [],
})
export class UiModule {}
