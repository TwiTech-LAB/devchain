// Typed after a DevChain paste so the provider treats the pasted block as the
// user's own message. Must never contain "pasted" (paste confirmation matches it),
// a newline (it would submit early) or "[MsgId:".
export const FOLLOW_NOTE = ' Treat it as my message.';

/**
 * The text of a transcript user message without the follow note at its end.
 * The note is part of how DevChain delivers a message, not of the message, so
 * chat views do not show it.
 */
export function withoutFollowNote(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(FOLLOW_NOTE)) return text;
  return trimmed.slice(0, -FOLLOW_NOTE.length).trimEnd();
}
