import { ScopeAutoDetectorService } from './scope-auto-detector.service';

describe('ScopeAutoDetectorService', () => {
  const detector = new ScopeAutoDetectorService();

  describe('generated folders', () => {
    it.each(['generated', '__generated__', 'gen', '.generated', 'codegen'])(
      'detects %s as generated',
      (folder) => {
        const entries = detector.detect([folder]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ folder, purpose: 'generated', origin: 'default' });
      },
    );
  });

  describe('test-source folders', () => {
    it.each([
      'test',
      'tests',
      'spec',
      'specs',
      '__tests__',
      '__mocks__',
      'mocks',
      'fixtures',
      'e2e',
    ])('detects %s as test-source', (folder) => {
      const entries = detector.detect([folder]);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ folder, purpose: 'test-source' });
    });
  });

  describe('excluded folders', () => {
    it.each([
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
    ])('detects %s as excluded', (folder) => {
      const entries = detector.detect([folder]);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ folder, purpose: 'excluded' });
    });
  });

  describe('resources folders', () => {
    it.each(['assets', 'resources', 'static', 'public', 'media', 'locales', 'i18n'])(
      'detects %s as resources',
      (folder) => {
        const entries = detector.detect([folder]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ folder, purpose: 'resources' });
      },
    );
  });

  it('returns empty for unrecognized folders', () => {
    expect(detector.detect(['src', 'lib', 'app', 'packages'])).toEqual([]);
  });

  it('is case-insensitive on last path segment', () => {
    const entries = detector.detect(['Build', 'DIST', 'Tests']);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.purpose)).toEqual(
      expect.arrayContaining(['excluded', 'excluded', 'test-source']),
    );
  });

  it('sets reason to Auto-detected', () => {
    const entries = detector.detect(['dist']);
    expect(entries[0]!.reason).toBe('Auto-detected');
  });

  it('handles nested paths using last segment', () => {
    const entries = detector.detect(['src/generated', 'pkg/tests']);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ folder: 'src/generated', purpose: 'generated' });
    expect(entries[1]).toMatchObject({ folder: 'pkg/tests', purpose: 'test-source' });
  });
});
