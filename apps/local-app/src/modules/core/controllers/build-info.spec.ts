import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo } from './build-info';

describe('readBuildInfo', () => {
  const directory = mkdtempSync(join(tmpdir(), 'devchain-build-info-'));
  const file = join(directory, 'build-info.json');

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('returns null when the stamp is missing', () => {
    expect(readBuildInfo(file)).toBeNull();
  });

  it('returns null for malformed JSON or stamp fields', () => {
    writeFileSync(file, '{');
    expect(readBuildInfo(file)).toBeNull();

    writeFileSync(
      file,
      JSON.stringify({ commit: 'not-a-commit', dirty: false, builtAt: '2026-09-25T17:00:00.000Z' }),
    );
    expect(readBuildInfo(file)).toBeNull();
  });

  it('reads a valid packed build stamp', () => {
    const buildInfo = {
      commit: '0123456789abcdef0123456789abcdef01234567',
      dirty: true,
      builtAt: '2026-09-25T17:00:00.000Z',
    };
    writeFileSync(file, JSON.stringify(buildInfo));

    expect(readBuildInfo(file)).toEqual(buildInfo);
  });

  it('accepts a packed stamp created without Git metadata', () => {
    const buildInfo = {
      commit: null,
      dirty: null,
      builtAt: '2026-09-25T17:00:00.000Z',
    };
    writeFileSync(file, JSON.stringify(buildInfo));

    expect(readBuildInfo(file)).toEqual(buildInfo);
  });
});
