import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { normalizeCertificate } from '../../../common/tls/certificate';
import { vmTlsTarget } from './remote-tls';

const DISCOVERY_PATH = '/api/runtime';
const MAX_BODY_BYTES = 64 * 1024;

export interface DiscoveryAnswer {
  status: number;
  /** The parsed JSON body, or null when it is not JSON. */
  body: unknown;
  /** The certificate the peer showed, as PEM. Nothing vouches for it. */
  certificate: string;
}

/**
 * `GET /api/runtime` at `origin` without trusting the peer: no certificate
 * check, no `Authorization`, no body, no redirect. The answer only chooses
 * the next setup step; the certificate becomes trusted only after the user
 * or a trusted channel confirms it.
 */
export function discoverRuntime(origin: string, timeoutMs: number): Promise<DiscoveryAnswer> {
  const url = new URL(origin);
  if (url.protocol !== 'https:') {
    return Promise.reject(new TypeError('A VM is reached over https only'));
  }
  const target = vmTlsTarget(url.hostname, url.port);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.host,
        port: target.port,
        path: DISCOVERY_PATH,
        method: 'GET',
        headers: { accept: 'application/json' },
        agent: false,
        // Discovery reads the certificate the peer shows; it must not refuse it.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        const peer = (res.socket as TLSSocket).getPeerCertificate();
        if (!peer?.raw) {
          res.destroy();
          reject(new Error('The peer showed no certificate'));
          return;
        }
        const certificate = normalizeCertificate(peer.raw);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.destroy(new Error('The runtime answer is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body, certificate });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The runtime check timed out')));
    req.on('error', reject);
    req.end();
  });
}
