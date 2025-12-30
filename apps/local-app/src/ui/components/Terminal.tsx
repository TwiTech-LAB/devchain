/**
 * Terminal Component - Chat Mode Only
 *
 * This file re-exports ChatTerminal as the main Terminal component.
 * Legacy terminal engines (hterm, xterm wrapper) have been removed.
 * ChatTerminal is now the only terminal implementation.
 */

export { ChatTerminal as Terminal } from './terminal/ChatTerminal';
export type { ChatTerminalHandle as TerminalHandle } from './terminal/ChatTerminal';
