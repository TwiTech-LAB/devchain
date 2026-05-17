import { Module } from '@nestjs/common';
import { ProcessExecutor } from './process-executor.port';
import { ChildProcessExecutor } from './child-process-executor';
import { PtyExecutor } from './pty-executor';
import { RoutingProcessExecutor } from './routing-process-executor';

@Module({
  providers: [
    ChildProcessExecutor,
    PtyExecutor,
    {
      provide: ProcessExecutor,
      useClass: RoutingProcessExecutor,
    },
  ],
  exports: [ProcessExecutor],
})
export class ProcessExecutorModule {}
