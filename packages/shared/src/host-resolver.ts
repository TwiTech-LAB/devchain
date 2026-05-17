const IPV4_WILDCARDS = new Set(['0.0.0.0', '']);
const IPV6_WILDCARDS = new Set(['::', '[::]']);

export class HostResolver {
  static normalizeHost(input: string | undefined): string {
    const raw = input ?? '';

    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) {
        throw new Error('Invalid host: contains control characters');
      }
    }

    const trimmed = raw.trim();
    if (!trimmed) return '127.0.0.1';

    if (/^https?:\/\//i.test(trimmed)) {
      throw new Error(`Invalid host "${trimmed}": pass a hostname or IP, not a URL`);
    }

    if (trimmed === '*') {
      throw new Error(
        'Invalid host "*": use 0.0.0.0 for all IPv4 interfaces or :: for all IPv6 interfaces',
      );
    }

    if (/^\[.*\]$/.test(trimmed)) {
      const inner = trimmed.slice(1, -1);
      throw new Error(`Invalid host "${trimmed}": drop the brackets — use ${inner}`);
    }

    const colonCount = (trimmed.match(/:/g) || []).length;
    const looksLikeIpv6 = colonCount >= 2 || trimmed.startsWith(':') || trimmed.includes('::');

    if (!looksLikeIpv6 && colonCount === 1) {
      throw new Error(
        `Invalid host "${trimmed}": looks like host:port — pass only the host part`,
      );
    }

    return trimmed;
  }

  static isWildcardHost(host: string): boolean {
    const trimmed = host.trim().toLowerCase();
    return IPV4_WILDCARDS.has(trimmed) || IPV6_WILDCARDS.has(trimmed);
  }

  static isNonLoopbackHost(host: string): boolean {
    if (HostResolver.isWildcardHost(host)) return true;
    const lower = host.toLowerCase();
    return lower !== '127.0.0.1' && lower !== '::1' && lower !== 'localhost';
  }

  static connectableHost(host: string): string {
    const trimmed = host.trim();
    if (HostResolver.isWildcardHost(trimmed)) {
      if (IPV6_WILDCARDS.has(trimmed.toLowerCase())) {
        return '::1';
      }
      return '127.0.0.1';
    }
    const unwrapped =
      trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    return unwrapped;
  }

  static formatHostForUrl(host: string): string {
    if (host.includes(':') && !host.startsWith('[')) {
      return `[${host}]`;
    }
    return host;
  }

  static buildInternalBaseUrl(config: { host: string; port: number }): string {
    const host = HostResolver.connectableHost(config.host);
    return `http://${HostResolver.formatHostForUrl(host)}:${config.port}`;
  }

  static buildDisplayUrls(config: { host: string; port: number }): { primary: string } {
    return {
      primary: HostResolver.buildInternalBaseUrl(config),
    };
  }
}
