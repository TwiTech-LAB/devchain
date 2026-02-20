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

  it('resolves dev runtime layout: src/modules/*/services -> templates', () => {
    const fromDirectory = '/repo/apps/local-app/src/modules/projects/services';
    const expected = '/repo/apps/local-app/templates';
    const existsSyncFn = jest.fn((path: string) => path === expected);

    const result = resolveTemplatesDirectory(fromDirectory, {
      envTemplatesDir: null,
      cwd: '/repo',
      existsSyncFn,
    });

    expect(result).toBe(expected);
  });

  it('resolves npm-pack runtime layout: dist/server/modules/*/services -> dist/templates', () => {
    const fromDirectory = '/repo/apps/local-app/dist/server/modules/projects/services';
    const expected = '/repo/apps/local-app/dist/templates';
    const existsSyncFn = jest.fn((path: string) => path === expected);

    const result = resolveTemplatesDirectory(fromDirectory, {
      envTemplatesDir: null,
      cwd: '/repo',
      existsSyncFn,
    });

    expect(result).toBe(expected);
  });

  it('resolves docker runtime layout: dist/modules/*/services -> dist/templates', () => {
    const fromDirectory = '/app/apps/local-app/dist/modules/registry/services';
    const expected = '/app/apps/local-app/dist/templates';
    const existsSyncFn = jest.fn((path: string) => path === expected);

    const result = resolveTemplatesDirectory(fromDirectory, {
      envTemplatesDir: null,
      cwd: '/app',
      existsSyncFn,
    });

    expect(result).toBe(expected);
  });

  it('falls back to known cwd candidates when relative traversal misses', () => {
    const fromDirectory = '/tmp/unknown/layout/services';
    const expected = '/workspace/apps/local-app/dist/templates';
    const existsSyncFn = jest.fn((path: string) => path === expected);

    const result = resolveTemplatesDirectory(fromDirectory, {
      envTemplatesDir: null,
      cwd: '/workspace',
      existsSyncFn,
    });

    expect(result).toBe(expected);
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
