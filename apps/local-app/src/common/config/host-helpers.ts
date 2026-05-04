const IPV4_WILDCARDS = new Set(['0.0.0.0', '']);
const IPV6_WILDCARDS = new Set(['::', '[::]']);

export function isWildcardHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  return IPV4_WILDCARDS.has(trimmed) || IPV6_WILDCARDS.has(trimmed);
}

export function connectableHost(host: string): string {
  const trimmed = host.trim();
  if (isWildcardHost(trimmed)) {
    if (IPV6_WILDCARDS.has(trimmed.toLowerCase())) {
      return '::1';
    }
    return '127.0.0.1';
  }
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unwrapped;
}

export function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

export function getRuntimeInternalBaseUrl(config: { HOST: string; PORT: number }): string {
  const host = connectableHost(config.HOST);
  return `http://${formatHostForUrl(host)}:${config.PORT}`;
}
