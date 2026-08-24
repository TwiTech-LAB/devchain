/**
 * Whether a key event should be withheld from the terminal rather than forwarded.
 *
 * Only a bare Ctrl+C with a selection qualifies. Ctrl+C without a selection is
 * the interrupt an agent may need, and any modifier combination beyond Ctrl is
 * somebody else's shortcut.
 */
export function shouldWithholdCtrlC(
  event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  hasSelection: boolean,
  enabled: boolean,
): boolean {
  if (!enabled || !hasSelection) return false;
  if (event.type !== 'keydown') return false;
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;
  return event.key === 'c' || event.key === 'C';
}
