import { createLogger } from '../../../common/logging/logger';
import { generateDeliveryNonce } from '../../../common/delivery-nonce';
import { PasteNotConfirmedError } from '../../../common/errors/error-types';
import type { TmuxService } from './tmux.service';
import type { TerminalSendCoordinatorService } from './terminal-send-coordinator.service';

const logger = createLogger('ConfirmedDelivery');

const MAX_ATTEMPTS = 2;

export interface ConfirmedDeliveryResult {
  confirmed: boolean;
  nonce: string;
  retryCount: number;
  method?: 'nonce' | 'paste_indicator' | 'paste_changed';
}

/**
 * Encapsulates the complete confirmed delivery cycle:
 * 1. Generate nonce, append [MsgId:{nonce}] to text
 * 2. Call pasteAndSubmit(confirm: true, nonce)
 * 3. On PasteNotConfirmedError: Escape → re-apply gap → fresh nonce → retry once
 * 4. On final failure: send Enter anyway → return { confirmed: false }
 * 5. On success: return { confirmed: true, method, retryCount }
 *
 * PasteNotConfirmedError never propagates to callers — always handled internally.
 * IOError and other tmux failures propagate immediately.
 */
export async function deliverWithConfirmation(
  tmux: TmuxService,
  sendCoordinator: TerminalSendCoordinatorService | null,
  params: {
    tmuxSessionId: string;
    text: string;
    submitKeys?: string[];
    agentId?: string;
  },
): Promise<ConfirmedDeliveryResult> {
  const { tmuxSessionId, text, agentId } = params;
  const submitKeys = params.submitKeys ?? ['Enter'];

  let lastNonce = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    lastNonce = generateDeliveryNonce();
    const textWithNonce = `${text}\n[MsgId:${lastNonce}]`;

    try {
      if (agentId && sendCoordinator) {
        await sendCoordinator.ensureAgentGap(agentId, 1000);
      }

      await tmux.pasteAndSubmit(tmuxSessionId, textWithNonce, {
        bracketed: true,
        submitKeys,
        confirm: true,
        nonce: lastNonce,
      });

      // Success — confirmed delivery
      return { confirmed: true, nonce: lastNonce, retryCount: attempt };
    } catch (error) {
      if (error instanceof PasteNotConfirmedError && attempt < MAX_ATTEMPTS - 1) {
        // Retry: send Escape to clear partial input, wait, then retry with fresh nonce
        logger.warn({ tmuxSessionId, attempt }, 'Paste not confirmed, clearing draft and retrying');
        try {
          await tmux.sendKeys(tmuxSessionId, ['Escape']);
        } catch {
          // Best-effort Escape
        }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      // Final PasteNotConfirmedError → send Enter anyway, mark unconfirmed
      if (error instanceof PasteNotConfirmedError) {
        logger.warn(
          { tmuxSessionId, attempt },
          'Delivery unconfirmed after retries, sending Enter as fallback',
        );
        try {
          await tmux.sendKeys(tmuxSessionId, submitKeys);
        } catch {
          // Best-effort Enter
        }
        return { confirmed: false, nonce: lastNonce, retryCount: attempt };
      }

      // Other errors (IOError, etc.) — propagate immediately
      throw error;
    }
  }

  // Should not reach here
  return { confirmed: false, nonce: lastNonce, retryCount: MAX_ATTEMPTS - 1 };
}
