import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { installTlsFront } from '../../modules/remotes/host/host-tls-front';

/** The only name in the fixture certificates. */
export const FIXTURE_TLS_NAME = 'devchain-host';

/**
 * Makes two unrelated test-only EC P-256 pairs with the openssl command the host
 * bootstrap uses (apps/host-bootstrap/lib/tls.js), so no private key is committed.
 * The pairs are cached per OS user in the temp directory; the host-bootstrap tests
 * use the same cache. Concurrent test workers race safely: each builds in its own
 * staging directory, and the first rename wins.
 */
function testTlsRoot(): string {
  const root = join(tmpdir(), `devchain-test-tls-${process.getuid?.() ?? 'user'}-v1`);
  const complete = () => existsSync(join(root, 'tls-other', 'cert.pem'));
  if (complete()) return root;
  const staging = mkdtempSync(`${root}.tmp-`);
  try {
    for (const pair of ['tls', 'tls-other']) {
      mkdirSync(join(staging, pair));
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-sha256',
          '-days',
          '3650',
          '-subj',
          `/CN=${FIXTURE_TLS_NAME}`,
          '-addext',
          `subjectAltName=DNS:${FIXTURE_TLS_NAME}`,
          '-keyout',
          join(staging, pair, 'key.pem'),
          '-out',
          join(staging, pair, 'cert.pem'),
        ],
        { stdio: 'ignore' },
      );
    }
    renameSync(staging, root);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!complete()) throw error;
  }
  return root;
}

const TLS_ROOT = testTlsRoot();

/** Test-only VM certificate pairs, shared with the bootstrap tests. */
export const FIXTURE_TLS_DIR = join(TLS_ROOT, 'tls');
/** The directory of a second, unrelated pair. */
export const OTHER_TLS_DIR = join(TLS_ROOT, 'tls-other');

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
