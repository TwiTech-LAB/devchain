import { Global, Module } from '@nestjs/common';
import { HEALTH_READINESS_CHECKER } from './services/health.service';
import { NormalReadinessCheckerService } from './services/normal-readiness-checker.service';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';

@Global()
@Module({
  imports: [ProcessExecutorModule],
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
