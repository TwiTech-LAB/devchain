import {
  isWildcardHost,
  connectableHost,
  formatHostForUrl,
  getRuntimeInternalBaseUrl,
} from './host-helpers';

describe('host-helpers', () => {
  describe('isWildcardHost', () => {
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
      expect(isWildcardHost(input)).toBe(expected);
    });
  });

  describe('connectableHost', () => {
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
      expect(connectableHost(input)).toBe(expected);
    });
  });

  describe('formatHostForUrl', () => {
    it.each([
      ['127.0.0.1', '127.0.0.1'],
      ['192.168.1.10', '192.168.1.10'],
      ['localhost', 'localhost'],
      ['::1', '[::1]'],
      ['fe80::1', '[fe80::1]'],
      ['[::1]', '[::1]'],
    ])('formatHostForUrl(%s) = %s', (input, expected) => {
      expect(formatHostForUrl(input)).toBe(expected);
    });
  });

  describe('getRuntimeInternalBaseUrl', () => {
    it.each([
      [{ HOST: '127.0.0.1', PORT: 3000 }, 'http://127.0.0.1:3000'],
      [{ HOST: '0.0.0.0', PORT: 3000 }, 'http://127.0.0.1:3000'],
      [{ HOST: '::', PORT: 4000 }, 'http://[::1]:4000'],
      [{ HOST: '[::]', PORT: 4000 }, 'http://[::1]:4000'],
      [{ HOST: '192.168.1.10', PORT: 8080 }, 'http://192.168.1.10:8080'],
      [{ HOST: 'fe80::1', PORT: 3000 }, 'http://[fe80::1]:3000'],
    ])('getRuntimeInternalBaseUrl(%j) = %s', (config, expected) => {
      expect(getRuntimeInternalBaseUrl(config)).toBe(expected);
    });
  });

  describe('regression: no wildcard leaks in generated URLs', () => {
    function assertNoWildcardInUrl(url: string): void {
      expect(url).not.toContain('0.0.0.0');
      const bareColonColon = url.replace(/\[[^\]]*\]/g, '');
      expect(bareColonColon).not.toContain('::');
    }

    it.each(['0.0.0.0', '::', '[::]'])(
      'getRuntimeInternalBaseUrl with HOST=%s never contains wildcard',
      (host) => {
        const url = getRuntimeInternalBaseUrl({ HOST: host, PORT: 3000 });
        assertNoWildcardInUrl(url);
        expect(() => new URL(url)).not.toThrow();
      },
    );

    it.each(['127.0.0.1', '0.0.0.0', '::', '::1', '192.168.1.10', '2001:db8::1', 'devbox.local'])(
      'getRuntimeInternalBaseUrl with HOST=%s produces a valid URL with non-wildcard host',
      (host) => {
        const url = getRuntimeInternalBaseUrl({ HOST: host, PORT: 3000 });
        const parsed = new URL(url);
        expect(parsed.hostname).not.toBe('0.0.0.0');
        expect(parsed.hostname).not.toBe('::');
      },
    );

    it('snapshot: wildcard IPv4 resolves to loopback', () => {
      expect(getRuntimeInternalBaseUrl({ HOST: '0.0.0.0', PORT: 3000 })).toBe(
        'http://127.0.0.1:3000',
      );
    });

    it('snapshot: wildcard IPv6 resolves to loopback', () => {
      expect(getRuntimeInternalBaseUrl({ HOST: '::', PORT: 3000 })).toBe('http://[::1]:3000');
    });
  });
});
