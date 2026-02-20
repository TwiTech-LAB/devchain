import { Global, Module } from '@nestjs/common';
import { HEALTH_READINESS_CHECKER } from './services/health.service';
import { NormalReadinessCheckerService } from './services/normal-readiness-checker.service';

@Global()
@Module({
  providers: [
    NormalReadinessCheckerService,
    {
      provide: HEALTH_READINESS_CHECKER,
      useExisting: NormalReadinessCheckerService,
    },
  ],
  exports: [HEALTH_READINESS_CHECKER],
})
export class CoreNormalHealthModule {}
