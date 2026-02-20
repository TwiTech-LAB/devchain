import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { getEnvConfig } from './config/env.config';

interface ResolveTemplatesDirectoryOptions {
  cwd?: string;
  envTemplatesDir?: string | null;
  existsSyncFn?: (path: string) => boolean;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const path of paths) {
    const normalizedPath = resolve(path);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    deduped.push(normalizedPath);
  }

  return deduped;
}

export function buildTemplatesDirectoryCandidates(fromDirectory: string, cwd: string): string[] {
  return dedupePaths([
    // Docker container build layout: dist/modules/*/services -> dist/templates
    join(fromDirectory, '..', '..', '..', 'templates'),
    // Dev + npm-pack layouts:
    // src/modules/*/services -> templates OR dist/server/modules/*/services -> dist/templates
    join(fromDirectory, '..', '..', '..', '..', 'templates'),
    // CWD-based fallbacks
    join(cwd, 'templates'),
    join(cwd, 'dist', 'templates'),
    join(cwd, 'apps', 'local-app', 'templates'),
    join(cwd, 'apps', 'local-app', 'dist', 'templates'),
  ]);
}

export function resolveTemplatesDirectory(
  fromDirectory: string,
  options: ResolveTemplatesDirectoryOptions = {},
): string | null {
  const pathExists = options.existsSyncFn ?? existsSync;
  const envTemplatesDir = trimOrNull(options.envTemplatesDir ?? getEnvConfig().TEMPLATES_DIR);

  if (envTemplatesDir) {
    const resolvedEnvPath = resolve(envTemplatesDir);
    if (pathExists(resolvedEnvPath)) {
      return resolvedEnvPath;
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const candidates = buildTemplatesDirectoryCandidates(fromDirectory, cwd);

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}
