import { isIP, Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { pinnedTlsOptions, vmTlsTarget } from './remote-tls';

const CONNECT_TIMEOUT_MS = 10_000;

/** The pinned certificate for a VM origin, read when a connection opens; null: unknown origin. */
export type OriginCertificateLookup = (origin: string) => string | null;

/** `host:port` with IPv6 brackets removed and the https default port filled in. */
export function originKey(host: string, port: string | number | undefined | null): string {
  const target = vmTlsTarget(host, port);
  return `${target.host.toLowerCase()}:${target.port}`;
}

/** The origin key of a stored `https://host[:port]` VM address. */
export function originKeyOfUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return originKey(url.hostname, url.port);
}

export class RemoteOriginUnknownError extends Error {
  readonly code = 'REMOTE_TLS_ORIGIN_UNKNOWN';
  constructor(origin: string) {
    super(`No VM certificate is known for ${origin}`);
  }
}

/**
 * A fresh TLS socket pinned to the certificate `lookup` holds for the origin
 * now. It never offers a cached session, so no session crosses certificates.
 * Throws for a non-https target or an origin without a certificate.
 */
function openPinned(
  lookup: OriginCertificateLookup,
  protocol: string,
  host: string,
  port: string | number | undefined,
): TLSSocket {
  if (protocol !== 'https:' && protocol !== 'wss:') {
    throw new TypeError('A VM is reached over https only');
  }
  const origin = originKey(host, port);
  const certificate = lookup(origin);
  if (!certificate) throw new RemoteOriginUnknownError(origin);
  const target = vmTlsTarget(host, port);
  return tlsConnect({
    host: target.host,
    port: target.port,
    // SNI takes host names only; an empty name sends none.
    servername: isIP(target.host) ? '' : target.host,
    ALPNProtocols: ['http/1.1'],
    ...pinnedTlsOptions(certificate),
  });
}

interface UndiciConnectOptions {
  protocol: string;
  hostname: string;
  port: string;
}
type UndiciConnectCallback = (error: Error | null, socket: Socket | null) => void;

/**
 * An undici `connect` function for the `/r` proxy. undici uses a connect
 * function as given, so none of the dispatcher's own TLS defaults apply.
 */
export function pinnedUndiciConnector(
  lookup: OriginCertificateLookup,
): (options: UndiciConnectOptions, callback: UndiciConnectCallback) => void {
  return (options, callback) => {
    let socket: TLSSocket;
    try {
      socket = openPinned(lookup, options.protocol, options.hostname, options.port);
    } catch (error) {
      queueMicrotask(() => callback(error as Error, null));
      return;
    }
    let settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('secureConnect', onSecure);
      socket.off('error', settle);
      if (error) {
        socket.destroy();
        callback(error, null);
      } else {
        callback(null, socket);
      }
    };
    const onSecure = () => settle(null);
    const timer = setTimeout(
      () => settle(new Error('Connecting to the VM timed out')),
      CONNECT_TIMEOUT_MS,
    );
    socket.setNoDelay(true);
    socket.once('secureConnect', onSecure);
    socket.once('error', settle);
  };
}

interface WsConnectionOptions {
  host?: string;
  port?: string | number;
}

/**
 * A `ws` `createConnection` for the `/r` proxy. `ws` skips its own TLS setup
 * for a custom function, so this sets the pin, `ca` and the SNI name itself.
 * It always speaks TLS: a plaintext target fails the handshake. A refused
 * target is a socket that fails at once, which `ws` reports as an error.
 */
export function pinnedWsConnection(
  lookup: OriginCertificateLookup,
): (options: WsConnectionOptions) => Socket {
  return (options) => {
    try {
      return openPinned(lookup, 'wss:', options.host ?? '', options.port);
    } catch (error) {
      const refused = new Socket();
      process.nextTick(() => refused.destroy(error as Error));
      return refused;
    }
  };
}
