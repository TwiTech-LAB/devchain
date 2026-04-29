import { Injectable } from '@nestjs/common';
import type { FolderPurpose, FolderScopeEntry } from '../types/scope.types';

const FOLDER_HEURISTICS: Array<{ names: Set<string>; purpose: FolderPurpose }> = [
  {
    names: new Set(['generated', '__generated__', 'gen', '.generated', 'codegen']),
    purpose: 'generated',
  },
  {
    names: new Set([
      'test',
      'tests',
      'spec',
      'specs',
      '__tests__',
      '__mocks__',
      'mocks',
      'fixtures',
      'e2e',
    ]),
    purpose: 'test-source',
  },
  {
    names: new Set([
      'dist',
      'build',
      'out',
      'output',
      '.next',
      '.nuxt',
      'coverage',
      '.cache',
      'tmp',
      'temp',
    ]),
    purpose: 'excluded',
  },
  {
    names: new Set(['assets', 'resources', 'static', 'public', 'media', 'locales', 'i18n']),
    purpose: 'resources',
  },
];

@Injectable()
export class ScopeAutoDetectorService {
  detect(observedFolders: string[]): FolderScopeEntry[] {
    const entries: FolderScopeEntry[] = [];

    for (const folder of observedFolders) {
      const segment = folder.split('/').pop()!.toLowerCase();
      const match = FOLDER_HEURISTICS.find((h) => h.names.has(segment));
      if (match) {
        entries.push({
          folder,
          purpose: match.purpose,
          reason: 'Auto-detected',
          origin: 'default',
        });
      }
    }

    return entries;
  }
}
