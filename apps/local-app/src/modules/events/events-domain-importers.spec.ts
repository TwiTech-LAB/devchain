import { readdirSync, readFileSync, statSync } from 'fs';
import { relative, resolve } from 'path';

describe('removed events domain module policy', () => {
  it('forbids source references to the removed domain module', () => {
    const srcRoot = resolve(__dirname, '../..');
    const removedClassName = ['Events', 'Domain', 'Module'].join('');
    const removedFileName = ['events', 'domain'].join('-') + '.module';

    const offenders = collectSourceFiles(srcRoot)
      .filter((filePath) => filePath !== __filename)
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        return source.includes(removedClassName) || source.includes(removedFileName);
      })
      .map((filePath) => relative(srcRoot, filePath))
      .sort();

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(dirPath: string): string[] {
  const entries = readdirSync(dirPath);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(dirPath, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }

    if (/\.(ts|tsx)$/.test(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}
