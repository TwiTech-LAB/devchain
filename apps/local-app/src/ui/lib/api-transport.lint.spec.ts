import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '../../..');
// Jest cannot load the ESM flat config; resolving rules avoids a typed lint program.
const CONFIG_SCRIPT = `
import { ESLint } from 'eslint';
import { dirname } from 'node:path';
const configPath = process.argv[1];
const eslint = new ESLint({ cwd: dirname(configPath), overrideConfigFile: configPath });
const results = {};
for (const [name, filePath] of Object.entries(JSON.parse(process.argv[2]))) {
  const config = await eslint.calculateConfigForFile(filePath);
  results[name] = {
    globals: config.rules['no-restricted-globals'] ?? [0],
    properties: config.rules['no-restricted-properties'] ?? [0],
  };
}
process.stdout.write(JSON.stringify(results));
`;

describe('bare fetch lint rule', () => {
  it('restricts bare fetch in UI files and exempts the transport module and specs', () => {
    const paths = {
      uiFile: resolve(APP_ROOT, 'src/ui/lib/config.ts'),
      transportModule: resolve(APP_ROOT, 'src/ui/lib/api-transport.ts'),
      specFile: resolve(APP_ROOT, 'src/ui/lib/api-transport.spec.ts'),
    };
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        CONFIG_SCRIPT,
        resolve(APP_ROOT, 'eslint.config.mjs'),
        JSON.stringify(paths),
      ],
      { cwd: APP_ROOT, encoding: 'utf8' },
    );
    const results = JSON.parse(output) as Record<
      keyof typeof paths,
      {
        globals: unknown[];
        properties: unknown[];
      }
    >;
    expect(results.uiFile.globals).toEqual([2, expect.objectContaining({ name: 'fetch' })]);
    expect(results.uiFile.properties).toEqual([
      2,
      ...['window', 'globalThis', 'self'].map((object) =>
        expect.objectContaining({ object, property: 'fetch' }),
      ),
    ]);
    for (const name of ['transportModule', 'specFile'] as const) {
      expect(results[name].globals[0]).toBe(0);
      expect(results[name].properties[0]).toBe(0);
    }
  });
});
