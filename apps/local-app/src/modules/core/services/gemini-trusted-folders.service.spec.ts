import { GeminiTrustedFoldersService, getEffectiveTrust } from './gemini-trusted-folders.service';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'fs/promises';

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  realpath: jest.fn(),
}));

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockRename = rename as jest.MockedFunction<typeof rename>;
const mockRealpath = realpath as jest.MockedFunction<typeof realpath>;
const mockMkdir = mkdir as jest.MockedFunction<typeof mkdir>;
const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;

describe('getEffectiveTrust', () => {
  it('returns no_rule when no rules exist', () => {
    expect(getEffectiveTrust('/repos/foo', {})).toEqual({ kind: 'no_rule' });
  });

  it('exact TRUST_FOLDER → trusted exact', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foo': 'TRUST_FOLDER' })).toEqual({
      kind: 'trusted',
      via: 'exact',
    });
  });

  it('ancestor TRUST_FOLDER covers descendant', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos': 'TRUST_FOLDER' })).toEqual({
      kind: 'trusted',
      via: 'ancestor',
    });
  });

  it('TRUST_PARENT for same path → trusted via parent_rule (effective = dirname)', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foo': 'TRUST_PARENT' })).toEqual({
      kind: 'trusted',
      via: 'parent_rule',
    });
  });

  it('ancestor TRUST_PARENT (rule /repos, project /repos/foo) → trusted via parent_rule', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos': 'TRUST_PARENT' })).toEqual({
      kind: 'trusted',
      via: 'parent_rule',
    });
  });

  it('sibling via TRUST_PARENT (rule /repos/bar, project /repos/foo) → trusted via parent_rule', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/bar': 'TRUST_PARENT' })).toEqual({
      kind: 'trusted',
      via: 'parent_rule',
    });
  });

  it('exact DO_NOT_TRUST → distrusted exact', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foo': 'DO_NOT_TRUST' })).toEqual({
      kind: 'distrusted',
      via: 'exact',
    });
  });

  it('ancestor DO_NOT_TRUST → distrusted ancestor', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos': 'DO_NOT_TRUST' })).toEqual({
      kind: 'distrusted',
      via: 'ancestor',
    });
  });

  it('longest match wins (more specific rule prevails)', () => {
    expect(
      getEffectiveTrust('/repos/foo/bar', {
        '/repos': 'DO_NOT_TRUST',
        '/repos/foo': 'TRUST_FOLDER',
      }),
    ).toEqual({ kind: 'trusted', via: 'ancestor' });
  });

  it('non-matching rules ignored', () => {
    expect(getEffectiveTrust('/other/project', { '/repos': 'TRUST_FOLDER' })).toEqual({
      kind: 'no_rule',
    });
  });

  it('partial path match does not count (rule /repos/foobar, project /repos/foo)', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foobar': 'TRUST_FOLDER' })).toEqual({
      kind: 'no_rule',
    });
  });
});

describe('GeminiTrustedFoldersService', () => {
  let service: GeminiTrustedFoldersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GeminiTrustedFoldersService();
    mockRealpath.mockRejectedValue(new Error('ENOENT'));
  });

  describe('ensure — file handling', () => {
    it('creates ~/.gemini/ directory with mode 0700', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      await service.ensure('/repos/foo');

      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('.gemini'), {
        recursive: true,
        mode: 0o700,
      });
    });

    it('creates file with mode 0600 when missing', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      await service.ensure('/repos/foo');

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        expect.any(String),
        { mode: 0o600 },
      );
      expect(mockRename).toHaveBeenCalled();
    });

    it('preserves existing entries when adding new path', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/existing': 'TRUST_FOLDER' }));

      await service.ensure('/repos/new');

      const written = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed['/existing']).toBe('TRUST_FOLDER');
      expect(parsed['/repos/new']).toBe('TRUST_FOLDER');
    });

    it('returns malformed_warning on invalid JSON', async () => {
      mockReadFile.mockResolvedValue('{truncated...');

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(false);
      expect(result.action).toBe('malformed_warning');
      expect(result.message).toContain('invalid JSON');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns malformed_warning when root is array', async () => {
      mockReadFile.mockResolvedValue('["/repos"]');

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(false);
      expect(result.action).toBe('malformed_warning');
      expect(result.message).toContain('not a JSON object');
    });

    it('returns malformed_warning when root is string', async () => {
      mockReadFile.mockResolvedValue('"hello"');

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(false);
      expect(result.action).toBe('malformed_warning');
    });

    it('returns malformed_warning when root is null', async () => {
      mockReadFile.mockResolvedValue('null');

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(false);
      expect(result.action).toBe('malformed_warning');
    });
  });

  describe('ensure — trust resolution', () => {
    it('returns already_trusted when exact TRUST_FOLDER exists', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/repos/foo': 'TRUST_FOLDER' }));

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_trusted');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns already_trusted when ancestor TRUST_FOLDER covers path', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/repos': 'TRUST_FOLDER' }));

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_trusted');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns already_trusted for sibling via TRUST_PARENT', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/repos/bar': 'TRUST_PARENT' }));

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(true);
      expect(result.action).toBe('already_trusted');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns distrusted_warning and does not clobber DO_NOT_TRUST', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/repos/foo': 'DO_NOT_TRUST' }));

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(false);
      expect(result.action).toBe('distrusted_warning');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns distrusted_warning for ancestor DO_NOT_TRUST', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/repos': 'DO_NOT_TRUST' }));

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(false);
      expect(result.action).toBe('distrusted_warning');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('adds TRUST_FOLDER when no rule covers path', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/other': 'TRUST_FOLDER' }));

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written['/repos/foo']).toBe('TRUST_FOLDER');
      expect(written['/other']).toBe('TRUST_FOLDER');
    });
  });

  describe('ensure — invalid trust values', () => {
    it('preserves invalid values in file but excludes from matching', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ '/repos/foo': 'TRUSTED', '/other': 'TRUST_FOLDER' }),
      );

      const result = await service.ensure('/repos/foo');

      expect(result.success).toBe(true);
      expect(result.action).toBe('added');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Invalid trust value for "/repos/foo"')]),
      );
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written['/repos/foo']).toBe('TRUST_FOLDER');
    });

    it('surfaces warnings for boolean trust values', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ '/repos': true }));

      const result = await service.ensure('/repos/foo');

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('true');
    });
  });

  describe('ensure — queued write chain', () => {
    it('concurrent calls serialize and both succeed', async () => {
      mockReadFile.mockResolvedValue('{}');

      const [r1, r2] = await Promise.all([service.ensure('/repos/a'), service.ensure('/repos/b')]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it('failed write does not poison subsequent calls', async () => {
      mockReadFile.mockResolvedValue('{}');
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

      const r1 = await service.ensure('/repos/fail');
      expect(r1.success).toBe(false);

      mockWriteFile.mockResolvedValue(undefined);
      const r2 = await service.ensure('/repos/ok');
      expect(r2.success).toBe(true);
    });
  });

  describe('ensure — path normalization', () => {
    it('normalizes /foo/bar/../baz to /foo/baz', async () => {
      mockReadFile.mockResolvedValue('{}');

      await service.ensure('/foo/bar/../baz');

      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written['/foo/baz']).toBe('TRUST_FOLDER');
    });

    it('strips trailing slash', async () => {
      mockReadFile.mockResolvedValue('{}');

      await service.ensure('/repos/foo/');

      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written['/repos/foo']).toBe('TRUST_FOLDER');
    });

    it('uses realpath when path exists', async () => {
      mockRealpath.mockResolvedValue('/real/path');
      mockReadFile.mockResolvedValue('{}');

      await service.ensure('/symlinked/path');

      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written['/real/path']).toBe('TRUST_FOLDER');
    });
  });

  describe('ensure — atomic write cleanup', () => {
    it('cleans up tmp file on rename failure', async () => {
      mockReadFile.mockResolvedValue('{}');
      mockRename.mockRejectedValueOnce(new Error('rename failed'));

      await service.ensure('/repos/foo');

      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('.tmp.'));
    });
  });
});
