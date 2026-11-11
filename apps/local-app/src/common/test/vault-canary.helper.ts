import type Database from 'better-sqlite3';

/** Every row of every table as one text, for a scan of the whole DB. */
export function dumpDatabase(sqlite: Database.Database): string {
  const tables = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  return JSON.stringify(tables.map((table) => sqlite.prepare(`SELECT * FROM "${table}"`).all()));
}

/** Each canary as plain text and in base64, the form a file value travels in. */
export function canaryForms(canaries: readonly string[]): string[] {
  return canaries.flatMap((canary) => [canary, Buffer.from(canary).toString('base64')]);
}

/**
 * Fails with one `surface: canary` line per leak. A surface is any value; non-strings are
 * scanned as JSON.
 */
export function expectNoCanaries(
  surfaces: Record<string, unknown>,
  canaries: readonly string[],
): void {
  const leaks = Object.entries(surfaces).flatMap(([surface, content]) => {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return canaries.filter((canary) => text.includes(canary)).map((c) => `${surface}: ${c}`);
  });
  expect(leaks).toEqual([]);
}
