/**
 * Shared formatting utilities for session-reader UI components.
 *
 * All session-reader components should import from here to avoid duplication.
 */

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

/** Compact token display: 500, 1.5k, 15k, 2.3M */
export function formatTokensCompact(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Smart token display: 500, 1,500, 15k, 2.3M (commas for < 10k) */
export function formatTokensSmart(count: number): string {
  if (count < 10_000) return count.toLocaleString('en-US');
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Detailed token display with commas: 1,500 */
export function formatTokensDetailed(count: number): string {
  return count.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Cost formatting
// ---------------------------------------------------------------------------

/** Adaptive precision cost: $1.23, $0.04, $0.0012 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/** Human-readable duration: 500ms, 2.5s, 2m 30s, 1h 15m */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1_000);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const remainMins = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${remainMins}m`;
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

/** Format numerator/denominator ratio as percentage */
export function formatContextPercent(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  const pct = (numerator / denominator) * 100;
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

/** Format ISO timestamp to HH:MM:SS */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/** Truncate text with ellipsis */
export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
