import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';
import type { JSONPath, ParseError } from 'jsonc-parser';

/**
 * Parse JSON with comments (and trailing commas). Throws `SyntaxError` on any
 * parse error, so callers can treat it like `JSON.parse`.
 */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new SyntaxError(
      `Invalid JSON with comments: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  return value;
}

/**
 * Set (or, with `value === undefined`, remove) one value in a JSONC document
 * and return the new text. Only the edited range changes: comments and the
 * formatting of the rest of the document stay as they are. A path ending in
 * `-1` appends to an array. Never round-trip such a document through
 * `JSON.stringify` — that drops every comment.
 */
export function setJsoncValue(text: string, path: JSONPath, value: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(text, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  return applyEdits(text, edits);
}
