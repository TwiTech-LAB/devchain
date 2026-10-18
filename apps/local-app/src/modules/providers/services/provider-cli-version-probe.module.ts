import { Module } from '@nestjs/common';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';
import { ProviderCliVersionProbe } from './provider-cli-version-probe.service';

@Module({
  imports: [ProcessExecutorModule],
  providers: [ProviderCliVersionProbe],
  exports: [ProviderCliVersionProbe],
})
export class ProviderCliVersionProbeModule {}
