import { Injectable } from '@nestjs/common';
import { TerminalSession, TerminalIORef } from './terminal-session';

export interface TerminalSessionCreateOptions {
  readonly normalizeCapturedLineEndings?: boolean;
}

@Injectable()
export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly idleTimeoutResolver?: () => number | undefined;

  constructor(idleTimeoutResolver?: () => number | undefined) {
    this.idleTimeoutResolver = idleTimeoutResolver;
  }

  create(
    sessionId: string,
    tmuxSessionName: string,
    options?: TerminalSessionCreateOptions,
  ): TerminalSession {
    if (this.sessions.has(sessionId)) {
      throw new Error(`TerminalSession already exists for session "${sessionId}"`);
    }

    const session = new TerminalSession({
      sessionId,
      tmuxSessionName,
      idleAfterMs: this.idleTimeoutResolver?.(),
      normalizeCapturedLineEndings: options?.normalizeCapturedLineEndings,
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  bind(sessionId: string, terminalIO: TerminalIORef): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Cannot bind: TerminalSession "${sessionId}" not found`);
    }
    session.bindIO(terminalIO);
  }

  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.dispose();
    this.sessions.delete(sessionId);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  get size(): number {
    return this.sessions.size;
  }
}
