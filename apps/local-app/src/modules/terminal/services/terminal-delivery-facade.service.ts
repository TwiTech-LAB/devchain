import { Injectable } from '@nestjs/common';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import type {
  DeliverableActiveSession,
  TerminalDeliveryOptions,
  TerminalDeliveryResult,
  TerminalSessionRef,
} from './terminal-delivery.types';

@Injectable()
export class TerminalDeliveryFacade {
  constructor(private readonly terminalIO: TerminalIOService) {}

  async deliverToAgent(
    session: DeliverableActiveSession,
    message: string,
    options?: TerminalDeliveryOptions,
  ): Promise<TerminalDeliveryResult> {
    if (!session.tmuxSessionId) {
      return { delivered: false, error: 'NO_TMUX_SESSION' };
    }

    return this.deliverToSession({ name: session.tmuxSessionId }, message, options);
  }

  async deliverToSession(
    sessionRef: TerminalSessionRef,
    message: string,
    options?: TerminalDeliveryOptions,
  ): Promise<TerminalDeliveryResult> {
    try {
      await this.terminalIO.deliverImmediate(sessionRef, message, {
        ...options,
        submitKeys: options?.submitKeys ?? ['Enter'],
        confirm: options?.confirm ?? false,
      });
      return { delivered: true };
    } catch (error) {
      return { delivered: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async sessionExists(sessionRef: TerminalSessionRef): Promise<boolean> {
    return this.terminalIO.sessionExists(sessionRef);
  }
}
