import { getMcpEndpointUrl as buildMcpEndpointUrl } from './mcp-endpoint';

type EndpointLocation = Pick<Location, 'hostname' | 'port' | 'protocol'>;

let locationOverride: EndpointLocation = window.location;

function getMcpEndpointUrl(apiPort?: number): string {
  return buildMcpEndpointUrl(apiPort, locationOverride);
}

function mockWindowLocation(overrides: Partial<Location>) {
  const original = locationOverride;
  locationOverride = { ...locationOverride, ...overrides };
  return () => {
    locationOverride = original;
  };
}

// Location.hostname returns the bracketed form for IPv6 per WHATWG URL Standard
// (e.g. "[::1]", "[2001:db8::1]"). The helper accepts both bracketed (real browser)
// and unbracketed (test/helper) shapes intentionally.
describe('getMcpEndpointUrl', () => {
  it.each([
    {
      label: 'uses window.location.hostname for concrete IPv4',
      hostname: '192.168.1.10',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://192.168.1.10:3000/mcp',
    },
    {
      label: 'uses localhost when hostname is localhost',
      hostname: 'localhost',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://localhost:3000/mcp',
    },
    {
      label: 'falls back to 127.0.0.1 when hostname is empty',
      hostname: '',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://127.0.0.1:3000/mcp',
    },
    {
      label: 'falls back to 127.0.0.1 when hostname is 0.0.0.0',
      hostname: '0.0.0.0',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://127.0.0.1:3000/mcp',
    },
    {
      label: 'falls back to 127.0.0.1 when hostname is ::',
      hostname: '::',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://127.0.0.1:3000/mcp',
    },
    {
      label: 'bracket-wraps IPv6 hostname',
      hostname: '::1',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://[::1]:3000/mcp',
    },
    {
      label: 'bracket-wraps full IPv6 hostname',
      hostname: '2001:db8::1',
      port: '3000',
      protocol: 'http:',
      expectedUrl: 'http://[2001:db8::1]:3000/mcp',
    },
    {
      label: 'remaps Vite dev port 5175 to API port 3000',
      hostname: 'localhost',
      port: '5175',
      protocol: 'http:',
      expectedUrl: 'http://localhost:3000/mcp',
    },
    {
      label: 'uses https when window.location.protocol is https:',
      hostname: '192.168.1.10',
      port: '3000',
      protocol: 'https:',
      expectedUrl: 'https://192.168.1.10:3000/mcp',
    },
    {
      label: 'defaults port to 3000 when window.location.port is empty',
      hostname: 'example.local',
      port: '',
      protocol: 'http:',
      expectedUrl: 'http://example.local:3000/mcp',
    },
  ] as const)('$label', ({ hostname, port, protocol, expectedUrl }) => {
    const restore = mockWindowLocation({
      hostname: hostname,
      port: port,
      protocol: protocol,
    });
    expect(getMcpEndpointUrl()).toBe(expectedUrl);
    restore();
  });

  it.each([
    {
      label: 'passes through already-bracketed IPv6 loopback [::1] (browser shape)',
      hostname: '[::1]',
      expectedUrl: 'http://[::1]:3000/mcp',
    },
    {
      label: 'passes through already-bracketed full IPv6 [2001:db8::1] (browser shape)',
      hostname: '[2001:db8::1]',
      expectedUrl: 'http://[2001:db8::1]:3000/mcp',
    },
  ] as const)('$label', ({ hostname, expectedUrl }) => {
    const restore = mockWindowLocation({
      hostname: hostname,
      port: '3000',
      protocol: 'http:',
    });
    const url = getMcpEndpointUrl();
    expect(url).toBe(expectedUrl);
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

  it('accepts explicit apiPort override', () => {
    const restore = mockWindowLocation({
      hostname: '192.168.1.10',
      port: '5175',
      protocol: 'http:',
    });
    expect(getMcpEndpointUrl(8080)).toBe('http://192.168.1.10:8080/mcp');
    restore();
  });
});
