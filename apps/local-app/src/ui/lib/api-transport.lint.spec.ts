import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Runs the real eslint.config.mjs in a child process: Jest cannot load the ESM
// flat config itself. Each sample reuses an existing file path so typed linting
// finds it in tsconfig.eslint.json; only the text is replaced.
const APP_ROOT = resolve(__dirname, '../../..');

const LINT_SCRIPT = `
import { ESLint } from 'eslint';
import { dirname } from 'node:path';
const configPath = process.argv[1];
const samples = JSON.parse(process.argv[2]);
const eslint = new ESLint({
  cwd: dirname(configPath),
  overrideConfigFile: configPath,
});
const results = {};
for (const [name, { filePath, code }] of Object.entries(samples)) {
  const [result] = await eslint.lintText(code, { filePath });
  results[name] = result.messages.map((m) => m.ruleId);
}
process.stdout.write(JSON.stringify(results));
`;

const BARE_FETCH_CODE = `export async function load(): Promise<unknown> {
  const response = await fetch('/api/epics');
  const other = await window.fetch('/api/agents');
  return [await response.json(), await other.json()];
}
`;

describe('bare fetch lint rule', () => {
  it('reports bare fetch in UI files and allows the transport module and specs', () => {
    const samples = {
      uiFile: { filePath: resolve(APP_ROOT, 'src/ui/lib/config.ts'), code: BARE_FETCH_CODE },
      transportModule: {
        filePath: resolve(APP_ROOT, 'src/ui/lib/api-transport.ts'),
        code: BARE_FETCH_CODE,
      },
      specFile: {
        filePath: resolve(APP_ROOT, 'src/ui/lib/api-transport.spec.ts'),
        code: BARE_FETCH_CODE,
      },
    };

    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        LINT_SCRIPT,
        resolve(APP_ROOT, 'eslint.config.mjs'),
        JSON.stringify(samples),
      ],
      {
        cwd: APP_ROOT,
        encoding: 'utf8',
        // Keep type-aware scope analysis active in this in-memory probe; CI's single-run
        // inference can otherwise skip the file-scoped restrictions on the first lint.
        env: { ...process.env, TSESTREE_SINGLE_RUN: 'false' },
      },
    );
    const results = JSON.parse(output) as Record<keyof typeof samples, Array<string | null>>;

    expect(results.uiFile).toEqual(['no-restricted-globals', 'no-restricted-properties']);
    expect(results.transportModule).toEqual([]);
    expect(results.specFile).toEqual([]);
  }, 120_000);
});
