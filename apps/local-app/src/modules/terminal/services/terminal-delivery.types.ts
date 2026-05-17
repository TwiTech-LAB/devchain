import type { ActiveSessionInfo } from '../../sessions/dtos/active-session-info.dto';
import type { DeliveryOptions, SessionTarget } from './terminal-io/types';

export type TerminalSessionRef = SessionTarget;
export type GuestSessionRef = TerminalSessionRef;
export type TerminalDeliveryOptions = Omit<DeliveryOptions, 'agentId'>;
export type DeliverableActiveSession = Pick<ActiveSessionInfo, 'tmuxSessionId'>;

export interface TerminalDeliveryResult {
  readonly delivered: boolean;
  readonly error?: string;
}
