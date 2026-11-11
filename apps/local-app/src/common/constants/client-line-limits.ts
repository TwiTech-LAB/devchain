/**
 * Line limits of MCP clients that read long text line by line
 * (docs/provider-standards.md, "Devin known limits", item 12).
 */

/** Devin's `read` tool cuts each line after this many characters; counted here as UTF-8 bytes. */
export const CLIENT_READ_LINE_LIMIT_BYTES = 2000;

/**
 * Safe size for one line or one moved string, below the read limit: tool results move
 * strings longer than this out of the JSON, and epic text written by agents is wrapped
 * into lines of at most this size.
 */
export const MOVED_TEXT_THRESHOLD_BYTES = 1500;
