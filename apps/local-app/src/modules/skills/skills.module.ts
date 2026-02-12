import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { AnthropicSkillSource } from './adapters/anthropic-skill-source.adapter';
import { MicrosoftSkillSource } from './adapters/microsoft-skill-source.adapter';
import { OpenAISkillSource } from './adapters/openai-skill-source.adapter';
import { SKILL_SOURCE_ADAPTERS } from './adapters/skill-source.adapter';
import { TrailOfBitsSkillSource } from './adapters/trailofbits-skill-source.adapter';
import { VercelSkillSource } from './adapters/vercel-skill-source.adapter';
import { SkillsController } from './controllers/skills.controller';
import { SkillCategoryService } from './services/skill-category.service';
import { SkillsService } from './services/skills.service';
import { SkillSyncService } from './services/skill-sync.service';

@Module({
  imports: [StorageModule, SettingsModule],
  controllers: [SkillsController],
  providers: [
    AnthropicSkillSource,
    MicrosoftSkillSource,
    OpenAISkillSource,
    TrailOfBitsSkillSource,
    VercelSkillSource,
    SkillCategoryService,
    SkillsService,
    SkillSyncService,
    {
      provide: SKILL_SOURCE_ADAPTERS,
      useFactory: (
        anthropicSkillSource: AnthropicSkillSource,
        microsoftSkillSource: MicrosoftSkillSource,
        openAISkillSource: OpenAISkillSource,
        trailOfBitsSkillSource: TrailOfBitsSkillSource,
        vercelSkillSource: VercelSkillSource,
      ) => [
        anthropicSkillSource,
        microsoftSkillSource,
        openAISkillSource,
        trailOfBitsSkillSource,
        vercelSkillSource,
      ],
      inject: [
        AnthropicSkillSource,
        MicrosoftSkillSource,
        OpenAISkillSource,
        TrailOfBitsSkillSource,
        VercelSkillSource,
      ],
    },
  ],
  exports: [
    AnthropicSkillSource,
    MicrosoftSkillSource,
    OpenAISkillSource,
    TrailOfBitsSkillSource,
    VercelSkillSource,
    SkillCategoryService,
    SkillsService,
    SkillSyncService,
    SKILL_SOURCE_ADAPTERS,
  ],
})
export class SkillsModule {}
