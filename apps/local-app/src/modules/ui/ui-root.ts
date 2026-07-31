import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export function resolveUiRoot(runtimeDirectory = __dirname): string {
  const candidates = [
    join(runtimeDirectory, '../../ui'),
    join(runtimeDirectory, '../../../dist/ui'),
  ];

  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? candidates[0];
}

export function hasUiBuild(root: string): boolean {
  return existsSync(join(root, 'index.html'));
}

export function resolveUiAssetPaths(root: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const assetsRoot = join(root, 'assets');

  if (existsSync(assetsRoot)) {
    for (const entry of readdirSync(assetsRoot, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.startsWith('.')) {
        paths.add(`assets/${entry.name}`);
      }
    }
  }

  if (existsSync(join(root, 'favicon.svg'))) {
    paths.add('favicon.svg');
  }

  return paths;
}
