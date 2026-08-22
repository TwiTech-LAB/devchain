import { isIPv4 } from 'net';
import { ForbiddenError } from '../errors/error-types';
import { getEnvConfig, type EnvConfig } from './env.config';

type ContainerScopeConfig = Pick<EnvConfig, 'DEVCHAIN_MODE' | 'CONTAINER_PROJECT_ID'>;
type IntegrationAdmissionConfig = Pick<
  EnvConfig,
  'DEVCHAIN_MODE' | 'CONTAINER_PROJECT_ID' | 'HOST'
>;

export type IntegrationAdmissionReason = 'child_runtime' | 'non_loopback_host';

export type IntegrationAdmission =
  | { allowed: true; reason: null }
  | { allowed: false; reason: IntegrationAdmissionReason };

export function getContainerScopedProjectId(
  env: ContainerScopeConfig = getEnvConfig(),
): string | null {
  if (env.DEVCHAIN_MODE !== 'normal') {
    return null;
  }

  return env.CONTAINER_PROJECT_ID ?? null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  if (isIPv4(normalized)) {
    return normalized.startsWith('127.');
  }

  return /^::ffff:127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalized);
}

export function getIntegrationAdmission(
  env: IntegrationAdmissionConfig = getEnvConfig(),
): IntegrationAdmission {
  if (getContainerScopedProjectId(env)) {
    return { allowed: false, reason: 'child_runtime' };
  }

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
