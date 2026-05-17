import { Injectable } from '@nestjs/common';
import {
  ProcessExecutor,
  ProcessExecutorOptions,
  ExecutorResult,
  DaemonSpawnOptions,
  DaemonSpawnResult,
} from './process-executor.port';
import { ChildProcessExecutor } from './child-process-executor';
import { PtyExecutor } from './pty-executor';

@Injectable()
export class RoutingProcessExecutor extends ProcessExecutor {
  constructor(
    private readonly pipeExecutor: ChildProcessExecutor,
    private readonly ptyExecutor: PtyExecutor,
  ) {
    super();
  }

  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    return options.mode === 'pty' ? this.ptyExecutor.run(options) : this.pipeExecutor.run(options);
  }

  async spawnDaemon(options: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
    return this.pipeExecutor.spawnDaemon(options);
  }
}
