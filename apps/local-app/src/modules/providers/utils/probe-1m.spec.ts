jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = jest.requireActual('child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require('util');
  const asyncMock = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
  const mockFn = jest.fn();
  Object.defineProperty(mockFn, promisify.custom, {
    value: asyncMock,
    writable: true,
  });
  return { ...actual, execFile: mockFn, __mockExecFileAsync: asyncMock };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mockExecFileAsync = require('child_process').__mockExecFileAsync as jest.Mock;

import { probe1mSupport, ProbeOutcome } from './probe-1m';

const BIN = '/usr/local/bin/claude';

describe('probe1mSupport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns supported when modelUsage.contextWindow === 1_000_000', async () => {
    const json = JSON.stringify({
      is_error: false,
      modelUsage: { 'claude-opus': { contextWindow: 1_000_000 } },
    });
    mockExecFileAsync.mockResolvedValue({ stdout: json, stderr: '' });

    const result = await probe1mSupport(BIN);

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
    mockExecFileAsync.mockResolvedValue({ stdout: json, stderr: '' });

    const result = await probe1mSupport(BIN);

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
    mockExecFileAsync.mockRejectedValue({ stdout: json });

    const result = await probe1mSupport(BIN);

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
    mockExecFileAsync.mockRejectedValue({ stdout: json });

    const result = await probe1mSupport(BIN);

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
    mockExecFileAsync.mockRejectedValue({ stdout: json });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'unsupported',
      capture: json,
      detail: 'Binary does not support the 1M model alias',
    });
  });

  it('returns timeout when process is killed', async () => {
    mockExecFileAsync.mockRejectedValue({ killed: true, stdout: '' });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'timeout',
      detail: 'Timed out after 30000ms waiting for Claude output',
    });
  });

  it('returns timeout when SIGTERM signal is received', async () => {
    mockExecFileAsync.mockRejectedValue({ signal: 'SIGTERM', stdout: '' });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'timeout',
      detail: 'Timed out after 30000ms waiting for Claude output',
    });
  });

  it('returns timeout with custom timeoutMs in detail', async () => {
    mockExecFileAsync.mockRejectedValue({ killed: true, stdout: '' });

    const result = await probe1mSupport(BIN, 10_000);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'timeout',
      detail: 'Timed out after 10000ms waiting for Claude output',
    });
  });

  it('returns launch_failure when no stdout', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    });
  });

  it('returns launch_failure when stdout is whitespace only', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '   \n  ', stderr: '' });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    });
  });

  it('returns launch_failure for invalid JSON', async () => {
    const badJson = 'not valid json {{{';
    mockExecFileAsync.mockResolvedValue({ stdout: badJson, stderr: '' });

    const result = await probe1mSupport(BIN);

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
    mockExecFileAsync.mockResolvedValue({ stdout: json, stderr: '' });

    const result = await probe1mSupport(BIN);

    expect(result.capture).toBeDefined();
    expect(result.capture!.length).toBe(5000);
  });

  it('handles non-zero exit with valid JSON on stdout', async () => {
    const json = JSON.stringify({
      is_error: false,
      modelUsage: { 'claude-opus': { contextWindow: 1_000_000 } },
    });
    mockExecFileAsync.mockRejectedValue({ stdout: json });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: true,
      status: 'supported',
      capture: json,
    });
  });

  it('handles error with no stdout property', async () => {
    mockExecFileAsync.mockRejectedValue({ killed: false });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    });
  });

  it('passes binPath and timeout to execFileAsync', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '{}', stderr: '' });

    await probe1mSupport('/custom/bin', 15_000);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      '/custom/bin',
      ['--model', 'opus[1m]', 'test', '-p', '--output-format', 'json'],
      { timeout: 15_000 },
    );
  });

  it('returns unsupported for is_error:true with unsupported model error', async () => {
    const json = JSON.stringify({
      is_error: true,
      error: 'unsupported model requested',
      result: '',
    });
    mockExecFileAsync.mockRejectedValue({ stdout: json });

    const result = await probe1mSupport(BIN);

    expect(result).toEqual<ProbeOutcome>({
      supported: false,
      status: 'unsupported',
      capture: json,
      detail: 'Binary does not support the 1M model alias',
    });
  });
});
