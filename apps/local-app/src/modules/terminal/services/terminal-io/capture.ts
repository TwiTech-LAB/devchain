import { createHash } from 'node:crypto';
import type { ProcessExecutor } from '../process-executor/process-executor.port';
import {
  tmuxPaneTarget,
  type SessionTarget,
  type PinnedPane,
  type CaptureResult,
  type CursorPosition,
} from './types';

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_STRICT_OUTPUT_BYTES = 256 * 1024;

export interface CaptureHistoryOptions {
  signal?: AbortSignal;
  /**
   * Join rows that tmux soft-wrapped into one line (`capture-pane -J`). Use it when the
   * capture is replayed into xterm: xterm wraps the line again and marks the rows as wrapped,
   * so a copied selection stays one line. Without it, each wrapped row is a hard line.
   */
  joinWrappedLines?: boolean;
}

export async function captureHistory(
  executor: ProcessExecutor,
  target: SessionTarget | PinnedPane,
  lines: number,
  includeEscapes = true,
  options: CaptureHistoryOptions = {},
): Promise<CaptureResult> {
  const start = `-${Math.max(0, Math.floor(lines))}`;
  const baseArgv = ['tmux', 'capture-pane', '-p', '-S', start, '-t', tmuxPaneTarget(target)];
  if (options.joinWrappedLines) baseArgv.push('-J');
  const preferredArgv = includeEscapes ? [...baseArgv, '-e'] : baseArgv;

  const result = await executor.run({
    argv: preferredArgv,
    mode: 'pipe',
    signal: options.signal,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
  });

  if (result.success) {
    return { ok: !options.signal?.aborted, output: result.stdout ?? '' };
  }

  if (includeEscapes && /unknown option|invalid option/i.test(result.stderr)) {
    const fallback = await executor.run({
      argv: baseArgv,
      mode: 'pipe',
      signal: options.signal,
      outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
    });

    return { ok: fallback.success, output: fallback.stdout ?? '', error: fallback.stderr };
  }

  return { ok: false, output: '', error: result.stderr };
}

export async function captureStrict(
  executor: ProcessExecutor,
  target: SessionTarget,
  tailLines: number,
): Promise<CaptureResult> {
  const start = `-${Math.max(0, Math.floor(tailLines))}`;

  const result = await executor.run({
    argv: ['tmux', 'capture-pane', '-p', '-S', start, '-t', `=${target.name}:`],
    mode: 'pipe',
    outputLimits: { maxBytes: MAX_STRICT_OUTPUT_BYTES },
  });

  if (result.success) {
    return { ok: true, output: result.stdout ?? '' };
  }

  return { ok: false, output: '', error: result.stderr };
}

export async function getCursorPosition(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<CursorPosition | null> {
  const result = await executor.run({
    argv: ['tmux', 'display-message', '-p', '-t', `=${target.name}:`, '#{cursor_x} #{cursor_y}'],
    mode: 'pipe',
  });

  if (!result.success) return null;

  const parts = (result.stdout ?? '').trim().split(/\s+/);
  if (parts.length >= 2) {
    const x = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  return null;
}

export async function composerSnapshot(
  executor: ProcessExecutor,
  paneId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await executor.run({
    argv: [
      'tmux',
      'display-message',
      '-p',
      '-t',
      paneId,
      '#{pane_id} #{pane_pid} #{cursor_x} #{cursor_y}',
      ';',
      'capture-pane',
      '-p',
      '-t',
      paneId,
    ],
    mode: 'pipe',
    outputLimits: { maxBytes: MAX_STRICT_OUTPUT_BYTES },
    signal,
  });
  if (
    signal.aborted ||
    !result.success ||
    result.timedOut ||
    result.truncated ||
    !result.stdout.startsWith(paneId + ' ')
  )
    return null;
  return createHash('sha256').update(result.stdout).digest('hex');
}

export async function getSessionCwd(
  executor: ProcessExecutor,
  target: SessionTarget,
): Promise<string | null> {
  const paneResult = await executor.run({
    argv: ['tmux', 'list-panes', '-t', `=${target.name}`, '-F', '#{pane_id}'],
    mode: 'pipe',
  });

  if (!paneResult.success) return null;

  const paneId = paneResult.stdout.trim().split('\n')[0];
  if (!paneId || !/^%\d+$/.test(paneId)) return null;

  const cwdResult = await executor.run({
    argv: ['tmux', 'display-message', '-t', paneId, '-p', '#{pane_current_path}'],
    mode: 'pipe',
  });

  if (!cwdResult.success) return null;

  const cwd = cwdResult.stdout.trim();
  return cwd || null;
}
