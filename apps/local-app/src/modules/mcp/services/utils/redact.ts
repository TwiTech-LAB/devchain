export function redactSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '(none)';
  return sessionId.slice(0, 4) + '****';
}

export function redactParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const obj = params as Record<string, unknown>;
  if ('sessionId' in obj && typeof obj.sessionId === 'string') {
    return { ...obj, sessionId: redactSessionId(obj.sessionId) };
  }
  return params;
}
