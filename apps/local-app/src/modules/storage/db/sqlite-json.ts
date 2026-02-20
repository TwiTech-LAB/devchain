import { sql, type SQL, type Column } from 'drizzle-orm';

/**
 * Build a safe JSON field equality filter for SQLite.
 *
 * Generates: `CASE WHEN json_valid(column) THEN json_extract(column, path) END = value`
 *
 * This guards against rows where the column contains invalid JSON (e.g. empty
 * string, plain text) — `json_valid` returns 0 and the CASE evaluates to NULL,
 * which never equals the target value.
 *
 * @param column - Drizzle column reference containing JSON text
 * @param path   - JSON path expression (e.g. '$.ownerProjectId')
 * @param value  - Value to compare against
 */
export function safeJsonFieldEquals(column: Column, path: string, value: string): SQL<unknown> {
  return sql`CASE WHEN json_valid(${column}) THEN json_extract(${column}, ${path}) END = ${value}`;
}
