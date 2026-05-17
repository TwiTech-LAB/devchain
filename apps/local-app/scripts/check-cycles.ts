/**
 * Cycle detector — CI guard for module-graph health.
 *
 * Mechanism: madge --circular + classified allowlist comparison.
 * Design: docs/plans/6c-detector-design.md
 * Allowlist: docs/cycle-allowlist.md
 *
 * Exit codes:
 *   0 = all cycles allowlisted, no stale entries
 *   1 = new cycle(s) OR stale allowlist entry
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, relative } from 'path';

const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '../..');
const ALLOWLIST_PATH = resolve(REPO_ROOT, 'docs/cycle-allowlist.md');
const MODULES_DIR = resolve(ROOT, 'src/modules');
const TSCONFIG = resolve(ROOT, 'tsconfig.json');

function runMadge(): string[][] {
  const madgeBin = resolve(ROOT, 'node_modules/.bin/madge');
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
  return cycle
    .map((f) => f.replace(/^src\/modules\//, ''))
    .join(' > ');
}

type AllowlistEntry = {
  path: string;
  kind: string;
};

const VALID_KINDS = new Set(['file-structure', 'nest-module-structural']);

function parseAllowlist(): AllowlistEntry[] {
  const content = readFileSync(ALLOWLIST_PATH, 'utf-8');
  const entries: AllowlistEntry[] = [];

  const yamlBlocks = content.match(/```yaml\n([\s\S]*?)```/g);
  if (!yamlBlocks) return entries;

  for (const block of yamlBlocks) {
    const lines = block.split('\n');
    let currentPath: string | null = null;
    let currentKind: string | null = null;

    for (const line of lines) {
      const pathMatch = line.match(/^\s*-?\s*path:\s*"(.+)"$/);
      if (pathMatch) {
        if (currentPath) {
          entries.push({ path: currentPath, kind: currentKind ?? '' });
        }
        currentPath = pathMatch[1];
        currentKind = null;
        continue;
      }

      const kindMatch = line.match(/^\s*kind:\s*([A-Za-z0-9_-]+)\s*$/);
      if (kindMatch && currentPath) {
        currentKind = kindMatch[1];
      }
    }

    if (currentPath) {
      entries.push({ path: currentPath, kind: currentKind ?? '' });
    }
  }

  return entries;
}

function main(): void {
  console.log('🔍 Running cycle detector (madge --circular)...\n');

  const cycles = runMadge();
  const normalizedCycles = cycles.map(normalizeCyclePath);
  const allowlistEntries = parseAllowlist();
  const allowedPaths = allowlistEntries.map((entry) => entry.path);

  console.log(`  Detected: ${cycles.length} circular dependencies`);
  console.log(`  Allowlisted: ${allowlistEntries.length} entries\n`);

  const invalidKindEntries = allowlistEntries.filter((entry) => !VALID_KINDS.has(entry.kind));
  if (invalidKindEntries.length > 0) {
    console.log('❌ INVALID ALLOWLIST KINDS:\n');
    for (const entry of invalidKindEntries) {
      const shownKind = entry.kind.length > 0 ? entry.kind : '<missing>';
      console.log(`   ${entry.path} (kind: ${shownKind})`);
    }
    console.log('');
    console.log(
      `   → Allowed kinds are: ${Array.from(VALID_KINDS).join(', ')}. Update docs/cycle-allowlist.md.\n`,
    );
    process.exit(1);
  }

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
    console.log('   → Fix the cycle OR add to docs/cycle-allowlist.md with architect approval.\n');
  }

  if (stalePaths.length > 0) {
    failed = true;
    console.log('⚠️  STALE ALLOWLIST ENTRIES (cycle no longer exists):\n');
    for (const s of stalePaths) {
      console.log(`   ${s}`);
    }
    console.log('');
    console.log('   → Remove stale entries from docs/cycle-allowlist.md.\n');
  }

  if (!failed) {
    console.log('✅ All cycles accounted for. No new cycles, no stale entries.\n');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
