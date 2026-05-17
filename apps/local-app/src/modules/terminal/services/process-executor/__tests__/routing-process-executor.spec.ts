import { RoutingProcessExecutor } from '../routing-process-executor';
import { ChildProcessExecutor } from '../child-process-executor';
import { PtyExecutor } from '../pty-executor';

describe('RoutingProcessExecutor', () => {
  const pipeExecutor = new ChildProcessExecutor();
  const ptyExecutor = new PtyExecutor();
  const router = new RoutingProcessExecutor(pipeExecutor, ptyExecutor);

  it('routes pipe mode to ChildProcessExecutor', async () => {
    const result = await router.run({
      argv: ['echo', 'pipe-test'],
      mode: 'pipe',
    });
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('pipe-test');
    expect(result.stderr).toBe('');
  });

  it('routes pty mode to PtyExecutor', async () => {
    const result = await router.run({
      argv: ['echo', 'pty-test'],
      mode: 'pty',
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('pty-test');
  });

  it('preserves timeout behavior across modes', async () => {
    const pipeResult = await router.run({
      argv: ['sleep', '30'],
      mode: 'pipe',
      timeout: 200,
    });
    expect(pipeResult.timedOut).toBe(true);

    const ptyResult = await router.run({
      argv: ['sleep', '30'],
      mode: 'pty',
      timeout: 200,
    });
    expect(ptyResult.timedOut).toBe(true);
  }, 15_000);
});
