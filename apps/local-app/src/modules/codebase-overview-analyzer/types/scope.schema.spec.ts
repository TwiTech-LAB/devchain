import {
  FolderScopeEntrySchema,
  ScopeConfigSchema,
  FolderPurposeSchema,
  ScopeEntryOriginSchema,
} from './scope.schema';

describe('scope.schema', () => {
  describe('FolderPurposeSchema', () => {
    it.each(['source', 'test-source', 'generated', 'resources', 'excluded'])(
      'accepts valid purpose "%s"',
      (purpose) => {
        expect(FolderPurposeSchema.safeParse(purpose).success).toBe(true);
      },
    );

    it('rejects unknown purpose', () => {
      expect(FolderPurposeSchema.safeParse('unknown').success).toBe(false);
    });
  });

  describe('ScopeEntryOriginSchema', () => {
    it.each(['default', 'user'])('accepts valid origin "%s"', (origin) => {
      expect(ScopeEntryOriginSchema.safeParse(origin).success).toBe(true);
    });

    it('rejects unknown origin', () => {
      expect(ScopeEntryOriginSchema.safeParse('system').success).toBe(false);
    });
  });

  describe('FolderScopeEntrySchema', () => {
    const valid = { folder: 'src', purpose: 'source', reason: 'main source', origin: 'user' };

    it('accepts a valid entry', () => {
      expect(FolderScopeEntrySchema.safeParse(valid).success).toBe(true);
    });

    it('rejects non-string folder (numeric)', () => {
      expect(FolderScopeEntrySchema.safeParse({ ...valid, folder: 42 }).success).toBe(false);
    });

    it('rejects empty string folder', () => {
      expect(FolderScopeEntrySchema.safeParse({ ...valid, folder: '' }).success).toBe(false);
    });

    it('rejects unknown purpose', () => {
      expect(FolderScopeEntrySchema.safeParse({ ...valid, purpose: 'archive' }).success).toBe(
        false,
      );
    });

    it('rejects unknown origin', () => {
      expect(FolderScopeEntrySchema.safeParse({ ...valid, origin: 'system' }).success).toBe(false);
    });

    it('rejects missing required field (purpose)', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { purpose: _purpose, ...rest } = valid;
      expect(FolderScopeEntrySchema.safeParse(rest).success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      expect(FolderScopeEntrySchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    });
  });

  describe('ScopeConfigSchema', () => {
    const validConfig = {
      schemaVersion: 1,
      entries: [
        { folder: 'src', purpose: 'source', reason: '', origin: 'default' },
        { folder: 'dist', purpose: 'generated', reason: 'build output', origin: 'user' },
      ],
    };

    it('accepts a valid config', () => {
      const result = ScopeConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('rejects wrong schemaVersion', () => {
      expect(ScopeConfigSchema.safeParse({ ...validConfig, schemaVersion: 2 }).success).toBe(false);
    });

    it('rejects missing entries field', () => {
      expect(ScopeConfigSchema.safeParse({ schemaVersion: 1 }).success).toBe(false);
    });

    it('rejects invalid entry within entries array', () => {
      const config = {
        schemaVersion: 1,
        entries: [{ folder: 42, purpose: 'excluded', reason: '', origin: 'user' }],
      };
      expect(ScopeConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects extra top-level fields (strict)', () => {
      expect(ScopeConfigSchema.safeParse({ ...validConfig, extra: true }).success).toBe(false);
    });

    it('returns typed data on success', () => {
      const result = ScopeConfigSchema.safeParse(validConfig);
      if (!result.success) throw new Error('Expected success');
      expect(result.data.schemaVersion).toBe(1);
      expect(result.data.entries).toHaveLength(2);
      expect(result.data.entries[0].folder).toBe('src');
    });
  });
});
