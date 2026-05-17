import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', '..', '..', '..');

const MIGRATED_FILES = [
  'modules/mcp/services/handlers/chat-tools.ts',
  'modules/sessions/services/sessions.service.ts',
  'modules/sessions/services/sessions-message-pool.service.ts',
  'modules/terminal/gateways/terminal.gateway.ts',
];

describe('no-bypass gate coverage', () => {
  it('no migrated file imports confirmed-delivery.helper', () => {
    for (const file of MIGRATED_FILES) {
      const content = readFileSync(join(SRC_ROOT, file), 'utf-8');
      expect(content).not.toContain('confirmed-delivery.helper');
    }
  });

  it('confirmed-delivery.helper.ts is deleted', () => {
    expect(() =>
      readFileSync(
        join(SRC_ROOT, 'modules/terminal/services/confirmed-delivery.helper.ts'),
        'utf-8',
      ),
    ).toThrow();
  });

  it('no migrated file calls tmux.pasteAndSubmit or tmux.sendKeys for delivery', () => {
    for (const file of MIGRATED_FILES) {
      const content = readFileSync(join(SRC_ROOT, file), 'utf-8');
      expect(content).not.toMatch(/tmuxService\.pasteAndSubmit\(/);
      expect(content).not.toMatch(/tmuxService\.sendCommand\(/);
      expect(content).not.toMatch(/tmux\.pasteAndSubmit\(/);
    }
  });

  it('migrated send paths use TerminalIOService (terminalIO.deliver or deliverImmediate or sendControl)', () => {
    const deliveryPattern = /terminalIO\.(deliver|deliverImmediate|sendControl)\(/;
    const filesWithDelivery = MIGRATED_FILES.filter((file) => {
      const content = readFileSync(join(SRC_ROOT, file), 'utf-8');
      return deliveryPattern.test(content);
    });
    expect(filesWithDelivery.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Shell-eval + child_process gate (R3) ────────────────────────────────

const SHELL_EVAL_PATTERNS = [
  /'\/?bin\/sh',\s*'-c'/,
  /"\/bin\/sh",\s*"-c"/,
  /'cmd\.exe',\s*'\/[dsc]'/,
  /"cmd\.exe",\s*"\/[dsc]"/,
  /shell:\s*true/,
];

function detectShellEval(content: string): string[] {
  const violations: string[] = [];
  for (const pattern of SHELL_EVAL_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`matches ${pattern.source}`);
    }
  }
  return violations;
}

const CHILD_PROCESS_IMPORT_PATTERN = /from\s+['"]child_process['"]/;
const NODE_PTY_IMPORT_PATTERN = /from\s+['"]node-pty['"]|require\(\s*['"]node-pty['"]\)/;

const PROCESS_EXECUTOR_DIR = 'modules/terminal/services/process-executor/';

const CHILD_PROCESS_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [];

const NODE_PTY_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  // backlog: 721b64bf — pty.service.ts streaming (attach-to-existing-session pattern)
  { path: 'modules/terminal/services/pty.service.ts', reason: 'backlog: 721b64bf' },
];

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.e2e-spec.ts')
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('argv-only + child_process gate (R3)', () => {
  const allSourceFiles = collectSourceFiles(SRC_ROOT);

  const productionFiles = allSourceFiles.filter((f) => {
    const rel = relative(SRC_ROOT, f);
    return !rel.startsWith(PROCESS_EXECUTOR_DIR);
  });

  it('Test A — no shell-string execution in production code', () => {
    const failures: string[] = [];

    for (const file of productionFiles) {
      const rel = relative(SRC_ROOT, file);
      const content = readFileSync(file, 'utf-8');
      const violations = detectShellEval(content);
      if (violations.length > 0) {
        failures.push(`${rel}: ${violations.join(', ')}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('Test B — no child_process import outside ProcessExecutor (with allowlist)', () => {
    const allowedPaths = new Set(CHILD_PROCESS_ALLOWLIST.map((e) => e.path));
    const failures: string[] = [];

    for (const file of productionFiles) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (allowedPaths.has(rel)) continue;

      const content = readFileSync(file, 'utf-8');
      if (CHILD_PROCESS_IMPORT_PATTERN.test(content)) {
        failures.push(
          `${rel} imports child_process — file a backlog item and add to CHILD_PROCESS_ALLOWLIST before merging`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it('Test B.2 — no node-pty import outside ProcessExecutor (with allowlist)', () => {
    const allowedPaths = new Set(NODE_PTY_ALLOWLIST.map((e) => e.path));
    const failures: string[] = [];

    for (const file of productionFiles) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (allowedPaths.has(rel)) continue;

      const content = readFileSync(file, 'utf-8');
      if (NODE_PTY_IMPORT_PATTERN.test(content)) {
        failures.push(
          `${rel} imports node-pty — file a backlog item and add to NODE_PTY_ALLOWLIST before merging`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  const TMUX_SERVICE_ALLOWLIST = new Set<string>([]);

  it('Test D — TmuxService is not imported anywhere (fully retired in Phase 2A)', () => {
    const tmuxImportPattern = /from\s+['"][^'"]*tmux\.service['"]/;
    const violations: string[] = [];

    for (const file of productionFiles) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (TMUX_SERVICE_ALLOWLIST.has(rel)) continue;

      const content = readFileSync(file, 'utf-8');
      if (tmuxImportPattern.test(content)) {
        violations.push(rel);
      }
    }

    expect(violations).toEqual([]);
  });

  it('Test C — sentinel: detectShellEval catches R2-class violations', () => {
    expect(detectShellEval("const args = ['/bin/sh', '-c', userInput]")).toHaveLength(1);
    expect(detectShellEval('spawn("cmd.exe", "/d", "/s", "/c")')).toHaveLength(1);
    expect(detectShellEval('{ shell: true }')).toHaveLength(1);
    expect(detectShellEval("execFile('git', ['status'])")).toHaveLength(0);
    expect(detectShellEval("ProcessExecutor.run({ argv: ['echo'] })")).toHaveLength(0);
  });
});
