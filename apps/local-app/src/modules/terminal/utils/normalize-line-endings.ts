// Match bare LF (not preceded by CR). Negative lookbehind keeps already-correct
// CRLF intact, so applying this multiple times or to mixed content is safe.
const BARE_LF_RE = /(?<!\r)\n/g;

/**
 * Insert CR before any bare LF in the data, leaving existing CRLF unchanged.
 * Used for non-Claude PTY output before broadcasting to xterm.js (which runs
 * with `convertEol:false` because Claude needs raw LF semantics).
 */
export function normalizeLineEndings(data: string): string {
  return data.replace(BARE_LF_RE, '\r\n');
}
