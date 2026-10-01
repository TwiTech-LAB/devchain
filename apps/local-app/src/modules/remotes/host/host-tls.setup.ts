import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createSecureContext, type SecureContext } from 'node:tls';
import { getEnvConfig, type EnvConfig } from '../../../common/config/env.config';
import { createLogger } from '../../../common/logging/logger';
import { isClaimedHost } from '../host-api-key';
import { installTlsFront } from './host-tls-front';

const logger = createLogger('HostTls');

type HostTlsConfig = Pick<
  EnvConfig,
  'DEVCHAIN_HOST_ETC_DIR' | 'DEVCHAIN_HOST_TLS_KEY_FILE' | 'DEVCHAIN_HOST_TLS_CERT_FILE'
>;

export interface HostTls {
  keyFile: string;
  certFile: string;
  secureContext: SecureContext;
}

function readTlsFile(kind: 'key' | 'certificate', file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error(
      `Cannot read the TLS ${kind} ${file} (${(error as NodeJS.ErrnoException).code ?? 'error'}); DevChain does not start without it.`,
    );
  }
}

/**
 * The TLS identity from DEVCHAIN_HOST_TLS_KEY_FILE and DEVCHAIN_HOST_TLS_CERT_FILE,
 * or null when neither is set on a home instance. Throws instead of serving
 * plaintext: on a claimed VM without both files, with one variable only, or
 * with files that are not one key and its certificate.
 */
export function resolveHostTls(config: HostTlsConfig = getEnvConfig()): HostTls | null {
  const keyFile = config.DEVCHAIN_HOST_TLS_KEY_FILE;
  const certFile = config.DEVCHAIN_HOST_TLS_CERT_FILE;
  if (!keyFile && !certFile) {
    if (isClaimedHost(config.DEVCHAIN_HOST_ETC_DIR)) {
      throw new Error(
        'This VM is claimed, but DEVCHAIN_HOST_TLS_KEY_FILE and DEVCHAIN_HOST_TLS_CERT_FILE are not set; DevChain does not serve a claimed VM without TLS.',
      );
    }
    return null;
  }
  if (!keyFile || !certFile) {
    throw new Error(
      'Set both DEVCHAIN_HOST_TLS_KEY_FILE and DEVCHAIN_HOST_TLS_CERT_FILE, or neither.',
    );
  }
  const key = readTlsFile('key', keyFile);
  const cert = readTlsFile('certificate', certFile);
  try {
    return { keyFile, certFile, secureContext: createSecureContext({ key, cert }) };
  } catch (error) {
    throw new Error(
      `The TLS key ${keyFile} and certificate ${certFile} are not a usable pair: ${(error as Error).message}`,
    );
  }
}

/**
 * Puts the host's TLS front on the app's HTTP server when TLS is configured.
 * Call it before `listen`, after any `'connection'` listener that must see
 * the socket the HTTP server gets. Production startup and the two-instance
 * fixture both call it.
 */
export function registerHostTls(app: INestApplication): void {
  const tls = resolveHostTls();
  if (!tls) return;
  installTlsFront(app.getHttpServer(), { secureContext: tls.secureContext });
  logger.info(
    { keyFile: tls.keyFile, certFile: tls.certFile },
    'Host TLS on the app port: TLS from any peer, plaintext from loopback only',
  );
}
