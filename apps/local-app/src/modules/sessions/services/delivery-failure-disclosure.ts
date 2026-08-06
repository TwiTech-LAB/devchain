import type { DeliveryFailureCode, FailureDisclosurePolicy } from './message-pool.types';

export const PROJECT_SAFE_DELIVERY_ERROR = 'DELIVERY_FAILED';

interface FailureDisclosureCarrier {
  readonly failureDisclosure?: FailureDisclosurePolicy;
}

export function getStrictestFailureDisclosure(
  values: readonly FailureDisclosureCarrier[],
): FailureDisclosurePolicy {
  return values.some((value) => value.failureDisclosure === 'project-safe')
    ? 'project-safe'
    : 'legacy';
}

export function discloseFailureReason(
  policy: FailureDisclosurePolicy | undefined,
  legacyReason: string,
): string {
  return policy === 'project-safe' ? PROJECT_SAFE_DELIVERY_ERROR : legacyReason;
}

export function classifyDeliveryFailure(
  policy: FailureDisclosurePolicy | undefined,
  legacyError: string,
  legacyFailureCode: DeliveryFailureCode,
): { error: string; failureCode: DeliveryFailureCode } {
  if (policy === 'project-safe') {
    return {
      error: PROJECT_SAFE_DELIVERY_ERROR,
      failureCode: 'project_delivery_failed',
    };
  }

  return { error: legacyError, failureCode: legacyFailureCode };
}
