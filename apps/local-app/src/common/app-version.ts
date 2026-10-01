import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Reads the root `devchain-cli` package version, trying dev- and dist-mode relative paths first. */
export function getAppVersion(): string {
  try {
    const possiblePaths = [
      // Published package: <package>/dist/server/common
      join(__dirname, '..', '..', '..', 'package.json'),
      join(__dirname, '..', '..', '..', '..', 'package.json'),
      join(__dirname, '..', '..', '..', '..', '..', 'package.json'),
      join(process.cwd(), 'package.json'),
    ];

    for (const pkgPath of possiblePaths) {
      if (!existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === 'devchain-cli' && pkg.version) {
        return pkg.version;
      }
    }
  } catch {
    // Ignore lookup errors.
  }

  return 'unknown';
}
