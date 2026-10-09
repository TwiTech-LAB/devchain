import { Module } from '@nestjs/common';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';
import { HostHelperService } from './host-helper.service';

@Module({
  imports: [ProcessExecutorModule],
  providers: [HostHelperService],
  exports: [HostHelperService],
})
export class HostHelperModule {}
