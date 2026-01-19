import { resolve, relative, isAbsolute, normalize, sep, dirname } from 'path';
import { realpath, lstat } from 'fs/promises';
import { ValidationError } from '../errors/error-types';

/**
 * Result of path validation containing the safe, normalized path.
 */
export interface ValidatedPath {
  /** The absolute path within the root directory */
  absolutePath: string;
  /** The relative path from the root directory */
  relativePath: string;
}

/**
 * Options for path validation.
 */
export interface PathValidationOptions {
  /** Allow paths that don't exist yet (for write operations) */
  allowNonExistent?: boolean;
  /** Custom error message prefix */
  errorPrefix?: string;
}

/**
 * Validates that a file path is safely within a root directory.
 * Protects against path traversal attacks (synchronous check).
 *
 * Security checks performed:
 * 1. Rejects absolute paths (must be relative to root)
 * 2. Rejects paths containing '..' segments
 * 3. Rejects paths starting with '/' or '\'
 * 4. Uses path.relative to verify containment (not startsWith)
 *
 * NOTE: This function does NOT resolve symlinks. For operations on existing files
 * where symlinks could escape the root, use validateResolvedPathWithinRoot() after
 * this function to verify the real path after symlink resolution.
 *
 * @param rootPath - The trusted root directory (must be absolute)
 * @param filePath - The untrusted file path to validate
 * @param options - Validation options
 * @returns ValidatedPath with safe absolute and relative paths
 * @throws ValidationError if the path is unsafe or escapes the root
 *
 * @example
 * // Valid paths
 * validatePathWithinRoot('/project', 'src/file.ts') // OK
 * validatePathWithinRoot('/project', 'src/nested/file.ts') // OK
 *
 * // Invalid paths (throws ValidationError)
 * validatePathWithinRoot('/project', '../etc/passwd') // Throws
 * validatePathWithinRoot('/project', '/etc/passwd') // Throws
 * validatePathWithinRoot('/project', 'src/../../etc/passwd') // Throws
 */
export function validatePathWithinRoot(
  rootPath: string,
  filePath: string,
  options: PathValidationOptions = {},
): ValidatedPath {
  const errorPrefix = options.errorPrefix ?? 'Path validation failed';

  // Reject null/undefined/empty
  if (!filePath || typeof filePath !== 'string') {
    throw new ValidationError(`${errorPrefix}: File path is required`, {
      filePath,
      rootPath,
    });
  }

  // Reject absolute paths - they should always be relative to root
  if (isAbsolute(filePath)) {
    throw new ValidationError(`${errorPrefix}: Absolute paths are not allowed`, {
      filePath,
      rootPath,
      reason: 'absolute_path',
    });
  }

  // Reject paths that start with / or \ (additional check for edge cases)
  if (filePath.startsWith('/') || filePath.startsWith('\\')) {
    throw new ValidationError(`${errorPrefix}: Path cannot start with path separator`, {
      filePath,
      rootPath,
      reason: 'leading_separator',
    });
  }

  // Normalize the path to handle any OS-specific separators
  const normalizedPath = normalize(filePath);

  // Reject paths containing '..' segments before resolution
  // This catches attempts like 'foo/../../../etc/passwd'
  const segments = normalizedPath.split(sep);
  if (segments.includes('..')) {
    throw new ValidationError(`${errorPrefix}: Path traversal sequences (..) are not allowed`, {
      filePath,
      normalizedPath,
      rootPath,
      reason: 'path_traversal',
    });
  }

  // Also check for '..' with forward slashes (cross-platform)
  if (normalizedPath.includes('../') || normalizedPath.includes('..\\')) {
    throw new ValidationError(`${errorPrefix}: Path traversal sequences (..) are not allowed`, {
      filePath,
      normalizedPath,
      rootPath,
      reason: 'path_traversal',
    });
  }

  // Ensure root path is absolute
  const resolvedRoot = resolve(rootPath);

  // Resolve the full path (this also normalizes)
  const absolutePath = resolve(resolvedRoot, normalizedPath);

  // Use path.relative to compute the relationship
  // If the result starts with '..' or is absolute, the path escapes the root
  const relativePath = relative(resolvedRoot, absolutePath);

  // Check 1: relative path should not start with '..'
  if (relativePath.startsWith('..')) {
    throw new ValidationError(`${errorPrefix}: Path escapes the root directory`, {
      filePath,
      absolutePath,
      rootPath: resolvedRoot,
      relativePath,
      reason: 'escapes_root',
    });
  }

  // Check 2: relative path should not be absolute (Windows edge case)
  if (isAbsolute(relativePath)) {
    throw new ValidationError(`${errorPrefix}: Path is on a different drive or mount`, {
      filePath,
      absolutePath,
      rootPath: resolvedRoot,
      relativePath,
      reason: 'different_mount',
    });
  }

  // Check 3: Final absolute path should still be under root after resolution
  // This catches symlink escapes and other edge cases
  // Using startsWith with trailing separator to avoid /root-other matching /root
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!absolutePath.startsWith(rootWithSep) && absolutePath !== resolvedRoot) {
    throw new ValidationError(`${errorPrefix}: Resolved path is outside root directory`, {
      filePath,
      absolutePath,
      rootPath: resolvedRoot,
      reason: 'outside_root',
    });
  }

  return {
    absolutePath,
    relativePath,
  };
}

/**
 * Validates line bounds are within a reasonable range.
 *
 * @param lineStart - Starting line number (1-indexed)
 * @param lineEnd - Ending line number (1-indexed), must be >= lineStart
 * @param totalLines - Total number of lines in the file
 * @throws ValidationError if line bounds are invalid
 */
export function validateLineBounds(lineStart: number, lineEnd: number, totalLines: number): void {
  if (!Number.isInteger(lineStart) || lineStart < 1) {
    throw new ValidationError('Line start must be a positive integer', {
      lineStart,
      lineEnd,
      totalLines,
    });
  }

  if (!Number.isInteger(lineEnd) || lineEnd < 1) {
    throw new ValidationError('Line end must be a positive integer', {
      lineStart,
      lineEnd,
      totalLines,
    });
  }

  if (lineEnd < lineStart) {
    throw new ValidationError('Line end cannot be less than line start', {
      lineStart,
      lineEnd,
      totalLines,
    });
  }

  if (lineStart > totalLines) {
    throw new ValidationError('Line start exceeds file length', {
      lineStart,
      lineEnd,
      totalLines,
    });
  }

  if (lineEnd > totalLines) {
    throw new ValidationError('Line end exceeds file length', {
      lineStart,
      lineEnd,
      totalLines,
    });
  }
}

/**
 * Validates that a path (after symlink resolution) is within the root directory.
 * SECURITY: This function resolves symlinks using fs.realpath() to prevent symlink escape attacks.
 *
 * Use this function AFTER validatePathWithinRoot() for operations on existing files
 * where symlinks could redirect to locations outside the project root.
 *
 * @param absolutePath - The absolute path to validate (from validatePathWithinRoot)
 * @param rootPath - The trusted root directory
 * @param options - Validation options
 * @returns The real path after symlink resolution
 * @throws ValidationError if the resolved path escapes the root or symlink target doesn't exist
 *
 * @example
 * const validated = validatePathWithinRoot('/project', 'src/file.ts');
 * const realPath = await validateResolvedPathWithinRoot(validated.absolutePath, '/project');
 * // Now safe to read/write to realPath
 */
export async function validateResolvedPathWithinRoot(
  absolutePath: string,
  rootPath: string,
  options: PathValidationOptions = {},
): Promise<string> {
  const errorPrefix = options.errorPrefix ?? 'Symlink validation failed';
  const resolvedRoot = resolve(rootPath);

  const assertWithinRoot = (pathToCheck: string) => {
    const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    if (!pathToCheck.startsWith(rootWithSep) && pathToCheck !== resolvedRoot) {
      throw new ValidationError(`${errorPrefix}: Symlink escapes the root directory`, {
        path: absolutePath,
        realPath: pathToCheck,
        rootPath: resolvedRoot,
        reason: 'symlink_escape',
      });
    }

    const relativePath = relative(resolvedRoot, pathToCheck);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new ValidationError(`${errorPrefix}: Symlink target is outside root directory`, {
        path: absolutePath,
        realPath: pathToCheck,
        rootPath: resolvedRoot,
        relativePath,
        reason: 'symlink_escape',
      });
    }
  };

  // Detect dangling symlinks explicitly: lstat succeeds for the symlink itself even if target is missing.
  let isSymlink = false;
  try {
    const stats = await lstat(absolutePath);
    isSymlink = stats.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Ignore: file may not exist yet.
      // We'll handle this after attempting realpath().
    } else {
      throw error;
    }
  }

  try {
    const realPath = await realpath(absolutePath);
    assertWithinRoot(realPath);
    return realPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    // If the leaf is a symlink but the target is missing, always reject it.
    if (isSymlink) {
      throw new ValidationError(`${errorPrefix}: Symlink target does not exist`, {
        path: absolutePath,
        rootPath: resolvedRoot,
        reason: 'symlink_target_missing',
      });
    }

    // If caller intends to create a new file, validate the nearest existing ancestor after symlink resolution
    // to prevent writes via a symlinked directory that escapes the root.
    if (options.allowNonExistent) {
      let current = dirname(absolutePath);
      // Walk up until we find an existing path we can resolve.
      while (true) {
        try {
          const resolvedAncestor = await realpath(current);
          const tail = relative(current, absolutePath);
          const candidatePath = resolve(resolvedAncestor, tail);
          assertWithinRoot(candidatePath);
          return candidatePath;
        } catch (ancestorError) {
          if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw ancestorError;
          }
          const parent = dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    }

    // File doesn't exist; caller can handle this (e.g., readFile will throw ENOENT).
    return absolutePath;
  }
}
