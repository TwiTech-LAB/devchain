const VITE_DEV_PORT = '5175';
const DEFAULT_API_PORT = 3000;

function resolveApiPort(): number {
  if (typeof window === 'undefined') return DEFAULT_API_PORT;
  const port = window.location.port;
  if (port === VITE_DEV_PORT) return DEFAULT_API_PORT;
  return port ? parseInt(port, 10) : DEFAULT_API_PORT;
}

export function getMcpEndpointUrl(apiPort?: number): string {
  const port = apiPort ?? resolveApiPort();

  let hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  const isBracketed = hostname.startsWith('[') && hostname.endsWith(']');
  const inner = isBracketed ? hostname.slice(1, -1) : hostname;

  if (!inner || inner === '0.0.0.0' || inner === '::') {
    hostname = '127.0.0.1';
  } else if (inner.includes(':')) {
    hostname = `[${inner}]`;
  } else {
    hostname = inner;
  }

  const protocol =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';

  return `${protocol}://${hostname}:${port}/mcp`;
}
