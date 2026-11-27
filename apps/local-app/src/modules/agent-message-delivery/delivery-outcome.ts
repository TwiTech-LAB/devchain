import type { DeliveryOutcome, RecipientResult } from './dtos/delivery.types';
import { AGENT_DISABLED_DELIVERY_ERROR } from '../sessions/services/message-pool.types';

export function aggregateDeliveryStatus(
  results: readonly RecipientResult[],
): DeliveryOutcome['status'] {
  if (results.length === 0) return 'delivered';

  const allFailed = results.every((r) => r.status === 'failed');
  if (allFailed) return 'failed';

  const allDelivered = results.every((r) => r.status === 'delivered');
  if (allDelivered) return 'delivered';

  const allQueued = results.every((r) => r.status === 'queued');
  if (allQueued) return 'queued';

  const hasFailure = results.some((r) => r.status === 'failed');
  if (hasFailure) return 'partial';

  const hasUnconfirmed = results.some((r) => r.status === 'unconfirmed');
  if (hasUnconfirmed) return 'unconfirmed';

  return 'queued';
}

/** The outcome for the recipients that are not disabled; empty `results` means all were skipped. */
export function withoutDisabledRecipients(outcome: DeliveryOutcome): DeliveryOutcome {
  const results = outcome.results.filter(
    (result) => !(result.status === 'failed' && result.error === AGENT_DISABLED_DELIVERY_ERROR),
  );
  if (results.length === outcome.results.length) return outcome;
  return { status: aggregateDeliveryStatus(results), results };
}
