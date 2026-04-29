import { Test, TestingModule } from '@nestjs/testing';
import { IdentityResolverService } from './identity-resolver.service';
import type { PreviousIdentityState, GitRename } from './identity-resolver.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('IdentityResolverService', () => {
  let resolver: IdentityResolverService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IdentityResolverService],
    }).compile();

    resolver = module.get(IdentityResolverService);
  });

  // -------------------------------------------------------------------------
  // File identity resolution
  // -------------------------------------------------------------------------

  describe('resolveFileIds', () => {
    it('should assign new UUIDs when no previous state exists', () => {
      const ids = resolver.resolveFileIds(['src/main.ts', 'src/app.ts', 'README.md'], null, []);

      expect(ids.size).toBe(3);
      for (const id of ids.values()) {
        expect(id).toMatch(UUID_PATTERN);
      }
      // All IDs must be unique
      expect(new Set(ids.values()).size).toBe(3);
    });

    it('should preserve IDs for unchanged paths', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map([
          ['src/main.ts', 'id-main'],
          ['src/app.ts', 'id-app'],
          ['README.md', 'id-readme'],
        ]),
        districts: new Map(),
        regions: new Map(),
      };

      const ids = resolver.resolveFileIds(['src/main.ts', 'src/app.ts', 'README.md'], previous, []);

      expect(ids.get('src/main.ts')).toBe('id-main');
      expect(ids.get('src/app.ts')).toBe('id-app');
      expect(ids.get('README.md')).toBe('id-readme');
    });

    it('should preserve ID when file is renamed (git-detected)', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map([
          ['src/old-name.ts', 'id-renamed'],
          ['src/unchanged.ts', 'id-unchanged'],
        ]),
        districts: new Map(),
        regions: new Map(),
      };

      const renames: GitRename[] = [
        { oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts', similarity: 95 },
      ];

      const ids = resolver.resolveFileIds(
        ['src/new-name.ts', 'src/unchanged.ts'],
        previous,
        renames,
      );

      expect(ids.get('src/new-name.ts')).toBe('id-renamed');
      expect(ids.get('src/unchanged.ts')).toBe('id-unchanged');
    });

    it('should preserve ID when file is moved to a different directory (git-detected)', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map([['src/utils/helper.ts', 'id-moved']]),
        districts: new Map(),
        regions: new Map(),
      };

      const renames: GitRename[] = [
        { oldPath: 'src/utils/helper.ts', newPath: 'src/lib/helper.ts', similarity: 100 },
      ];

      const ids = resolver.resolveFileIds(['src/lib/helper.ts'], previous, renames);

      expect(ids.get('src/lib/helper.ts')).toBe('id-moved');
    });

    it('should assign new ID for a truly new file', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map([['src/existing.ts', 'id-existing']]),
        districts: new Map(),
        regions: new Map(),
      };

      const ids = resolver.resolveFileIds(['src/existing.ts', 'src/brand-new.ts'], previous, []);

      expect(ids.get('src/existing.ts')).toBe('id-existing');
      expect(ids.get('src/brand-new.ts')).toMatch(UUID_PATTERN);
      expect(ids.get('src/brand-new.ts')).not.toBe('id-existing');
    });

    it('should assign new ID when rename target is unknown in previous state', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(), // empty — previous file not tracked
        districts: new Map(),
        regions: new Map(),
      };

      const renames: GitRename[] = [
        { oldPath: 'ghost.ts', newPath: 'src/file.ts', similarity: 80 },
      ];

      const ids = resolver.resolveFileIds(['src/file.ts'], previous, renames);

      expect(ids.get('src/file.ts')).toMatch(UUID_PATTERN);
    });

    it('should handle shallow history (no rename data) with path-only matching', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'shallow-sha',
        files: new Map([
          ['src/main.ts', 'id-main'],
          ['src/old-name.ts', 'id-old'],
        ]),
        districts: new Map(),
        regions: new Map(),
      };

      // Shallow history → no renames detected
      const ids = resolver.resolveFileIds(['src/main.ts', 'src/new-name.ts'], previous, []);

      // Exact match preserved
      expect(ids.get('src/main.ts')).toBe('id-main');
      // Without rename data, new file gets new ID (not incorrectly reusing old)
      expect(ids.get('src/new-name.ts')).toMatch(UUID_PATTERN);
      expect(ids.get('src/new-name.ts')).not.toBe('id-old');
    });
  });

  // -------------------------------------------------------------------------
  // District identity resolution
  // -------------------------------------------------------------------------

  describe('resolveDistrictIds', () => {
    it('should assign new UUIDs when no previous state exists', () => {
      const ids = resolver.resolveDistrictIds(
        [
          { key: 'src/controllers', memberFileIds: ['f1', 'f2'] },
          { key: 'src/services', memberFileIds: ['f3'] },
        ],
        null,
      );

      expect(ids.size).toBe(2);
      for (const id of ids.values()) {
        expect(id).toMatch(UUID_PATTERN);
      }
      expect(new Set(ids.values()).size).toBe(2);
    });

    it('should preserve ID when district key and majority membership match', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map([
          ['src/controllers', { id: 'district-ctrl', memberFileIds: new Set(['f1', 'f2', 'f3']) }],
        ]),
        regions: new Map(),
      };

      // 2 of 3 old members persist (67% > 50% threshold)
      const ids = resolver.resolveDistrictIds(
        [{ key: 'src/controllers', memberFileIds: ['f1', 'f2', 'f4'] }],
        previous,
      );

      expect(ids.get('src/controllers')).toBe('district-ctrl');
    });

    it('should preserve ID across folder rename via membership match', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map([
          ['src/old-folder', { id: 'district-old', memberFileIds: new Set(['f1', 'f2', 'f3']) }],
        ]),
        regions: new Map(),
      };

      // Key changed (folder renamed), but member file IDs are the same
      const ids = resolver.resolveDistrictIds(
        [{ key: 'src/new-folder', memberFileIds: ['f1', 'f2', 'f3'] }],
        previous,
      );

      expect(ids.get('src/new-folder')).toBe('district-old');
    });

    it('should assign new ID when membership overlap is weak', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map([
          [
            'src/controllers',
            { id: 'district-ctrl', memberFileIds: new Set(['f1', 'f2', 'f3', 'f4']) },
          ],
        ]),
        regions: new Map(),
      };

      // Only 1 of 4 old members persist (25% < 50% threshold)
      const ids = resolver.resolveDistrictIds(
        [{ key: 'src/controllers', memberFileIds: ['f1', 'f5', 'f6', 'f7'] }],
        previous,
      );

      const assignedId = ids.get('src/controllers')!;
      expect(assignedId).toMatch(UUID_PATTERN);
      expect(assignedId).not.toBe('district-ctrl');
    });

    it('should not reuse a previous district ID for two current districts', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map([
          ['src/original', { id: 'district-orig', memberFileIds: new Set(['f1', 'f2']) }],
        ]),
        regions: new Map(),
      };

      // Both new districts share overlap with the old one, but only one should match
      const ids = resolver.resolveDistrictIds(
        [
          { key: 'src/split-a', memberFileIds: ['f1', 'f2'] },
          { key: 'src/split-b', memberFileIds: ['f1', 'f2'] },
        ],
        previous,
      );

      const idA = ids.get('src/split-a')!;
      const idB = ids.get('src/split-b')!;
      // One gets the old ID, the other gets a new one
      expect([idA, idB]).toContain('district-orig');
      const newId = idA === 'district-orig' ? idB : idA;
      expect(newId).toMatch(UUID_PATTERN);
      expect(newId).not.toBe('district-orig');
    });

    it('should handle empty membership sets', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map([['src/empty', { id: 'district-empty', memberFileIds: new Set() }]]),
        regions: new Map(),
      };

      // Both empty → overlap is 1.0 (both empty counts as continuity)
      const ids = resolver.resolveDistrictIds([{ key: 'src/empty', memberFileIds: [] }], previous);

      expect(ids.get('src/empty')).toBe('district-empty');
    });
  });

  // -------------------------------------------------------------------------
  // Region identity resolution
  // -------------------------------------------------------------------------

  describe('resolveRegionIds', () => {
    it('should assign new UUIDs when no previous state exists', () => {
      const ids = resolver.resolveRegionIds(['apps', 'packages'], null);

      expect(ids.size).toBe(2);
      for (const id of ids.values()) {
        expect(id).toMatch(UUID_PATTERN);
      }
    });

    it('should preserve IDs for unchanged region names', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map(),
        regions: new Map([
          ['apps', 'region-apps'],
          ['packages', 'region-packages'],
        ]),
      };

      const ids = resolver.resolveRegionIds(['apps', 'packages'], previous);

      expect(ids.get('apps')).toBe('region-apps');
      expect(ids.get('packages')).toBe('region-packages');
    });

    it('should assign new ID for a new region', () => {
      const previous: PreviousIdentityState = {
        commitSha: 'abc',
        files: new Map(),
        districts: new Map(),
        regions: new Map([['apps', 'region-apps']]),
      };

      const ids = resolver.resolveRegionIds(['apps', 'tools'], previous);

      expect(ids.get('apps')).toBe('region-apps');
      expect(ids.get('tools')).toMatch(UUID_PATTERN);
    });
  });
});
