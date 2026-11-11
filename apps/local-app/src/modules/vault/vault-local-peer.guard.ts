import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isLoopbackHost, normalizeHost } from '../../common/config/integration-admission';
import { ForbiddenError } from '../../common/errors/error-types';

/**
 * A peer on this machine: a loopback address, or the socket's own local address. The
 * second case is `devchain start --host <NIC IP>`, which has no loopback listener, so a
 * process on this machine reaches DevChain from the NIC IP. Uses the socket only, never
 * forwarded headers.
 */
export function isLocalPeer(socket: { remoteAddress?: string; localAddress?: string }): boolean {
  const remote = socket.remoteAddress;
  if (!remote) return false;
  if (isLoopbackHost(remote)) return true;
  return socket.localAddress !== undefined && unmapped(remote) === unmapped(socket.localAddress);
}

function unmapped(address: string): string {
  return normalizeHost(address).replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/, '');
}

/** Admits only processes on this machine; a valid host API key does not widen it. */
@Injectable()
export class VaultLocalPeerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (isLocalPeer(request.raw.socket)) return true;
    throw new ForbiddenError('Vault values are available only to processes on this machine.', {
      code: 'VAULT_PEER_REFUSED',
    });
  }
}
