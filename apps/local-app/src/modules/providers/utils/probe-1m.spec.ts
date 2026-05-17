import { probe1mSupport, ProbeOutcome } from './probe-1m';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';

const BIN = '/usr/local/bin/claude';

describe('probe1mSupport', () => {
  let fakeExecutor: FakeProcessExecutor;

  beforeEach(() => {
    fakeExecutor = new FakeProcessExecutor();
  });

  it('returns supported when modelUsage.contextWindow === 1_000_000', async () => {
    const json = JSON.stringify({
      is_error: false,
      modelUsage: { 'claude-opus': { contextWindow: 1_000_000 } },
    });
    fakeExecutor.enqueueResponse({ type: 'success', stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: true,
      status: 'supported',
      capture: json,
    });
  });

  it('returns unsupported when is_error:false but no 1M context', async () => {
    const json = JSON.stringify({
      is_error: false,
      modelUsage: { 'claude-opus': { contextWindow: 200_000 } },
    });
    fakeExecutor.enqueueResponse({ type: 'success', stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'unsupported',
      capture: json,
    });
  });

  it('returns launch_failure for is_error:true with rate-limit error', async () => {
    const json = JSON.stringify({
      is_error: true,
      error: 'Rate limit exceeded',
      result: '',
    });
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1, stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      capture: json,
      detail: 'Probe returned error — may be retryable (rate-limit, auth, network)',
    });
  });

  it('returns unsupported for is_error:true with model not found error', async () => {
    const json = JSON.stringify({
      is_error: true,
      error: 'Model not found for this account',
      result: '',
    });
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1, stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'unsupported',
      capture: json,
      detail: 'Binary does not support the 1M model alias',
    });
  });

  it('returns unsupported for is_error:true with "does not support" error', async () => {
    const json = JSON.stringify({
      is_error: true,
      error: '',
      result: 'This version does not support the requested feature',
    });
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1, stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'unsupported',
      capture: json,
      detail: 'Binary does not support the 1M model alias',
    });
  });

  it('returns timeout when process times out', async () => {
    fakeExecutor.enqueueResponse({ type: 'timeout' });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'timeout',
      detail: 'Timed out after 30000ms waiting for Claude output',
    });
  });

  it('returns timeout with custom timeoutMs in detail', async () => {
    fakeExecutor.enqueueResponse({ type: 'timeout' });

    const result = await probe1mSupport(fakeExecutor, BIN, 10_000);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'timeout',
      detail: 'Timed out after 10000ms waiting for Claude output',
    });
  });

  it('returns launch_failure when no stdout', async () => {
    fakeExecutor.enqueueResponse({ type: 'success', stdout: '' });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    });
  });

  it('returns launch_failure when stdout is whitespace only', async () => {
    fakeExecutor.enqueueResponse({ type: 'success', stdout: '   \n  ' });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    });
  });

  it('returns launch_failure for invalid JSON', async () => {
    const badJson = 'not valid json {{{';
    fakeExecutor.enqueueResponse({ type: 'success', stdout: badJson });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      capture: badJson,
      detail: 'Failed to parse JSON output from probe command',
    });
  });

  it('truncates capture to 5000 characters', async () => {
    const longOutput = 'x'.repeat(10_000);
    const json = JSON.stringify({ is_error: false, result: longOutput });
    fakeExecutor.enqueueResponse({ type: 'success', stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result.capture).toBeDefined();
    expect(result.capture!.length).toBe(5000);
  });

  it('handles non-zero exit with valid JSON on stdout', async () => {
    const json = JSON.stringify({
      is_error: false,
      modelUsage: { 'claude-opus': { contextWindow: 1_000_000 } },
    });
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1, stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: true,
      status: 'supported',
      capture: json,
    });
  });

  it('handles failure with no stdout', async () => {
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1 });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    });
  });

  it('passes binPath and timeout to executor', async () => {
    fakeExecutor.enqueueResponse({ type: 'success', stdout: '{}' });

    await probe1mSupport(fakeExecutor, '/custom/bin', 15_000);

    expect(fakeExecutor.calls[0]).toEqual(
      expect.objectContaining({
        argv: ['/custom/bin', '--model', 'opus[1m]', 'test', '-p', '--output-format', 'json'],
        mode: 'pipe',
      }),
    );
  });

  it('returns unsupported for is_error:true with unsupported model error', async () => {
    const json = JSON.stringify({
      is_error: true,
      error: 'unsupported model requested',
      result: '',
    });
    fakeExecutor.enqueueResponse({ type: 'failure', exitCode: 1, stdout: json });

    const result = await probe1mSupport(fakeExecutor, BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'unsupported',
      capture: json,
      detail: 'Binary does not support the 1M model alias',
    });
  });
});
