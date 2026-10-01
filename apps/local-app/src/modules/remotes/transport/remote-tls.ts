import type { PeerCertificate } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { ConflictError } from '../../../common/errors/error-types';
import { certificateFingerprint, fingerprintHex } from '../../../common/tls/certificate';
import type { Remote } from '../../storage/models/domain.models';
import { requireRemoteAddress, stripIpv6Brackets } from '../remote-address';

/**
 * Home's only TLS client settings for a VM. The VM certificate is self-signed
 * and names no IP address, so the connection trusts exactly that certificate
 * (`ca`) and checks its SHA-256 fingerprint in place of the host name.
 */

export const REMOTE_TLS_CERTIFICATE_MISSING = 'REMOTE_TLS_CERTIFICATE_MISSING';

export class RemoteCertificateMismatchError extends Error {
  readonly code = 'ERR_TLS_CERT_FINGERPRINT_MISMATCH';
  constructor() {
    super('The VM showed a certificate other than the one this PC trusts');
  }
}

/** TLS options that trust one VM certificate and nothing else. */
export interface PinnedTlsOptions {
  readonly ca: string[];
  readonly rejectUnauthorized: true;
  readonly checkServerIdentity: (hostname: string, cert: PeerCertificate) => Error | undefined;
}

export function pinnedTlsOptions(certificatePem: string): PinnedTlsOptions {
  const fingerprint = certificateFingerprint(certificatePem);
  return Object.freeze({
    ca: [certificatePem],
    rejectUnauthorized: true as const,
    // Node calls this only after the chain check passed, which `ca` limits to
    // this certificate; the fingerprint replaces the host name check.
    checkServerIdentity: (_hostname: string, cert: PeerCertificate) =>
      cert.fingerprint256 && fingerprintHex(cert.fingerprint256) === fingerprint
        ? undefined
        : new RemoteCertificateMismatchError(),
  });
}

/** The TLS dial target of a VM origin: IPv6 brackets removed, the https default port filled in. */
export function vmTlsTarget(
  host: string,
  port: string | number | undefined | null,
): { host: string; port: number } {
  return {
    host: stripIpv6Brackets(host),
    port: port === undefined || port === null || port === '' ? 443 : Number(port),
  };
}

/** One pool per certificate, so no TLS session crosses from one certificate to another. */
const MAX_AGENTS = 64;
const agents = new Map<string, Agent>();

function agentFor(certificatePem: string): Agent {
  const fingerprint = certificateFingerprint(certificatePem);
  const existing = agents.get(fingerprint);
  if (existing) {
    agents.delete(fingerprint);
    agents.set(fingerprint, existing);
    return existing;
  }
  const agent = new Agent({ connect: { ...pinnedTlsOptions(certificatePem) } });
  agents.set(fingerprint, agent);
  if (agents.size > MAX_AGENTS) {
    const [oldest, stale] = agents.entries().next().value as [string, Agent];
    agents.delete(oldest);
    void stale.close().catch(() => undefined);
  }
  return agent;
}

export type RemoteFetchInit = Omit<RequestInit, 'redirect' | 'dispatcher'> & { duplex?: 'half' };

/**
 * `fetch` to a VM over HTTPS pinned to `certificatePem`. The TLS handshake,
 * including the pin, completes before any header or body is sent. Redirects
 * fail the call.
 */
export async function remoteFetch(
  url: string,
  init: RemoteFetchInit,
  certificatePem: string,
): Promise<Response> {
  if (new URL(url).protocol !== 'https:') {
    throw new TypeError('A VM is reached over https only');
  }
  const response = await undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    redirect: 'error',
    dispatcher: agentFor(certificatePem),
  });
  return response as unknown as Response;
}

/** The address and certificate a direct VM call needs; refuses a remote without either. */
export function requireRemoteTls(
  remote: Pick<Remote, 'id' | 'name' | 'baseUrl' | 'tlsCertificate'>,
): { baseUrl: string; certificate: string } {
  return { baseUrl: requireRemoteAddress(remote), certificate: requireRemoteCertificate(remote) };
}

export function requireRemoteCertificate(
  remote: Pick<Remote, 'id' | 'name' | 'tlsCertificate'>,
): string {
  if (!remote.tlsCertificate) {
    throw new ConflictError(
      `This PC has no certificate for the VM "${remote.name}", so it cannot reach it securely. Add the VM again or reset it.`,
      { code: REMOTE_TLS_CERTIFICATE_MISSING, remoteId: remote.id },
    );
  }
  return remote.tlsCertificate;
}
