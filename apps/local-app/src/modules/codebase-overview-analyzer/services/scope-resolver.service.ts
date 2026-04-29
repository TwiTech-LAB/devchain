import { Injectable } from '@nestjs/common';
import { BUILT_IN_SCOPE_DEFAULTS } from '../types/scope-defaults';
import type { FolderScopeEntry } from '../types/scope.types';

@Injectable()
export class ScopeResolverService {
  /**
   * Merge three scope sources with ascending precedence:
   *   built-in defaults < autoDetected < userEntries
   *
   * Same folder in a higher-precedence layer replaces the lower one entirely.
   */
  resolve(
    userEntries: FolderScopeEntry[],
    autoDetected: FolderScopeEntry[] = [],
  ): FolderScopeEntry[] {
    const byFolder = new Map<string, FolderScopeEntry>();

    for (const entry of BUILT_IN_SCOPE_DEFAULTS) {
      byFolder.set(entry.folder, entry);
    }
    for (const entry of autoDetected) {
      byFolder.set(entry.folder, entry);
    }
    for (const entry of userEntries) {
      byFolder.set(entry.folder, entry);
    }

    return [...byFolder.values()];
  }

  getExcludedFolders(resolved: FolderScopeEntry[]): string[] {
    return resolved.filter((e) => e.purpose === 'excluded').map((e) => e.folder);
  }

  getGeneratedFolders(resolved: FolderScopeEntry[]): string[] {
    return resolved.filter((e) => e.purpose === 'generated').map((e) => e.folder);
  }
}
