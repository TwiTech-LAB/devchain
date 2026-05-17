import { Injectable } from '@nestjs/common';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import type {
  GuestSessionRef,
  TerminalDeliveryOptions,
  TerminalDeliveryResult,
} from './terminal-delivery.types';

@Injectable()
export class GuestDeliveryService {
  constructor(private readonly terminalIO: TerminalIOService) {}

  async deliverToGuest(
    sessionRef: GuestSessionRef,
    message: string,
    options?: Pick<TerminalDeliveryOptions, 'submitKeys'>,
  ): Promise<TerminalDeliveryResult> {
    try {
      await this.terminalIO.deliverImmediate(sessionRef, message, {
        submitKeys: options?.submitKeys ?? ['Enter'],
        confirm: false,
      });
      return { delivered: true };
    } catch (error) {
      return { delivered: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
