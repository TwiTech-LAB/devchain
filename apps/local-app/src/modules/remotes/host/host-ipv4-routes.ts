import { readFile } from 'node:fs/promises';
import { AppError } from '../../../common/errors/error-types';

export const HOST_IPV4_ROUTES = Symbol('HOST_IPV4_ROUTES');
export type HostIPv4RouteReader = (signal?: AbortSignal) => Promise<string[]>;

export function onLinkIPv4Routes(table: string): string[] {
  const routes = new Set<string>();
  for (const line of table.trim().split('\n')) {
    const [, destination, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (
      ![destination, gateway, mask].every((field) => /^[\da-f]{8}$/i.test(field ?? '')) ||
      !/^[\da-f]+$/i.test(flags ?? '')
    )
      continue;
    // Classify before reducing to a CIDR: VPN gateway routes can look like connected ranges.
    if (Number.parseInt(gateway, 16) !== 0 || (Number.parseInt(flags, 16) & 0x2) !== 0) continue;
    const address = routeWord(destination);
    const netmask = routeWord(mask);
    if (address === 0 && netmask === 0) continue;
    const prefix = Math.clz32(~netmask);
    if (netmask !== (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)) continue;
    const network = (address & netmask) >>> 0;
    const octets = [24, 16, 8, 0].map((shift) => (network >>> shift) & 0xff);
    routes.add(`${octets.join('.')}/${prefix}`);
  }
  return [...routes];
}

// /proc/net/route stores IPv4 words as little-endian hexadecimal bytes.
function routeWord(hex: string): number {
  return Number.parseInt(hex.match(/../g)!.reverse().join(''), 16);
}

export const readHostIPv4Routes: HostIPv4RouteReader = async (signal) => {
  try {
    return onLinkIPv4Routes(await readFile('/proc/net/route', { encoding: 'utf8', signal }));
  } catch {
    signal?.throwIfAborted();
    throw new AppError(
      'VM on-link IPv4 routes could not be read.',
      'DOCKER_IPV4_ROUTES_UNAVAILABLE',
      502,
    );
  }
};
