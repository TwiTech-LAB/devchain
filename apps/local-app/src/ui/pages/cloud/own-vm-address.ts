import type { ProbeResultDto } from '@/modules/remotes/dtos/remote-probe.dto';
import { normalizeRemoteBaseUrl } from '@/modules/remotes/dtos/remote.dto';
import { HOST_INSTALL_BOOTSTRAP_PORT } from '@/modules/remotes/host-install/host-install-block';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

/** The pause between one installer check's answer and the next check. */
export const INSTALLER_POLL_MS = 5_000;

/** `host`, `host:port` or a URL, as the origin it names; null when it names none. */
export function addressOrigin(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  return normalizeRemoteBaseUrl(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
}

/** The host of an address, IPv6 in brackets; null when the address is not valid. */
export function addressHost(address: string): string | null {
  const origin = addressOrigin(address);
  return origin ? new URL(origin).hostname : null;
}

/**
 * Where the installer answers on the address's host. Its systemd unit pins
 * the port, whatever port the user typed.
 */
export function installerUrl(address: string): string | null {
  const host = addressHost(address);
  return host ? `https://${host}:${HOST_INSTALL_BOOTSTRAP_PORT}` : null;
}

/** An origin as `host` or `host:port`, IPv6 in brackets. */
export function hostPort(origin: string): string {
  const url = new URL(origin);
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/** Lists `parts` as "a, b, or c", or "a or b". */
function orList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

/** What a "nothing" answer means, in one or two sentences. */
export function nothingSentence(result: Extract<ProbeResultDto, { kind: 'nothing' }>): string {
  const places = result.tried.map((origin) => `at ${hostPort(origin)}`);
  if (result.sshReachable === false) {
    return `Nothing answers ${orList([...places, 'on SSH port 22'])}. Check the address and the firewall.`;
  }
  return `No DevChain and no installer answers ${orList(places)}.`;
}

function isProbeResult(body: unknown): body is ProbeResultDto {
  if (typeof body !== 'object' || body === null) return false;
  const result = body as Record<string, unknown>;
  switch (result.kind) {
    case 'devchain':
      return typeof result.baseUrl === 'string' && typeof result.versionMatches === 'boolean';
    case 'installer':
      return (
        typeof result.bootstrapUrl === 'string' &&
        typeof result.state === 'string' &&
        typeof result.supported === 'boolean'
      );
    case 'nothing':
      return Array.isArray(result.tried);
    default:
      return false;
  }
}

/** Asks this PC what answers at an address. It creates nothing. */
export async function probeAddress(
  address: string,
  options: { checkSsh: boolean; signal?: AbortSignal },
): Promise<ProbeResultDto> {
  const response = await apiFetch(
    '/api/remotes/probe',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, checkSsh: options.checkSsh }),
      signal: options.signal,
    },
    { backend: HOME_BACKEND },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message = (body as { message?: unknown } | null)?.message;
    throw new Error(typeof message === 'string' ? message : 'The address check failed.');
  }
  if (!isProbeResult(body)) throw new Error('The address check returned an unknown answer.');
  return body;
}
