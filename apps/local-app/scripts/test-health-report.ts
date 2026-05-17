/**
 * Test health report generator.
 *
 * Reads Jest JSON output + coverage-summary.json and emits a markdown report
 * with: top 20 slow suites, mega-specs (>1000 LOC), skipped tests, coverage
 * by layer, and open-handle warnings.
 *
 * Usage:
 *   ts-node scripts/test-health-report.ts --results <path> --coverage <path> [--output <path>]
 *
 * If --output is omitted, writes to stdout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface JestTestResult {
  name: string;
  startTime: number;
  endTime: number;
  assertionResults: Array<{ status: string; fullName: string }>;
}

interface JestJsonOutput {
  testResults: JestTestResult[];
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
}

interface CoverageEntry {
  lines: { pct: number };
  statements: { pct: number };
  branches: { pct: number };
  functions: { pct: number };
}

interface CoverageSummary {
  [filePath: string]: CoverageEntry;
}

// --- CLI arg parsing ---

function parseArgs(args: string[]): {
  results: string;
  coverage: string;
  output?: string;
} {
  let results = '';
  let coverage = '';
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' && args[i + 1]) results = args[++i];
    else if (args[i] === '--coverage' && args[i + 1]) coverage = args[++i];
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
  }

  if (!results || !coverage) {
    console.error('Usage: ts-node test-health-report.ts --results <path> --coverage <path> [--output <path>]');
    process.exit(1);
  }

  return { results, coverage, output: output || path.join(__dirname, '..', 'reports', 'test-health-latest.md') };
}

// --- Section generators ---

function sectionSlowSuites(testResults: JestTestResult[]): string {
  const sorted = [...testResults]
    .sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))
    .slice(0, 20);

  const rows = sorted
    .map((r, i) => `| ${i + 1} | ${path.basename(r.name)} | ${((r.endTime - r.startTime) / 1000).toFixed(1)}s |`)
    .join('\n');

  return `## Top 20 Slowest Suites

| Rank | Suite | Duration |
| ---- | ----- | -------- |
${rows}`;
}

function sectionMegaSpecs(srcDir: string): string {
  const specFiles: Array<{ file: string; loc: number; tests: number }> = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.match(/\.(spec|test)\.(ts|tsx)$/)) {
        const content = fs.readFileSync(full, 'utf8');
        const loc = content.split('\n').length;
        if (loc > 1000) {
          const testCount = (content.match(/\b(it|test)\s*[\(']/g) || []).length;
          const rel = path.relative(srcDir, full);
          specFiles.push({ file: rel, loc, tests: testCount });
        }
      }
    }
  }

  walk(srcDir);
  specFiles.sort((a, b) => b.loc - a.loc);

  if (specFiles.length === 0) {
    return '## Specs >1000 Lines\n\nNo specs exceed 1000 lines.';
  }

  const rows = specFiles
    .map((s) => `| ${s.file} | ${s.loc.toLocaleString()} | ${s.tests} |`)
    .join('\n');

  return `## Specs >1000 Lines

| File | LOC | Tests |
| ---- | --- | ----- |
${rows}`;
}

// Approach A: derive from Jest JSON (monitored lane) so counts match Summary by construction.
function sectionSkippedTests(jestOutput: JestJsonOutput, srcDir: string): string {
  const skipEntries: Array<{ file: string; count: number; trackingIds: string[] }> = [];
  let totalSkips = 0;

  for (const suite of jestOutput.testResults) {
    const skipped = suite.assertionResults.filter(
      (a) => a.status === 'pending' || a.status === 'todo',
    );
    if (skipped.length === 0) continue;

    totalSkips += skipped.length;
    const rel = path.relative(srcDir, suite.name);
    const trackingIds: string[] = [];

    try {
      const content = fs.readFileSync(suite.name, 'utf8');
      for (const line of content.split('\n')) {
        if (/(?:it|test|describe)\.skip/.test(line)) {
          const todoMatch = line.match(/TODO\(test-strategy-overhaul\)/);
          if (todoMatch) {
            const epicMatch = line.match(/epic[:\s]+([a-f0-9-]+)/i);
            if (epicMatch) trackingIds.push(epicMatch[1]);
          }
        }
      }
    } catch {
      // Source file may not be readable
    }

    skipEntries.push({ file: rel, count: skipped.length, trackingIds });
  }

  skipEntries.sort((a, b) => b.count - a.count);

  if (skipEntries.length === 0) {
    return '## Skipped Tests\n\nTotal skipped: 0';
  }

  const details = skipEntries
    .map((s) => {
      const tracking = s.trackingIds.length > 0 ? `, tracking: ${s.trackingIds.join(', ')}` : '';
      return `- ${s.file} (${s.count} skips${tracking})`;
    })
    .join('\n');

  return `## Skipped Tests

Total skipped: ${totalSkips}

${details}`;
}

// Approach B: two source areas (backend, ui). Per-lane breakdown requires separate Jest runs.
function sectionCoverageByLayer(coverage: CoverageSummary, srcDir: string): string {
  const areas: Record<string, { files: string[]; name: string }> = {
    'backend': { name: 'backend', files: [] },
    'ui': { name: 'ui', files: [] },
  };

  for (const filePath of Object.keys(coverage)) {
    if (filePath.endsWith('.spec.ts') || filePath.endsWith('.spec.tsx')) continue;

    const rel = filePath.startsWith('/') ? path.relative(srcDir, filePath) : filePath;

    if (rel.includes('/ui/')) {
      areas['ui'].files.push(filePath);
    } else {
      areas['backend'].files.push(filePath);
    }
  }

  function aggregate(files: string[]): CoverageEntry | null {
    if (files.length === 0) return null;
    let lines = 0, statements = 0, branches = 0, functions = 0, count = 0;
    for (const f of files) {
      const entry = coverage[f];
      if (!entry) continue;
      lines += entry.lines.pct;
      statements += entry.statements.pct;
      branches += entry.branches.pct;
      functions += entry.functions.pct;
      count++;
    }
    if (count === 0) return null;
    return {
      lines: { pct: lines / count },
      statements: { pct: statements / count },
      branches: { pct: branches / count },
      functions: { pct: functions / count },
    };
  }

  const rows: string[] = [];
  for (const [, area] of Object.entries(areas)) {
    const agg = aggregate(area.files);
    if (!agg) continue;
    rows.push(
      `| ${area.name} | ${agg.lines.pct.toFixed(1)}% | ${agg.statements.pct.toFixed(1)}% | ${agg.branches.pct.toFixed(1)}% | ${agg.functions.pct.toFixed(1)}% |`,
    );
  }

  const global = coverage['total'];
  if (global) {
    rows.push(
      `| **Total** | **${global.lines.pct.toFixed(1)}%** | **${global.statements.pct.toFixed(1)}%** | **${global.branches.pct.toFixed(1)}%** | **${global.functions.pct.toFixed(1)}%** |`,
    );
  }

  return `## Coverage by Source Area

| Area | Lines | Statements | Branches | Functions |
| ---- | ----- | ---------- | -------- | --------- |
${rows.join('\n')}

> **Note:** Per-lane coverage (unit vs integration) requires separate Jest runs per project. The breakdown above reflects source areas, not test lanes.`;
}

function sectionOpenHandles(resultsPath: string): string {
  let count = 0;
  try {
    // Re-run jest with --detectOpenHandles to count, but that's expensive.
    // Instead, parse the original stderr from the JSON output file.
    // Jest's --json writes to the file, but stderr goes to console.
    // We check if the results file has any hint, or we just report N/A.
    const raw = fs.readFileSync(resultsPath, 'utf8');
    // Jest JSON output doesn't include stderr. Report that this requires
    // a separate --detectOpenHandles run.
    count = (raw.match(/\bOpen handle\b/g) || []).length;
  } catch {
    // File doesn't exist or can't be read
  }

  return `## Open Handles

Open-handle warnings: ${count}

> Note: Accurate open-handle detection requires \`jest --detectOpenHandles\`. The count above reflects matches in the JSON output file, which may be 0 if stderr was not captured.`;
}

function sectionSummary(jestOutput: JestJsonOutput): string {
  return `## Summary

| Metric | Value |
| ------ | ----- |
| Total tests | ${jestOutput.numTotalTests} |
| Passed | ${jestOutput.numPassedTests} |
| Failed | ${jestOutput.numFailedTests} |
| Skipped | ${jestOutput.numPendingTests + jestOutput.numTodoTests} |
| Suites | ${jestOutput.testResults.length} |`;
}

// --- Main ---

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = __dirname;
  const appDir = path.join(scriptDir, '..');
  const srcDir = path.join(appDir, 'src');

  // Read inputs
  const jestOutput: JestJsonOutput = JSON.parse(fs.readFileSync(args.results, 'utf8'));
  const coverage: CoverageSummary = JSON.parse(fs.readFileSync(args.coverage, 'utf8'));

  // Build report
  const sections = [
    '# Test Health Report',
    sectionSummary(jestOutput),
    sectionSlowSuites(jestOutput.testResults),
    sectionMegaSpecs(srcDir),
    sectionSkippedTests(jestOutput, srcDir),
    sectionCoverageByLayer(coverage, srcDir),
    sectionOpenHandles(args.results),
  ];

  const report = sections.join('\n\n') + '\n';

  if (args.output) {
    const outputDir = path.dirname(args.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(args.output, report, 'utf8');
    console.log(`Report written to ${args.output}`);
  } else {
    process.stdout.write(report);
  }
}

main();
