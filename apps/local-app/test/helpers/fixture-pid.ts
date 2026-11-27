/**
 * The PID that a test fixture wrote or printed, or null when the text is not a positive integer.
 *
 * An empty or partly written PID file reads as `Number('') === 0`, and a signal to PID 0 reaches
 * the test runner's whole process group. Signal only a non-null result.
 */
export function fixturePid(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

type KillFn = (pid: number, signal: NodeJS.Signals) => void;

/** Sends SIGKILL to the fixture process in `text`. Skips an invalid PID and a process that is gone. */
export function killFixturePid(
  text: string,
  kill: KillFn = (pid, signal) => process.kill(pid, signal),
): void {
  const pid = fixturePid(text);
  if (pid === null) return;
  try {
    kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
