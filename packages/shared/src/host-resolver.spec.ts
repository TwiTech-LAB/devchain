import { describe, it, expect } from 'vitest';
import { HostResolver } from './host-resolver';

describe('HostResolver.normalizeHost', () => {
  it('defaults empty string to 127.0.0.1', () => {
    expect(HostResolver.normalizeHost('')).toBe('127.0.0.1');
  });

  it('defaults whitespace-only to 127.0.0.1', () => {
    expect(HostResolver.normalizeHost('   ')).toBe('127.0.0.1');
  });

  it('defaults undefined to 127.0.0.1', () => {
    expect(HostResolver.normalizeHost(undefined)).toBe('127.0.0.1');
  });

  it('accepts 0.0.0.0 (IPv4 wildcard)', () => {
    expect(HostResolver.normalizeHost('0.0.0.0')).toBe('0.0.0.0');
  });

  it('accepts :: (IPv6 wildcard)', () => {
    expect(HostResolver.normalizeHost('::')).toBe('::');
  });

  it('accepts ::1 (IPv6 loopback)', () => {
    expect(HostResolver.normalizeHost('::1')).toBe('::1');
  });

  it('accepts 2001:db8::1 (IPv6 literal)', () => {
    expect(HostResolver.normalizeHost('2001:db8::1')).toBe('2001:db8::1');
  });

  it('accepts 127.0.0.1', () => {
    expect(HostResolver.normalizeHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it('accepts 192.168.1.10', () => {
    expect(HostResolver.normalizeHost('192.168.1.10')).toBe('192.168.1.10');
  });

  it('accepts hostnames like example.local', () => {
    expect(HostResolver.normalizeHost('example.local')).toBe('example.local');
  });

  it('trims whitespace', () => {
    expect(HostResolver.normalizeHost('  127.0.0.1  ')).toBe('127.0.0.1');
  });

  it('rejects bracketed IPv6 [::1]', () => {
    expect(() => HostResolver.normalizeHost('[::1]')).toThrow(/drop the brackets.*::1/);
  });

  it('rejects bracketed IPv6 [2001:db8::1]', () => {
    expect(() => HostResolver.normalizeHost('[2001:db8::1]')).toThrow(/drop the brackets/);
  });

  it('rejects IPv4 host:port 127.0.0.1:3000', () => {
    expect(() => HostResolver.normalizeHost('127.0.0.1:3000')).toThrow(/host:port/);
  });

  it('rejects hostname:port example.com:3000', () => {
    expect(() => HostResolver.normalizeHost('example.com:3000')).toThrow(/host:port/);
  });

  it('rejects URL http://0.0.0.0', () => {
    expect(() => HostResolver.normalizeHost('http://0.0.0.0')).toThrow(/not a URL/);
  });

  it('rejects URL https://example.com', () => {
    expect(() => HostResolver.normalizeHost('https://example.com')).toThrow(/not a URL/);
  });

  it('rejects * with hint', () => {
    expect(() => HostResolver.normalizeHost('*')).toThrow(/0\.0\.0\.0.*::/);
  });

  it('rejects control characters \\x00', () => {
    expect(() => HostResolver.normalizeHost('\x00')).toThrow(/control characters/);
  });

  it('rejects control characters \\n embedded', () => {
    expect(() => HostResolver.normalizeHost('\n127.0.0.1')).toThrow(/control characters/);
  });
});

describe('HostResolver.isWildcardHost', () => {
  it.each([
    ['0.0.0.0', true],
    ['::', true],
    ['[::]', true],
    ['', true],
    ['  0.0.0.0  ', true],
    ['127.0.0.1', false],
    ['::1', false],
    ['192.168.1.10', false],
    ['localhost', false],
    ['fe80::1', false],
  ])('isWildcardHost(%s) = %s', (input, expected) => {
    expect(HostResolver.isWildcardHost(input)).toBe(expected);
  });
});

describe('HostResolver.isNonLoopbackHost', () => {
  it('returns true for 0.0.0.0 (wildcard)', () => {
    expect(HostResolver.isNonLoopbackHost('0.0.0.0')).toBe(true);
  });

  it('returns true for :: (wildcard)', () => {
    expect(HostResolver.isNonLoopbackHost('::')).toBe(true);
  });

  it('returns true for 192.168.1.10', () => {
    expect(HostResolver.isNonLoopbackHost('192.168.1.10')).toBe(true);
  });

  it('returns true for devbox.local', () => {
    expect(HostResolver.isNonLoopbackHost('devbox.local')).toBe(true);
  });

  it('returns false for ::1 (loopback)', () => {
    expect(HostResolver.isNonLoopbackHost('::1')).toBe(false);
  });

  it('returns false for 127.0.0.1', () => {
    expect(HostResolver.isNonLoopbackHost('127.0.0.1')).toBe(false);
  });

  it('returns false for localhost', () => {
    expect(HostResolver.isNonLoopbackHost('localhost')).toBe(false);
  });

  it('returns false for Localhost (case-insensitive)', () => {
    expect(HostResolver.isNonLoopbackHost('Localhost')).toBe(false);
  });
});

describe('HostResolver.connectableHost', () => {
  it.each([
    ['0.0.0.0', '127.0.0.1'],
    ['::', '::1'],
    ['[::]', '::1'],
    ['', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.10', '192.168.1.10'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['[fe80::1]', 'fe80::1'],
    ['localhost', 'localhost'],
  ])('connectableHost(%s) = %s', (input, expected) => {
    expect(HostResolver.connectableHost(input)).toBe(expected);
  });
});

describe('HostResolver.formatHostForUrl', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.10', '192.168.1.10'],
    ['localhost', 'localhost'],
    ['::1', '[::1]'],
    ['fe80::1', '[fe80::1]'],
    ['[::1]', '[::1]'],
  ])('formatHostForUrl(%s) = %s', (input, expected) => {
    expect(HostResolver.formatHostForUrl(input)).toBe(expected);
  });
});

describe('HostResolver.buildInternalBaseUrl', () => {
  it.each([
    [{ host: '0.0.0.0', port: 3000 }, 'http://127.0.0.1:3000'],
    [{ host: '::', port: 3000 }, 'http://[::1]:3000'],
    [{ host: '192.168.1.10', port: 3000 }, 'http://192.168.1.10:3000'],
    [{ host: '2001:db8::1', port: 8080 }, 'http://[2001:db8::1]:8080'],
    [{ host: '127.0.0.1', port: 4000 }, 'http://127.0.0.1:4000'],
    [{ host: 'fe80::1', port: 3000 }, 'http://[fe80::1]:3000'],
    [{ host: '[::]', port: 4000 }, 'http://[::1]:4000'],
  ])('buildInternalBaseUrl(%j) = %s', (config, expected) => {
    expect(HostResolver.buildInternalBaseUrl(config)).toBe(expected);
  });
});

describe('HostResolver.buildDisplayUrls', () => {
  it('wildcard returns loopback primary', () => {
    expect(HostResolver.buildDisplayUrls({ host: '0.0.0.0', port: 3000 }).primary).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('concrete returns concrete primary', () => {
    expect(HostResolver.buildDisplayUrls({ host: '192.168.1.10', port: 3000 }).primary).toBe(
      'http://192.168.1.10:3000',
    );
  });

  it('returns object shape', () => {
    const result = HostResolver.buildDisplayUrls({ host: '127.0.0.1', port: 3000 });
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('primary');
  });

  it('IPv6 concrete display brackets the host', () => {
    const { primary } = HostResolver.buildDisplayUrls({ host: '2001:db8::1', port: 8080 });
    expect(primary).toBe('http://[2001:db8::1]:8080');
  });
});

describe('regression: no wildcard leaks in generated URLs', () => {
  function assertNoWildcardInUrl(url: string): void {
    expect(url).not.toContain('0.0.0.0');
    const bareColonColon = url.replace(/\[[^\]]*\]/g, '');
    expect(bareColonColon).not.toContain('::');
  }

  const wildcardHosts = ['0.0.0.0', '::', '[::]'];
  const ports = [3000, 8080, 443];

  describe('buildInternalBaseUrl rejects wildcards', () => {
    for (const host of wildcardHosts) {
      for (const port of ports) {
        it(`buildInternalBaseUrl({host:'${host}', port:${port}}) has no wildcard`, () => {
          const url = HostResolver.buildInternalBaseUrl({ host, port });
          assertNoWildcardInUrl(url);
          expect(() => new URL(url)).not.toThrow();
        });
      }
    }
  });

  describe('buildDisplayUrls.primary rejects wildcards', () => {
    for (const host of wildcardHosts) {
      for (const port of ports) {
        it(`buildDisplayUrls({host:'${host}', port:${port}}).primary has no wildcard`, () => {
          const { primary } = HostResolver.buildDisplayUrls({ host, port });
          assertNoWildcardInUrl(primary);
          expect(() => new URL(primary)).not.toThrow();
        });
      }
    }
  });

  describe('all hosts produce parseable URLs', () => {
    const allHosts = [
      '127.0.0.1',
      '0.0.0.0',
      '::',
      '::1',
      '192.168.1.10',
      '2001:db8::1',
      'devbox.local',
    ];
    for (const host of allHosts) {
      it(`buildInternalBaseUrl({host:'${host}', port:3000}) is a valid URL`, () => {
        const url = HostResolver.buildInternalBaseUrl({ host, port: 3000 });
        const parsed = new URL(url);
        expect(parsed.hostname).not.toBe('0.0.0.0');
        expect(parsed.hostname).not.toBe('::');
      });
    }
  });

  it('snapshot: wildcard IPv4 resolves to loopback', () => {
    expect(HostResolver.buildInternalBaseUrl({ host: '0.0.0.0', port: 3000 })).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('snapshot: wildcard IPv6 resolves to loopback', () => {
    expect(HostResolver.buildInternalBaseUrl({ host: '::', port: 3000 })).toBe(
      'http://[::1]:3000',
    );
  });
});
