import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type ProbeOutcome = {
  supported: boolean;
  status: 'supported' | 'unsupported' | 'timeout' | 'launch_failure';
  capture?: string;
  detail?: string;
};

const PROBE_ARGS = ['--model', 'opus[1m]', 'test', '-p', '--output-format', 'json'];
const CAPTURE_LIMIT = 5000;

// Model/binary incompatibility → unsupported (non-retryable)
const MODEL_ERROR_PATTERN =
  /\bmodel\b.*\b(not[_ ]found|invalid|unsupported|not[_ ]available|does[_ ]not[_ ]exist|unknown)\b|\b(unsupported|invalid|unknown)\b.*\bmodel\b|\bdoes not support\b/;

export async function probe1mSupport(binPath: string, timeoutMs = 30_000): Promise<ProbeOutcome> {
  // execFile dual-path: Claude CLI exits non-zero on is_error:true
  // but still emits valid JSON on stdout
  let stdout = '';
  try {
    const result = await execFileAsync(binPath, PROBE_ARGS, { timeout: timeoutMs });
    stdout = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { killed?: boolean; signal?: string; stdout?: string };
    if (execErr.killed || execErr.signal === 'SIGTERM') {
      return {
        supported: false,
        status: 'timeout',
        detail: `Timed out after ${timeoutMs}ms waiting for Claude output`,
      };
    }
    stdout = execErr.stdout ?? '';
  }

  if (!stdout.trim()) {
    return {
      supported: false,
      status: 'launch_failure',
      detail: 'No output from probe command',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      supported: false,
      status: 'launch_failure',
      capture: stdout.slice(0, CAPTURE_LIMIT),
      detail: 'Failed to parse JSON output from probe command',
    };
  }

  // modelUsage.contextWindow === 1_000_000 is the definitive 1M signal
  const modelUsage = parsed.modelUsage as Record<string, { contextWindow?: number }> | undefined;
  const has1mContext = modelUsage
    ? Object.values(modelUsage).some((m) => m.contextWindow === 1_000_000)
    : false;

  if (has1mContext) {
    return {
      supported: true,
      status: 'supported',
      capture: stdout.slice(0, CAPTURE_LIMIT),
    };
  }

  // is_error:false means the alias ran successfully but no 1M — unsupported
  if (parsed.is_error === false) {
    return {
      supported: false,
      status: 'unsupported',
      capture: stdout.slice(0, CAPTURE_LIMIT),
    };
  }

  // is_error:true — classify by error kind
  const errorStr = typeof parsed.error === 'string' ? parsed.error : '';
  const resultStr = typeof parsed.result === 'string' ? parsed.result : '';
  const combined = `${errorStr}\n${resultStr}`.toLowerCase();

  if (MODEL_ERROR_PATTERN.test(combined)) {
    return {
      supported: false,
      status: 'unsupported',
      capture: stdout.slice(0, CAPTURE_LIMIT),
      detail: 'Binary does not support the 1M model alias',
    };
  }

  // Transient errors (rate-limit, auth, network) → launch_failure (retryable)
  return {
    supported: false,
    status: 'launch_failure',
    capture: stdout.slice(0, CAPTURE_LIMIT),
    detail: 'Probe returned error — may be retryable (rate-limit, auth, network)',
  };
}
