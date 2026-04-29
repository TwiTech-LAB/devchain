import { Test } from '@nestjs/testing';
import { ScopeResolverService } from './scope-resolver.service';
import { BUILT_IN_SCOPE_DEFAULTS } from '../types/scope-defaults';
import type { FolderScopeEntry } from '../types/scope.types';

describe('ScopeResolverService', () => {
  let service: ScopeResolverService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [ScopeResolverService],
    }).compile();

    service = module.get(ScopeResolverService);
  });

  describe('resolve', () => {
    it('returns all defaults when no user entries', () => {
      const result = service.resolve([]);
      expect(result).toEqual(BUILT_IN_SCOPE_DEFAULTS);
    });

    it('overrides matching default with user entry', () => {
      const userEntry: FolderScopeEntry = {
        folder: 'dist',
        purpose: 'generated',
        reason: 'User override',
        origin: 'user',
      };

      const result = service.resolve([userEntry]);

      const distEntry = result.find((e) => e.folder === 'dist');
      expect(distEntry).toEqual(userEntry);

      const nodeModules = result.find((e) => e.folder === 'node_modules');
      expect(nodeModules?.purpose).toBe('excluded');
      expect(nodeModules?.origin).toBe('default');
    });

    it('appends user entries for folders not in defaults', () => {
      const userEntry: FolderScopeEntry = {
        folder: 'build',
        purpose: 'generated',
        reason: 'User override',
        origin: 'user',
      };

      const result = service.resolve([userEntry]);

      expect(result).toHaveLength(BUILT_IN_SCOPE_DEFAULTS.length + 1);
      expect(result.find((e) => e.folder === 'build')).toEqual(userEntry);
    });

    it('all-override replaces every default', () => {
      const userEntries: FolderScopeEntry[] = BUILT_IN_SCOPE_DEFAULTS.map((d) => ({
        folder: d.folder,
        purpose: 'source' as const,
        reason: 'User override',
        origin: 'user' as const,
      }));

      const result = service.resolve(userEntries);

      expect(result).toHaveLength(BUILT_IN_SCOPE_DEFAULTS.length);
      for (const entry of result) {
        expect(entry.origin).toBe('user');
        expect(entry.purpose).toBe('source');
      }
    });

    it('mixed: some overridden, some default', () => {
      const userEntries: FolderScopeEntry[] = [
        { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
        { folder: 'build', purpose: 'excluded', reason: 'User override', origin: 'user' },
      ];

      const result = service.resolve(userEntries);

      expect(result.find((e) => e.folder === 'dist')?.origin).toBe('user');
      expect(result.find((e) => e.folder === 'node_modules')?.origin).toBe('default');
      expect(result.find((e) => e.folder === 'build')?.origin).toBe('user');
    });

    it('three-source merge: built-in < auto-detected < user', () => {
      const autoDetected: FolderScopeEntry[] = [
        { folder: 'coverage', purpose: 'excluded', reason: 'Auto-detected', origin: 'default' },
        { folder: 'gen', purpose: 'generated', reason: 'Auto-detected', origin: 'default' },
      ];
      const userEntries: FolderScopeEntry[] = [
        { folder: 'gen', purpose: 'source', reason: 'User override', origin: 'user' },
      ];

      const result = service.resolve(userEntries, autoDetected);

      // auto-detected coverage kept (no user override)
      const coverage = result.find((e) => e.folder === 'coverage');
      expect(coverage?.purpose).toBe('excluded');
      expect(coverage?.reason).toBe('Auto-detected');

      // user override wins over auto-detected for gen
      const gen = result.find((e) => e.folder === 'gen');
      expect(gen?.purpose).toBe('source');
      expect(gen?.origin).toBe('user');

      // built-in defaults still present
      expect(result.find((e) => e.folder === 'node_modules')?.purpose).toBe('excluded');
    });

    it('auto-detected entries override built-in defaults for same folder', () => {
      const autoDetected: FolderScopeEntry[] = [
        { folder: 'dist', purpose: 'generated', reason: 'Auto-detected', origin: 'default' },
      ];

      const result = service.resolve([], autoDetected);

      const dist = result.find((e) => e.folder === 'dist');
      expect(dist?.purpose).toBe('generated');
      expect(dist?.reason).toBe('Auto-detected');
    });
  });

  describe('getExcludedFolders', () => {
    it('filters only excluded entries', () => {
      const entries: FolderScopeEntry[] = [
        { folder: 'src', purpose: 'source', reason: '', origin: 'user' },
        { folder: 'node_modules', purpose: 'excluded', reason: '', origin: 'default' },
        { folder: 'dist', purpose: 'excluded', reason: '', origin: 'default' },
        { folder: '__tests__', purpose: 'test-source', reason: '', origin: 'user' },
      ];

      expect(service.getExcludedFolders(entries)).toEqual(['node_modules', 'dist']);
    });

    it('returns empty for no excluded entries', () => {
      const entries: FolderScopeEntry[] = [
        { folder: 'src', purpose: 'source', reason: '', origin: 'user' },
      ];

      expect(service.getExcludedFolders(entries)).toEqual([]);
    });
  });

  describe('getGeneratedFolders', () => {
    it('filters only generated entries', () => {
      const entries: FolderScopeEntry[] = [
        { folder: 'src', purpose: 'source', reason: '', origin: 'user' },
        { folder: 'dist', purpose: 'generated', reason: '', origin: 'user' },
        { folder: '.next', purpose: 'generated', reason: '', origin: 'user' },
        { folder: 'node_modules', purpose: 'excluded', reason: '', origin: 'default' },
      ];

      expect(service.getGeneratedFolders(entries)).toEqual(['dist', '.next']);
    });

    it('returns empty for no generated entries', () => {
      const entries: FolderScopeEntry[] = [
        { folder: 'src', purpose: 'source', reason: '', origin: 'user' },
      ];

      expect(service.getGeneratedFolders(entries)).toEqual([]);
    });
  });
});
