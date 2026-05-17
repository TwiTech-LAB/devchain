import { Module, Global } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { RegistryClientService } from './services/registry-client.service';
import { TemplateCacheService } from './services/template-cache.service';
import { RegistryOrchestrationService } from './services/registry-orchestration.service';
import { UnifiedTemplateService } from './services/unified-template.service';
import { RegistryController } from './controllers/registry.controller';
import { TemplatesController } from './controllers/templates.controller';

@Global()
@Module({
  imports: [SettingsModule, StorageModule],
  controllers: [RegistryController, TemplatesController],
  providers: [
    RegistryClientService,
    TemplateCacheService,
    RegistryOrchestrationService,
    UnifiedTemplateService,
  ],
  exports: [
    RegistryClientService,
    TemplateCacheService,
    RegistryOrchestrationService,
    UnifiedTemplateService,
  ],
})
export class RegistryModule {}
