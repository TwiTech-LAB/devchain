import { isUnderFolder, isUnderAnyFolder } from './path-matcher';

describe('isUnderFolder', () => {
  describe('top-level folders', () => {
    it('matches a file directly inside a top-level folder', () => {
      expect(isUnderFolder('dist/bundle.js', 'dist')).toBe(true);
    });

    it('matches a file nested several levels inside a top-level folder', () => {
      expect(isUnderFolder('node_modules/foo/bar/index.js', 'node_modules')).toBe(true);
    });

    it('matches when filePath exactly equals the folder', () => {
      expect(isUnderFolder('dist', 'dist')).toBe(true);
    });

    it('does not match a sibling folder sharing a prefix', () => {
      expect(isUnderFolder('dist-legacy/out.js', 'dist')).toBe(false);
    });

    it('does not match an unrelated top-level file', () => {
      expect(isUnderFolder('README.md', 'dist')).toBe(false);
    });
  });

  describe('nested folders', () => {
    it('matches a file inside a nested folder', () => {
      expect(isUnderFolder('src/generated/model.ts', 'src/generated')).toBe(true);
    });

    it('matches when filePath exactly equals the nested folder', () => {
      expect(isUnderFolder('src/generated', 'src/generated')).toBe(true);
    });

    it('matches a deeply nested file', () => {
      expect(isUnderFolder('packages/foo/dist/cjs/index.js', 'packages/foo/dist')).toBe(true);
    });

    it('does not match a sibling that shares a prefix (no false positive)', () => {
      expect(isUnderFolder('srcGenerated/foo.ts', 'src/generated')).toBe(false);
    });

    it('does not match a folder that starts the same but has extra chars', () => {
      expect(isUnderFolder('src/generatedExtra/a.ts', 'src/generated')).toBe(false);
    });

    it('does not match the parent directory', () => {
      expect(isUnderFolder('src/other/file.ts', 'src/generated')).toBe(false);
    });
  });

  describe('trailing slash handling', () => {
    it('treats folder with trailing slash the same as without', () => {
      expect(isUnderFolder('dist/bundle.js', 'dist/')).toBe(true);
    });

    it('treats folder with multiple trailing slashes the same as without', () => {
      expect(isUnderFolder('src/generated/a.ts', 'src/generated//')).toBe(true);
    });
  });

  describe('mixed path separators (Windows backslash)', () => {
    it('normalises backslash in filePath', () => {
      expect(isUnderFolder('dist\\bundle.js', 'dist')).toBe(true);
    });

    it('normalises backslash in folder', () => {
      expect(isUnderFolder('src/generated/a.ts', 'src\\generated')).toBe(true);
    });

    it('normalises backslash in both inputs', () => {
      expect(isUnderFolder('src\\generated\\model.ts', 'src\\generated')).toBe(true);
    });

    it('no false positive with mixed separators and prefix sibling', () => {
      expect(isUnderFolder('src\\generatedExtra\\a.ts', 'src/generated')).toBe(false);
    });
  });
});

describe('isUnderAnyFolder', () => {
  it('returns true when filePath is under one of the folders in an array', () => {
    expect(isUnderAnyFolder('dist/bundle.js', ['node_modules', 'dist', '.cache'])).toBe(true);
  });

  it('returns false when filePath is under none of the folders in an array', () => {
    expect(isUnderAnyFolder('src/app.ts', ['node_modules', 'dist'])).toBe(false);
  });

  it('accepts a ReadonlySet', () => {
    const folders = new Set(['node_modules', 'src/generated']);
    expect(isUnderAnyFolder('src/generated/model.ts', folders)).toBe(true);
  });

  it('returns false for a Set that does not match', () => {
    const folders = new Set(['dist', 'build']);
    expect(isUnderAnyFolder('src/app.ts', folders)).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(isUnderAnyFolder('dist/bundle.js', [])).toBe(false);
  });

  it('returns false for an empty set', () => {
    expect(isUnderAnyFolder('dist/bundle.js', new Set<string>())).toBe(false);
  });

  it('short-circuits on first match (nested folder)', () => {
    expect(
      isUnderAnyFolder('vendor/third_party/lib.js', ['src/generated', 'vendor/third_party']),
    ).toBe(true);
  });

  it('does not produce false positives on prefix-only matches', () => {
    expect(isUnderAnyFolder('src/generatedStuff/a.ts', ['src/generated'])).toBe(false);
  });
});
