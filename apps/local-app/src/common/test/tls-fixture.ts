import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { installTlsFront } from '../../modules/remotes/host/host-tls-front';

/** Test-only VM certificate pairs, shared with the bootstrap tests. */
export const FIXTURE_TLS_DIR = join(__dirname, '../../../../host-bootstrap/test/fixtures/tls');
const OTHER_TLS_DIR = join(__dirname, '../../../../host-bootstrap/test/fixtures/tls-other');

/** The only name in the fixture certificates. */
export const FIXTURE_TLS_NAME = 'devchain-host';

export const fixtureTls = {
  key: readFileSync(join(FIXTURE_TLS_DIR, 'key.pem'), 'utf8'),
  cert: readFileSync(join(FIXTURE_TLS_DIR, 'cert.pem'), 'utf8'),
};

/** A second, unrelated pair: a VM that is not the one home pinned. */
export const otherTls = {
  key: readFileSync(join(OTHER_TLS_DIR, 'key.pem'), 'utf8'),
  cert: readFileSync(join(OTHER_TLS_DIR, 'cert.pem'), 'utf8'),
};

/**
 * Puts the host TLS front on a test app's or server's HTTP server before it
 * listens: TLS with the fixture certificate from any peer, plaintext from
 * loopback. Reach it as `https://127.0.0.1:<port>` pinned to `fixtureTls.cert`.
 */
export function installFixtureTlsFront(target: Server | { getHttpServer(): Server }): void {
  const server = 'getHttpServer' in target ? target.getHttpServer() : target;
  installTlsFront(server, {
    secureContext: createSecureContext({ key: fixtureTls.key, cert: fixtureTls.cert }),
  });
}
