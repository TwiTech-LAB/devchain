/**
 * Cycle detector — CI guard for module-graph health.
 *
 * Mechanism: madge --circular + classified allowlist comparison.
 * Allowlist: apps/local-app/scripts/cycle-allowlist.json
 *
 * Exit codes:
 *   0 = all cycles allowlisted, no stale entries
 *   1 = new cycle(s) OR stale allowlist entry
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(__dirname, 'cycle-allowlist.json');
const ALLOWLIST_DISPLAY_PATH = 'apps/local-app/scripts/cycle-allowlist.json';
const MODULES_DIR = resolve(ROOT, 'src/modules');
const TSCONFIG = resolve(ROOT, 'tsconfig.json');

function runMadge(): string[][] {
  // Revalidate this package subpath when upgrading Madge.
  const madgeBin = require.resolve('madge/bin/cli.js');
  const cmd = `"${madgeBin}" --circular --json --extensions ts --exclude '.*\\.spec\\.ts$' --ts-config "${TSCONFIG}" "${MODULES_DIR}"`;
  try {
    const result = execSync(cmd, { encoding: 'utf-8', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(result) as string[][];
  } catch (error: any) {
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout) as string[][];
      } catch {
        // fall through
      }
    }
    console.error('Failed to run madge:', error.message || error);
    process.exit(2);
  }
}

function normalizeCyclePath(cycle: string[]): string {
  return cycle.map((f) => f.replace(/^src\/modules\//, '')).join(' > ');
}

type AllowlistKind = 'file-structure' | 'nest-module-structural';

type AllowlistEntry = {
  path: string;
  kind: AllowlistKind;
  rationale: string;
  expiry: string;
};

const REQUIRED_FIELDS = ['path', 'kind', 'rationale', 'expiry'] as const;
const VALID_KINDS = new Set(['file-structure', 'nest-module-structural']);

function parseAllowlist(): AllowlistEntry[] {
  let content: string;
  try {
    content = readFileSync(ALLOWLIST_PATH, 'utf-8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ALLOWLIST_DISPLAY_PATH}: unable to read cycle policy (${detail})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ALLOWLIST_DISPLAY_PATH}: invalid JSON (${detail})`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${ALLOWLIST_DISPLAY_PATH}: expected the top-level value to be an array`);
  }
  if (parsed.length === 0) {
    throw new Error(`${ALLOWLIST_DISPLAY_PATH}: expected at least one policy entry`);
  }

  const firstIndexByPath = new Map<string, number>();

  return parsed.map((candidate, index) => {
    const entryPath = `$[${index}]`;
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${ALLOWLIST_DISPLAY_PATH}: ${entryPath} must be an object`);
    }

    const entry = candidate as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(
          `${ALLOWLIST_DISPLAY_PATH}: ${entryPath}.${field} must be a non-empty string`,
        );
      }
    }

    if (!VALID_KINDS.has(entry.kind as string)) {
      throw new Error(
        `${ALLOWLIST_DISPLAY_PATH}: ${entryPath}.kind must be one of ${[...VALID_KINDS].join(
          ', ',
        )}`,
      );
    }

    const path = entry.path as string;
    const firstIndex = firstIndexByPath.get(path);
    if (firstIndex !== undefined) {
      throw new Error(
        `${ALLOWLIST_DISPLAY_PATH}: ${entryPath}.path duplicates $[${firstIndex}].path (${JSON.stringify(path)})`,
      );
    }
    firstIndexByPath.set(path, index);

    return {
      path,
      kind: entry.kind as AllowlistKind,
      rationale: entry.rationale as string,
      expiry: entry.expiry as string,
    };
  });
}

function main(): void {
  console.log('🔍 Running cycle detector (madge --circular)...\n');

  let allowlistEntries: AllowlistEntry[];
  try {
    allowlistEntries = parseAllowlist();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`❌ INVALID CYCLE POLICY: ${detail}`);
    process.exit(1);
  }

  const cycles = runMadge();
  const normalizedCycles = cycles.map(normalizeCyclePath);
  const allowedPaths = allowlistEntries.map((entry) => entry.path);

  console.log(`  Detected: ${cycles.length} circular dependencies`);
  console.log(`  Allowlisted: ${allowlistEntries.length} entries\n`);

  const hitAllowlist = new Set<string>();
  const newCycles: string[] = [];

  for (const cyclePath of normalizedCycles) {
    if (allowedPaths.includes(cyclePath)) {
      hitAllowlist.add(cyclePath);
    } else {
      newCycles.push(cyclePath);
    }
  }

  const stalePaths = allowedPaths.filter((p) => !hitAllowlist.has(p));

  let failed = false;

  if (newCycles.length > 0) {
    failed = true;
    console.log('❌ NEW CYCLES (not in allowlist):\n');
    for (const c of newCycles) {
      console.log(`   ${c}`);
    }
    console.log('');
    console.log(
      `   → Fix the cycle OR add to ${ALLOWLIST_DISPLAY_PATH} with architect approval.\n`,
    );
  }

  if (stalePaths.length > 0) {
    failed = true;
    console.log('⚠️  STALE ALLOWLIST ENTRIES (cycle no longer exists):\n');
    for (const s of stalePaths) {
      console.log(`   ${s}`);
    }
    console.log('');
    console.log(`   → Remove stale entries from ${ALLOWLIST_DISPLAY_PATH}.\n`);
  }

  if (!failed) {
    console.log('✅ All cycles accounted for. No new cycles, no stale entries.\n');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
