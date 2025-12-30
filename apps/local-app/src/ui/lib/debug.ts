export function isTerminalDebug(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const v = window.localStorage?.getItem('devchain:terminal:debug');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

export function termLog(event: string, data?: unknown): void {
  if (!isTerminalDebug()) return;
  // eslint-disable-next-line no-console
  console.log('[terminal]', event, data ?? '');
}
