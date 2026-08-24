import { AppError } from '../../../common/errors/error-types';
import type { IntegrationProvider } from '../../storage/models/domain.models';
import type { SafeVendorHttpError } from '../transport/safe-vendor-http-client';

export type ExternalProviderFailureReason =
  | 'authentication_failed'
  | 'permission_denied'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_response'
  | 'request_rejected'
  | 'unsupported_transition'
  | 'unsupported_subtask_type'
  | 'ownership_mismatch'
  | 'parent_mismatch'
  | 'time_tracking_disabled'
  | 'unavailable';

const STATUS_BY_REASON: Record<ExternalProviderFailureReason, number> = {
  authentication_failed: 400,
  permission_denied: 403,
  not_found: 404,
  rate_limited: 429,
  timeout: 504,
  invalid_response: 502,
  request_rejected: 400,
  unsupported_transition: 400,
  unsupported_subtask_type: 422,
  ownership_mismatch: 409,
  parent_mismatch: 409,
  time_tracking_disabled: 400,
  unavailable: 502,
};

const RETRYABLE_REASONS = new Set<ExternalProviderFailureReason>([
  'rate_limited',
  'timeout',
  'unavailable',
]);

function providerLabel(provider: IntegrationProvider): string {
  return provider === 'clickup' ? 'ClickUp' : 'Jira';
}

export class ExternalProviderError extends AppError {
  constructor(
    provider: IntegrationProvider,
    reason: ExternalProviderFailureReason,
    guidance: {
      retryAt?: string;
      possibleCauses?: string[];
      guidance?: 'complete_in_jira' | 'enable_time_tracking_in_jira';
      completeInJiraUrl?: string;
      /** True when the failed request had already been dispatched. */
      dispatched?: boolean;
    } = {},
  ) {
    super(
      `${providerLabel(provider)} integration request failed`,
      `${provider}_${reason}`,
      STATUS_BY_REASON[reason],
      {
        provider,
        reason,
        retryable: RETRYABLE_REASONS.has(reason),
        ...(guidance.dispatched === true ? { dispatched: true } : {}),
        ...(guidance.retryAt ? { retryAt: guidance.retryAt } : {}),
        ...(guidance.possibleCauses ? { possibleCauses: guidance.possibleCauses } : {}),
        ...(guidance.guidance ? { guidance: guidance.guidance } : {}),
        ...(guidance.completeInJiraUrl ? { completeInJiraUrl: guidance.completeInJiraUrl } : {}),
      },
    );
  }
}

export class ClickUpProviderError extends ExternalProviderError {
  constructor(reason: ExternalProviderFailureReason, retryAt?: string, dispatched = false) {
    super('clickup', reason, { retryAt, ...(dispatched ? { dispatched: true } : {}) });
  }
}

export class JiraProviderError extends ExternalProviderError {
  constructor(
    reason: ExternalProviderFailureReason,
    retryAt?: string,
    guidance: { completeInJiraUrl?: string; dispatched?: boolean } = {},
  ) {
    super('jira', reason, {
      ...(guidance.dispatched === true ? { dispatched: true } : {}),
      ...(retryAt ? { retryAt } : {}),
      ...(reason === 'authentication_failed'
        ? { possibleCauses: ['bad_email', 'bad_token', 'scoped_token_unsupported'] }
        : {}),
      ...(reason === 'unsupported_transition'
        ? {
            guidance: 'complete_in_jira' as const,
            ...(guidance.completeInJiraUrl
              ? { completeInJiraUrl: guidance.completeInJiraUrl }
              : {}),
          }
        : {}),
      ...(reason === 'time_tracking_disabled'
        ? { guidance: 'enable_time_tracking_in_jira' as const }
        : {}),
    });
  }
}

export function mapSafeVendorFailure(error: SafeVendorHttpError): ExternalProviderFailureReason {
  if (error.reason === 'http_error') {
    if (error.upstreamStatus === 401) {
      return 'authentication_failed';
    }
    if (error.upstreamStatus === 403) {
      return 'permission_denied';
    }
    if (error.upstreamStatus === 404) {
      return 'not_found';
    }
    if (error.upstreamStatus === 429) {
      return 'rate_limited';
    }
    if (
      error.upstreamStatus === 400 ||
      error.upstreamStatus === 409 ||
      error.upstreamStatus === 422
    ) {
      return 'request_rejected';
    }
    return 'unavailable';
  }
  if (error.reason === 'timeout') {
    return 'timeout';
  }
  if (error.reason === 'response_too_large' || error.reason === 'invalid_response') {
    return 'invalid_response';
  }
  if (error.reason === 'unsafe_url' || error.reason === 'redirect_rejected') {
    return 'request_rejected';
  }
  return 'unavailable';
}
