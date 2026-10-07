import { resolve } from 'path';
import {
  buildTemplatesDirectoryCandidates,
  resolveTemplatesDirectory,
} from './templates-directory';

describe('resolveTemplatesDirectory', () => {
  it('uses TEMPLATES_DIR when it exists', () => {
    const existsSyncFn = jest.fn((path: string) => path === '/custom/templates');

    const result = resolveTemplatesDirectory('/repo/apps/local-app/src/modules/projects/services', {
      envTemplatesDir: '/custom/templates',
      existsSyncFn,
    });

    expect(result).toBe('/custom/templates');
  });

  it.each([
    {
      label: 'dev',
      fromDirectory: '/repo/apps/local-app/src/modules/projects/services',
      expected: '/repo/apps/local-app/templates',
      cwd: '/repo',
    },
    {
      label: 'docker',
      fromDirectory: '/app/apps/local-app/dist/modules/registry/services',
      expected: '/app/apps/local-app/dist/templates',
      cwd: '/app',
    },
    {
      label: 'fallback',
      fromDirectory: '/tmp/unknown/layout/services',
      expected: '/workspace/apps/local-app/dist/templates',
      cwd: '/workspace',
    },
  ])('resolves $label template layout', ({ fromDirectory, expected, cwd }) => {
    expect(
      resolveTemplatesDirectory(fromDirectory, {
        envTemplatesDir: null,
        cwd,
        existsSyncFn: (path) => path === expected,
      }),
    ).toBe(expected);
  });

  it('returns null when no candidate exists', () => {
    const result = resolveTemplatesDirectory('/repo/apps/local-app/src/modules/projects/services', {
      envTemplatesDir: null,
      cwd: '/repo',
      existsSyncFn: () => false,
    });

    expect(result).toBeNull();
  });
});

describe('buildTemplatesDirectoryCandidates', () => {
  it('returns stable, deduplicated absolute candidates', () => {
    const candidates = buildTemplatesDirectoryCandidates(
      '/repo/apps/local-app/src/modules/projects/services',
      '/repo/apps/local-app',
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toBe(
      resolve('/repo/apps/local-app/src/modules/projects/services', '..', '..', '..', 'templates'),
    );
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
