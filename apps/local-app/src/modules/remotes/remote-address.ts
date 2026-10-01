import { ConflictError } from '../../common/errors/error-types';
import type { Remote } from '../storage/models/domain.models';

export function requireRemoteAddress(remote: Pick<Remote, 'id' | 'baseUrl'>): string {
  if (!remote.baseUrl) {
    throw new ConflictError('The remote is still provisioning and has no address.', {
      code: 'REMOTE_PROVISIONING',
      remoteId: remote.id,
    });
  }
  return remote.baseUrl;
}

/** A URL host name without the brackets of an IPv6 literal. */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
