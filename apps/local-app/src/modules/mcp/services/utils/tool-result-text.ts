/**
 * Turns a successful tool result into its single text block.
 *
 * Some MCP clients cut long tool output and read the rest line by line, with a
 * per-line limit (see "Tool result layout" in docs/mcp-standards.md). A long
 * string inside pretty JSON is one escaped line, so it is moved out of the JSON
 * into a section after it, with its real line breaks.
 */
import { MOVED_TEXT_THRESHOLD_BYTES } from '../../../../common/constants/client-line-limits';

export function movedTextMarker(path: string): string {
  return `[moved: full text in section «${path}» below]`;
}

const MOVED_TEXT_MARKER_LINE = /^\[moved: full text in section «([^»\n]*)» below\]$/;

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const ROOT_PATH = '(root)';

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  // Single quotes keep the path free of JSON escapes when it sits inside the marker.
  if (!IDENTIFIER_KEY.test(key)) return `${parent}['${key.replace(/[\\']/g, '\\$&')}']`;
  return parent === '' ? key : `${parent}.${key}`;
}

function isLong(value: string): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') > MOVED_TEXT_THRESHOLD_BYTES;
}

type MovedText = { path: string; text: string };

function moveLongStrings(value: unknown, path: string, moved: MovedText[]): unknown {
  if (typeof value === 'string') {
    if (!isLong(value)) return value;
    const sectionPath = path === '' ? ROOT_PATH : path;
    moved.push({ path: sectionPath, text: value });
    return movedTextMarker(sectionPath);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = moveLongStrings(value[i], childPath(path, i), moved);
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = moveLongStrings(record[key], childPath(path, key), moved);
    }
  }
  return value;
}

/**
 * Pretty JSON of `data`, with every long string replaced by a marker and appended
 * as a `===== <path> =====` section. Without long strings the text equals
 * `JSON.stringify(data, null, 2)`. `data` is never mutated.
 */
export function formatToolResultText(data: unknown): string {
  // JSON round trip keeps toJSON, Date and undefined handling identical to plain stringify.
  // JSON.stringify(undefined) is undefined at runtime despite its `string` type.
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) return json;
  // Each string's escaped form is part of `json`, so a short `json` holds no long string.
  if (Buffer.byteLength(json, 'utf8') <= MOVED_TEXT_THRESHOLD_BYTES) return json;

  const moved: MovedText[] = [];
  const value = moveLongStrings(JSON.parse(json), '', moved);
  if (moved.length === 0) return json;

  const parts = [JSON.stringify(value, null, 2)];
  for (const { path, text } of moved) {
    parts.push(`===== ${path} =====`, text, `===== end ${path} =====`);
  }
  return parts.join('\n');
}

/**
 * Finds the first string argument with a line that is exactly a moved-text marker.
 * Returns the argument path and the section path the marker points to.
 */
export function findMovedTextMarker(
  value: unknown,
  path: Array<string | number> = [],
): { argumentPath: Array<string | number>; sectionPath: string } | null {
  if (typeof value === 'string') {
    if (!value.includes('[moved: ')) return null;
    for (const line of value.split(/\r?\n/)) {
      const match = MOVED_TEXT_MARKER_LINE.exec(line.trim());
      if (match) return { argumentPath: path, sectionPath: match[1] };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findMovedTextMarker(value[i], [...path, i]);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const found = findMovedTextMarker(child, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}
