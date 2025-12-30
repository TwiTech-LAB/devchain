import { Module, Global, forwardRef } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectsModule } from '../projects/projects.module';
import { RegistryClientService } from './services/registry-client.service';
import { TemplateCacheService } from './services/template-cache.service';
import { RegistryOrchestrationService } from './services/registry-orchestration.service';
import { TemplateUpgradeService } from './services/template-upgrade.service';
import { UnifiedTemplateService } from './services/unified-template.service';
import { RegistryController } from './controllers/registry.controller';
import { TemplatesController } from './controllers/templates.controller';

@Global()
@Module({
  imports: [SettingsModule, StorageModule, forwardRef(() => ProjectsModule)],
  controllers: [RegistryController, TemplatesController],
  providers: [
    RegistryClientService,
    TemplateCacheService,
    RegistryOrchestrationService,
    TemplateUpgradeService,
    UnifiedTemplateService,
  ],
  exports: [
    RegistryClientService,
    TemplateCacheService,
    RegistryOrchestrationService,
    TemplateUpgradeService,
    UnifiedTemplateService,
  ],
})
export class RegistryModule {}
