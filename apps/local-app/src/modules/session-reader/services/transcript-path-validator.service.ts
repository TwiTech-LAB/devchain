import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { ValidationError } from '../../../common/errors/error-types';

/** Control character regex (C0 controls except tab/newline/carriage-return) */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** URL-encoded traversal patterns */
const ENCODED_TRAVERSAL_RE = /%2e%2e/i;

/**
 * Provider-specific allowed root directories for transcript files.
 * Each root is relative to the user's home directory.
 */
const PROVIDER_ROOTS: Record<string, string[]> = {
  claude: ['.claude/projects/'],
  codex: ['.codex/sessions/'],
  gemini: ['.gemini/tmp/'],
};

@Injectable()
export class TranscriptPathValidator {
  private readonly homeDir: string;
  private readonly resolvedRoots: Map<string, string[]>;

  constructor() {
    this.homeDir = os.homedir();
    this.resolvedRoots = new Map();
    for (const [provider, roots] of Object.entries(PROVIDER_ROOTS)) {
      this.resolvedRoots.set(
        provider,
        roots.map((r) => path.join(this.homeDir, r)),
      );
    }
  }

  /**
   * Validate path shape and root prefix at persistence time.
   * Does NOT require the file to exist.
   *
   * @returns Normalized absolute path
   * @throws ValidationError on invalid path
   */
  validateShape(inputPath: string, providerName: string): string {
    if (!inputPath || typeof inputPath !== 'string') {
      throw new ValidationError('Transcript path must be a non-empty string');
    }

    const provider = providerName.toLowerCase();
    const allowedRoots = this.resolvedRoots.get(provider);
    if (!allowedRoots) {
      const supported = Array.from(this.resolvedRoots.keys()).join(', ');
      throw new ValidationError(`Unknown provider "${providerName}". Supported: ${supported}`, {
        providerName,
        supportedProviders: Array.from(this.resolvedRoots.keys()),
      });
    }

    // Reject null bytes
    if (inputPath.includes('\0')) {
      throw new ValidationError('Transcript path contains null bytes', {
        path: inputPath,
      });
    }

    // Reject control characters
    if (CONTROL_CHAR_RE.test(inputPath)) {
      throw new ValidationError('Transcript path contains control characters', {
        path: inputPath,
      });
    }

    // Reject URL-encoded traversal
    if (ENCODED_TRAVERSAL_RE.test(inputPath)) {
      throw new ValidationError('Transcript path contains encoded traversal pattern', {
        path: inputPath,
      });
    }

    // Resolve ~ to home directory
    let resolved = inputPath;
    if (resolved.startsWith('~/')) {
      resolved = path.join(this.homeDir, resolved.slice(2));
    } else if (resolved === '~') {
      resolved = this.homeDir;
    }

    // Normalize to absolute path
    resolved = path.resolve(resolved);

    // Reject directory traversal after normalization
    // path.resolve already collapses .. but we verify the result stays within roots
    const withinRoot = allowedRoots.some((root) => resolved.startsWith(root));
    if (!withinRoot) {
      throw new ValidationError(
        'Transcript path is outside allowed root directories for this provider',
        { path: inputPath, provider, allowedRoots },
      );
    }

    return resolved;
  }

  /**
   * Phase 2 extension: validate for actual file reading.
   * Adds fs.realpath symlink resolution and existence check.
   *
   * @returns Real (symlink-resolved) absolute path
   * @throws ValidationError on invalid/missing file
   */
  async validateForRead(inputPath: string, providerName: string): Promise<string> {
    // First pass shape validation
    const normalized = this.validateShape(inputPath, providerName);

    // Resolve symlinks to real path
    let realPath: string;
    try {
      realPath = await fs.realpath(normalized);
    } catch {
      throw new ValidationError('Transcript file does not exist or is not accessible', {
        category: 'file-access',
        path: normalized,
      });
    }

    // Re-validate the resolved real path against allowed roots
    const provider = providerName.toLowerCase();
    const allowedRoots = this.resolvedRoots.get(provider)!;
    const withinRoot = allowedRoots.some((root) => realPath.startsWith(root));
    if (!withinRoot) {
      throw new ValidationError(
        'Transcript real path (after symlink resolution) is outside allowed root directories',
        { category: 'file-access', path: inputPath, realPath, provider, allowedRoots },
      );
    }

    // Check file existence and size
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(realPath);
    } catch {
      throw new ValidationError('Transcript file does not exist or is not accessible', {
        category: 'file-access',
        path: realPath,
      });
    }

    if (!stat.isFile()) {
      throw new ValidationError('Transcript path is not a regular file', {
        category: 'file-access',
        path: realPath,
      });
    }

    return realPath;
  }
}
