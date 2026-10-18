export type PercentTone = 'normal' | 'warn' | 'danger';

/** Warning from 75%, danger from 90%; the thresholds apply to the displayed (rounded) percent. */
export function percentTone(percent: number): PercentTone {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'normal';
}

export const PERCENT_TONE_TEXT_CLASS: Record<PercentTone, string> = {
  normal: '',
  warn: 'text-status-warn',
  danger: 'text-status-danger',
};

export const PERCENT_TONE_FILL_CLASS: Record<PercentTone, string> = {
  normal: 'bg-primary',
  warn: 'bg-status-warn',
  danger: 'bg-status-danger',
};
