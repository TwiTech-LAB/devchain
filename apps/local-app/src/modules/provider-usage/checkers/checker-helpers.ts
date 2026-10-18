import { STANDARD_WINDOW_LABELS, type UsageWindow } from '@devchain/shared';

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The 5-hour or weekly window, with the id and label every checker uses for it. */
export function standardWindow(
  kind: keyof typeof STANDARD_WINDOW_LABELS,
  usedPercent: number,
  resetsAt: number | null,
): UsageWindow {
  return { id: kind, label: STANDARD_WINDOW_LABELS[kind], kind, usedPercent, resetsAt };
}
