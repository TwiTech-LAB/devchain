import type { ProcessExecutor } from '../process-executor/process-executor.port';
import type { SessionTarget } from './types';

export interface ForegroundState {
  readonly panePid: number;
  readonly shellInFront: boolean;
}

/**
 * Reads the pane's shell PID and whether that shell owns the terminal foreground. Returns null
 * when a read fails or is invalid: delivery refuses on null, and monitoring treats it as unknown.
 */
export async function readForegroundState(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<ForegroundState | null> {
  const readProcessId = async (argv: readonly string[]): Promise<number> => {
    const result = await executor.run({ argv, mode: 'pipe', timeout: 2000 });
    const value = result.stdout.trim();
    const processId = Number(value);
    if (
      !result.success ||
      result.timedOut ||
      result.truncated ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(processId) ||
      processId <= 0
    ) {
      throw new Error(`Invalid process ID read: ${argv.join(' ')}`);
    }
    return processId;
  };

  try {
    const panePid = await readProcessId([
      'tmux',
      'display-message',
      '-p',
      '-t',
      `=${target.name}:`,
      '#{pane_pid}',
    ]);
    const foregroundGroup = await readProcessId(['ps', '-o', 'tpgid=', '-p', String(panePid)]);
    // Agent panes start with the shell; wrappers can remain in the CLI's foreground group.
    return { panePid, shellInFront: foregroundGroup === panePid };
  } catch {
    return null;
  }
}
