/**
 * A status tone: one of the semantic colors a status badge or chip can show.
 * `running` means work is in progress right now; steady states must not use it.
 */
export type StatusTone = 'ok' | 'warn' | 'error' | 'running' | 'neutral' | 'info';

/** Theme tokens only, so the tones hold in light, dark and ocean. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  ok: 'border-status-ok/40 bg-status-ok/10 text-status-ok',
  warn: 'border-status-warn/40 bg-status-warn/10 text-status-warn',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
  running: 'border-primary/40 bg-primary/10 text-primary',
  neutral: 'text-muted-foreground',
  info: 'border-status-info/40 bg-status-info/10 text-status-info',
};
