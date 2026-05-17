import type { ExecutorResult, ProcessExecutor } from '../process-executor/process-executor.port';
import type { SessionTarget, CreateSessionOptions } from './types';

const STRICT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

function assertHexColor(color: string, field: string): void {
  if (!STRICT_HEX_RE.test(color)) {
    throw new Error(`Invalid ${field}: "${color}" — must be a strict #RRGGBB hex color`);
  }
}

function assertTmuxOptionApplied(
  result: ExecutorResult,
  target: SessionTarget,
  optionName: 'window-style' | 'window-active-style',
): void {
  if (result.success && !result.timedOut) {
    return;
  }

  const reason = result.timedOut
    ? 'timed out'
    : result.stderr || `exit code ${result.exitCode ?? 'unknown'}`;

  throw new Error(`Failed to apply tmux ${optionName} for session "${target.name}": ${reason}`);
}

export async function createSession(
  executor: ProcessExecutor,
  name: string,
  command: string[],
  options: CreateSessionOptions,
): Promise<SessionTarget> {
  const createResult = await executor.run({
    argv: ['tmux', 'new-session', '-d', '-s', name, '-c', options.cwd, ...command],
    mode: 'pipe',
    env: options.env ? { ...options.env } : undefined,
  });

  if (!createResult.success) {
    throw new Error(`Failed to create tmux session "${name}": ${createResult.stderr}`);
  }

  await executor.run({
    argv: ['tmux', 'set-option', '-t', name, 'status', 'off'],
    mode: 'pipe',
  });

  // Forward inner-program OSC 52 (e.g. Claude clipboard) to the outer client.
  // Default `external` makes tmux drop inner OSC 52 entirely; `on` accepts it
  // and re-emits to the outer terminal (terminal-features default already
  // advertises the clipboard capability for xterm*). Server-scope option.
  await executor.run({
    argv: ['tmux', 'set-option', '-s', 'set-clipboard', 'on'],
    mode: 'pipe',
  });

  return { name };
}

export async function destroySession(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<void> {
  const result = await executor.run({
    argv: ['tmux', 'kill-session', '-t', `=${target.name}`],
    mode: 'pipe',
  });

  if (!result.success) {
    throw new Error(`Failed to destroy tmux session "${target.name}": ${result.stderr}`);
  }
}

export async function listSessions(executor: ProcessExecutor): Promise<SessionTarget[]> {
  const result = await executor.run({
    argv: ['tmux', 'list-sessions', '-F', '#{session_name}'],
    mode: 'pipe',
  });

  if (!result.success) {
    return [];
  }

  return result.stdout
    .trim()
    .split('\n')
    .filter((name) => name.startsWith('devchain_'))
    .map((name) => ({ name }));
}

export async function sessionExists(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<boolean> {
  const result = await executor.run({
    argv: ['tmux', 'has-session', '-t', `=${target.name}`],
    mode: 'pipe',
  });

  return result.success;
}

/**
 * Applies tmux window-style and window-active-style to the target session's
 * current window using strict per-window options (no global/server options).
 * Both colors must be strict #RRGGBB hex — rejected before any executor call.
 * The target `=<name>:` uses exact-match session + current window.
 */
export async function applyWindowTheme(
  executor: ProcessExecutor,
  target: SessionTarget,
  foreground: string,
  background: string,
): Promise<void> {
  assertHexColor(foreground, 'foreground');
  assertHexColor(background, 'background');

  const style = `fg=${foreground},bg=${background}`;

  const windowStyleResult = await executor.run({
    argv: ['tmux', 'set-window-option', '-t', `=${target.name}:`, 'window-style', style],
    mode: 'pipe',
  });
  assertTmuxOptionApplied(windowStyleResult, target, 'window-style');

  const activeStyleResult = await executor.run({
    argv: ['tmux', 'set-window-option', '-t', `=${target.name}:`, 'window-active-style', style],
    mode: 'pipe',
  });
  assertTmuxOptionApplied(activeStyleResult, target, 'window-active-style');
}
