import { getEnvConfig, type EnvConfig } from '../../../common/config/env.config';
import { getIntegrationAdmission } from '../../../common/config/integration-admission';
import { isClaimedHost } from '../../remotes/host-api-key';

export const EXTERNAL_TASK_ADMISSION = Symbol('EXTERNAL_TASK_ADMISSION');

/** True when MCP callers may make this instance call ClickUp or Jira. */
export type ExternalTaskAdmission = () => boolean;

/**
 * A loopback-bound app admits integrations. A claimed VM host also does: its
 * VM API key already refuses non-loopback callers that lack the key.
 */
export function externalTaskAdmission(
  env: Pick<EnvConfig, 'HOST' | 'DEVCHAIN_HOST_ETC_DIR'> = getEnvConfig(),
): boolean {
  return getIntegrationAdmission(env).allowed || isClaimedHost(env.DEVCHAIN_HOST_ETC_DIR);
}
