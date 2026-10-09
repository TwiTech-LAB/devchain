import { isIPv4 } from 'net';
import { ForbiddenError } from '../errors/error-types';
import { getEnvConfig, type EnvConfig } from './env.config';

type IntegrationAdmissionConfig = Pick<EnvConfig, 'HOST'>;

export type IntegrationAdmissionReason = 'non_loopback_host';

export type IntegrationAdmission =
  | { allowed: true; reason: null }
  | { allowed: false; reason: IntegrationAdmissionReason };

/** Lowercases a hostname and strips IPv6 brackets and a trailing root dot. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);

  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  if (isIPv4(normalized)) {
    return normalized.startsWith('127.');
  }

  return /^::ffff:127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalized);
}

// External-integration operations are refused unless the app is bound to a loopback
// host. This is the real network boundary; failing closed keeps provider credentials
// and calls off any externally reachable bind.
export function getIntegrationAdmission(
  env: IntegrationAdmissionConfig = getEnvConfig(),
): IntegrationAdmission {
  if (!isLoopbackHost(env.HOST)) {
    return { allowed: false, reason: 'non_loopback_host' };
  }

  return { allowed: true, reason: null };
}

export function assertIntegrationAdmission(env: IntegrationAdmissionConfig = getEnvConfig()): void {
  const admission = getIntegrationAdmission(env);
  if (admission.allowed) {
    return;
  }

  throw new ForbiddenError('Integration operations are unavailable in this runtime', {
    code: 'INTEGRATIONS_UNAVAILABLE',
    reason: admission.reason,
  });
}
