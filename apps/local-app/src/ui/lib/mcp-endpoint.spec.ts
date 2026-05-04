import { getMcpEndpointUrl } from './mcp-endpoint';

function mockWindowLocation(overrides: Partial<Location>) {
  const original = window.location;
  Object.defineProperty(window, 'location', {
    value: { ...original, ...overrides },
    writable: true,
    configurable: true,
  });
  return () => {
    Object.defineProperty(window, 'location', {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

// Location.hostname returns the bracketed form for IPv6 per WHATWG URL Standard
// (e.g. "[::1]", "[2001:db8::1]"). The helper accepts both bracketed (real browser)
// and unbracketed (test/helper) shapes intentionally.
describe('getMcpEndpointUrl', () => {
  it('uses window.location.hostname for concrete IPv4', () => {
    const restore = mockWindowLocation({
      hostname: '192.168.1.10',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://192.168.1.10:3000/mcp');
    restore();
  });

  it('uses localhost when hostname is localhost', () => {
    const restore = mockWindowLocation({
      hostname: 'localhost',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://localhost:3000/mcp');
    restore();
  });

  it('falls back to 127.0.0.1 when hostname is empty', () => {
    const restore = mockWindowLocation({
      hostname: '',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://127.0.0.1:3000/mcp');
    restore();
  });

  it('falls back to 127.0.0.1 when hostname is 0.0.0.0', () => {
    const restore = mockWindowLocation({
      hostname: '0.0.0.0',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://127.0.0.1:3000/mcp');
    restore();
  });

  it('falls back to 127.0.0.1 when hostname is ::', () => {
    const restore = mockWindowLocation({
      hostname: '::',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://127.0.0.1:3000/mcp');
    restore();
  });

  it('bracket-wraps IPv6 hostname', () => {
    const restore = mockWindowLocation({
      hostname: '::1',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://[::1]:3000/mcp');
    restore();
  });

  it('bracket-wraps full IPv6 hostname', () => {
    const restore = mockWindowLocation({
      hostname: '2001:db8::1',
      port: '3000',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://[2001:db8::1]:3000/mcp');
    restore();
  });

  it('passes through already-bracketed IPv6 loopback [::1] (browser shape)', () => {
    const restore = mockWindowLocation({
      hostname: '[::1]',
      port: '3000',
      protocol: 'http:',
    });
    const url = getMcpEndpointUrl();
    expect(url).toBe('http://[::1]:3000/mcp');
    expect(url).not.toContain('[[');
    expect(() => new URL(url)).not.toThrow();
    restore();
  });

  it('passes through already-bracketed full IPv6 [2001:db8::1] (browser shape)', () => {
    const restore = mockWindowLocation({
      hostname: '[2001:db8::1]',
      port: '3000',
      protocol: 'http:',
    });
    const url = getMcpEndpointUrl();
    expect(url).toBe('http://[2001:db8::1]:3000/mcp');
    expect(url).not.toContain('[[');
    expect(() => new URL(url)).not.toThrow();
    restore();
  });

  it('falls back to 127.0.0.1 for already-bracketed wildcard [::] (browser shape)', () => {
    const restore = mockWindowLocation({
      hostname: '[::]',
      port: '3000',
      protocol: 'http:',
    });
    const url = getMcpEndpointUrl();
    expect(url).toBe('http://127.0.0.1:3000/mcp');
    expect(() => new URL(url)).not.toThrow();
    restore();
  });

  it('remaps Vite dev port 5175 to API port 3000', () => {
    const restore = mockWindowLocation({
      hostname: 'localhost',
      port: '5175',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://localhost:3000/mcp');
    restore();
  });

  it('uses https when window.location.protocol is https:', () => {
    const restore = mockWindowLocation({
      hostname: '192.168.1.10',
      port: '3000',
      protocol: 'https:',
    });
    expect(getMcpEndpointUrl()).toBe('https://192.168.1.10:3000/mcp');
    restore();
  });

  it('accepts explicit apiPort override', () => {
    const restore = mockWindowLocation({
      hostname: '192.168.1.10',
      port: '5175',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl(8080)).toBe('http://192.168.1.10:8080/mcp');
    restore();
  });

  it('defaults port to 3000 when window.location.port is empty', () => {
    const restore = mockWindowLocation({
      hostname: 'example.local',
      port: '',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl()).toBe('http://example.local:3000/mcp');
    restore();
  });

  describe('regression: no wildcard leaks in MCP URL', () => {
    function assertNoWildcardInUrl(url: string): void {
      expect(url).not.toContain('0.0.0.0');
      const bareColonColon = url.replace(/\[[^\]]*\]/g, '');
      expect(bareColonColon).not.toContain('::');
    }

    it.each(['0.0.0.0', '::', ''])('hostname=%s never leaks wildcard into MCP URL', (hostname) => {
      const restore = mockWindowLocation({ hostname, port: '3000', protocol: 'http:' });
      const url = getMcpEndpointUrl();
      assertNoWildcardInUrl(url);
      expect(() => new URL(url)).not.toThrow();
      restore();
    });

    it.each(['127.0.0.1', '192.168.1.10', 'localhost', '::1', '2001:db8::1', 'devbox.local'])(
      'hostname=%s produces a valid URL with non-wildcard host',
      (hostname) => {
        const restore = mockWindowLocation({ hostname, port: '3000', protocol: 'http:' });
        const url = getMcpEndpointUrl();
        const parsed = new URL(url);
        expect(parsed.hostname).not.toBe('0.0.0.0');
        expect(parsed.hostname).not.toBe('::');
        restore();
      },
    );
  });
});
