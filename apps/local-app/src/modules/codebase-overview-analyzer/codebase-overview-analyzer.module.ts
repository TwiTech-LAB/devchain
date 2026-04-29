import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { CodebaseOverviewAnalyzerService } from './services/codebase-overview-analyzer.service';
import { IdentityResolverService } from './services/identity-resolver.service';
import { HotspotScoringService } from './services/hotspot-scoring.service';
import { DistrictSplittingService } from './services/district-splitting.service';
import { DependencyAggregationService } from './services/dependency-aggregation.service';
import { EvidenceQueryService } from './services/evidence-query.service';
import { LanguageAdapterRegistryService } from './services/language-adapter-registry.service';
import { ScopeResolverService } from './services/scope-resolver.service';
import { ScopeAutoDetectorService } from './services/scope-auto-detector.service';
import { OverviewScopeRepository } from './repositories/overview-scope.repository';
import { CodebaseOverviewController } from './controllers/codebase-overview.controller';

@Module({
  imports: [StorageModule, SettingsModule],
  controllers: [CodebaseOverviewController],
  providers: [
    IdentityResolverService,
    HotspotScoringService,
    DistrictSplittingService,
    DependencyAggregationService,
    EvidenceQueryService,
    LanguageAdapterRegistryService,
    ScopeResolverService,
    ScopeAutoDetectorService,
    OverviewScopeRepository,
    CodebaseOverviewAnalyzerService,
  ],
  exports: [
    CodebaseOverviewAnalyzerService,
    ScopeResolverService,
    ScopeAutoDetectorService,
    OverviewScopeRepository,
  ],
})
export class CodebaseOverviewAnalyzerModule {}
