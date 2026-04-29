/**
 * Validates apps/local-app/drizzle/meta/_journal.json against the rules that
 * Drizzle's better-sqlite3 migrator implicitly requires for safe upgrades.
 *
 * Why: Drizzle's migrator (drizzle-orm/sqlite-core/dialect.cjs:605-612) reads
 * the highest `created_at` from `__drizzle_migrations` and skips every journal
 * entry whose `when <= that high-water`. Inserting a NEW migration with a
 * `when` earlier than something already-applied makes Drizzle silently skip
 * the new migration on upgrade — that's the bug behind the 2026-04-29
 * "ALTER TABLE teams ADD max_members …" production failure.
 *
 * Rules enforced:
 * 1. `idx` values are 0..N-1 with no gaps and no duplicates.
 * 2. Each entry has a SQL file matching its `tag` next to the journal.
 * 3. Every entry whose idx is >= BASELINE_IDX_FLOOR must have a `when` strictly
 *    greater than the maximum `when` of all earlier entries. The grandfather
 *    floor is set to the current journal length when this validator was added
 *    (entries 0..floor-1 have already shipped to user databases and cannot be
 *    re-numbered without breaking existing __drizzle_migrations rows). Going
 *    forward, all new entries are held to the strict rule.
 *
 * Exits non-zero on violation so build / CI fails loudly.
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const drizzleDir = join(__dirname, '..', 'drizzle');
const journalPath = join(drizzleDir, 'meta', '_journal.json');

/**
 * Entries with idx < this floor are grandfathered: they shipped to user DBs
 * and their `when` values cannot be safely renumbered. Bump this constant
 * when adding a new migration so the strict-monotonic check applies to it.
 */
const BASELINE_IDX_FLOOR = 60;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function main() {
  if (!existsSync(journalPath)) {
    fail(`journal not found at ${journalPath}`);
  }

  const journal: Journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const entries = journal.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('journal has no entries');
  }

  const errors: string[] = [];

  // Rule 1: idx 0..N-1, no gaps/duplicates
  const sorted = [...entries].sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].idx !== i) {
      errors.push(
        `idx sequence broken at position ${i}: expected idx=${i}, got idx=${sorted[i].idx} (tag=${sorted[i].tag})`,
      );
    }
  }

  // Rule 2: every new entry (idx >= BASELINE_IDX_FLOOR) must have a `when`
  // strictly greater than the max of all earlier entries. Grandfathered
  // entries below the floor are accepted as-is (already shipped).
  let runningMaxWhen = -Infinity;
  for (const entry of sorted) {
    if (entry.idx >= BASELINE_IDX_FLOOR && entry.when <= runningMaxWhen) {
      errors.push(
        `new entry idx=${entry.idx} (${entry.tag}) has when=${entry.when} which is ` +
          `<= the max when (${runningMaxWhen}) of earlier entries. ` +
          `Drizzle's migrator uses the highest applied created_at as a high-water mark; ` +
          `any new entry with when <= an already-applied entry will be silently SKIPPED on upgrade. ` +
          `Use a current-time millisecond timestamp greater than ${runningMaxWhen}.`,
      );
    }
    if (entry.when > runningMaxWhen) runningMaxWhen = entry.when;
  }

  // Rule 3: SQL file exists per entry
  for (const entry of sorted) {
    const sqlPath = join(drizzleDir, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      errors.push(`missing SQL file for idx=${entry.idx}: expected ${sqlPath}`);
    }
  }

  if (errors.length > 0) {
    console.error(`✗ _journal.json is invalid (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nGuidance: NEVER hand-edit "when" to a value lower than an existing entry. ` +
        `Always append new migrations at the tail with a current-time "when".`,
    );
    process.exit(1);
  }

  console.log(
    `✓ _journal.json valid: ${entries.length} entries, idx 0-${entries.length - 1} ` +
      `(grandfather floor: idx<${BASELINE_IDX_FLOOR}, strict-monotonic enforced for idx>=${BASELINE_IDX_FLOOR})`,
  );
}

main();
