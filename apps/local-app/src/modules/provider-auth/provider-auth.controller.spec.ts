import { Test, TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';
import { ValidationError } from '../../common/errors/error-types';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { ProviderAuthController } from './provider-auth.controller';
import { ProviderAuthReleaseService } from './provider-auth-release.service';
import { ProviderAuthVaultService } from './provider-auth-vault.service';
import { ProviderAuthGeneratorService } from './provider-auth-generator.service';

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  kind: 'static' as const,
  label: 'Claude token',
  payloadKind: 'env' as const,
  checkedOutRemoteId: null,
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
  lastVerifiedAt: null,
  lastWritebackAt: null,
};

describe('ProviderAuthController', () => {
  let controller: ProviderAuthController;
  let vault: {
    list: jest.Mock;
    createStatic: jest.Mock;
    importOpencode: jest.Mock;
    listOpencodeLogins: jest.Mock;
    delete: jest.Mock;
    checkout: jest.Mock;
    rename: jest.Mock;
  };
  let releaseService: { release: jest.Mock };
  let generator: { start: jest.Mock; get: jest.Mock; cancel: jest.Mock };
  const GENERATION = {
    id: '33333333-3333-4333-8333-333333333333',
    provider: 'codex',
    sessionId: '44444444-4444-4444-8444-444444444444',
    state: 'waiting',
    startedAt: '2026-09-24T00:00:00.000Z',
    finishedAt: null,
    entries: [],
    error: null,
  };

  beforeEach(async () => {
    vault = {
      list: jest.fn().mockResolvedValue([ENTRY]),
      createStatic: jest.fn().mockResolvedValue(ENTRY),
      importOpencode: jest.fn().mockResolvedValue([]),
      listOpencodeLogins: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
      checkout: jest.fn().mockResolvedValue(ENTRY),
      rename: jest.fn().mockResolvedValue(ENTRY),
    };
    releaseService = {
      release: jest.fn().mockResolvedValue({ entry: ENTRY, pullStatus: 'pulled' }),
    };
    generator = {
      start: jest.fn().mockResolvedValue(GENERATION),
      get: jest.fn().mockReturnValue(GENERATION),
      cancel: jest.fn().mockResolvedValue({ ...GENERATION, state: 'cancelled' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderAuthController],
      providers: [
        { provide: ProviderAuthVaultService, useValue: vault },
        { provide: ProviderAuthReleaseService, useValue: releaseService },
        { provide: ProviderAuthGeneratorService, useValue: generator },
        { provide: STORAGE_SERVICE, useValue: {} },
        { provide: 'ProviderAdapterFactory', useValue: {} },
      ],
    }).compile();
    controller = module.get(ProviderAuthController);
  });

  it('lists metadata without any payload or ciphertext field', async () => {
    await expect(controller.list()).resolves.toEqual({ items: [ENTRY] });
    const body = JSON.stringify(await controller.list());
    expect(body).not.toContain('Ciphertext');
    expect(body).not.toContain('"value"');
    expect(vault.list).toHaveBeenCalledTimes(2);
  });

  it('creates a static entry from the token form and forwards it verbatim', async () => {
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L', token: 'tok' }),
    ).resolves.toBe(ENTRY);
    expect(vault.createStatic).toHaveBeenCalledWith({
      provider: 'claude',
      label: 'L',
      token: 'tok',
    });
  });

  it("lists this PC's OpenCode logins through the vault, verbatim", async () => {
    const logins = [
      { providerId: 'zai-coding-plan', type: 'api' as const, importable: true, imported: true },
      { providerId: 'openai', type: 'oauth' as const, importable: false, imported: false },
      { providerId: 'odd one', type: 'other' as const, importable: false, imported: false },
    ];
    vault.listOpencodeLogins.mockResolvedValue(logins);
    await expect(controller.listOpencodeLogins()).resolves.toEqual({ logins });
    expect(vault.listOpencodeLogins).toHaveBeenCalledTimes(1);
  });

  // The controller exercises the request schema without needing an HTTP server.
  it('trims OpenCode import request ids before forwarding them to the vault', async () => {
    await expect(
      controller.importOpencode({ providerIds: [' openai ', '\tgithub\n'] }),
    ).resolves.toEqual({ results: [] });
    expect(vault.importOpencode).toHaveBeenCalledWith(['openai', 'github']);
  });

  // Module unit: the REST boundary must preserve the shared group id and per-id outcomes.
  it('returns imported provider results with one shared entry id alongside refused and missing ids', async () => {
    const results = [
      { providerId: 'anthropic', outcome: 'imported', entryId: ENTRY.id },
      { providerId: 'github', outcome: 'imported', entryId: ENTRY.id },
      { providerId: 'zai-coding-plan', outcome: 'imported', entryId: ENTRY.id },
      {
        providerId: 'openai',
        outcome: 'refused',
        reason: 'oauth entries refresh on use; generate a family instead',
      },
      { providerId: 'absent', outcome: 'missing' },
    ];
    vault.importOpencode.mockResolvedValue(results);
    await expect(
      controller.importOpencode({ providerIds: results.map((result) => result.providerId) }),
    ).resolves.toEqual({ results });
  });

  it('rejects malformed bodies at the REST boundary', async () => {
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L', token: 'line\nbreak' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L', envKey: 'HOME', value: 'x' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(controller.importOpencode({ providerIds: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(controller.delete('not-a-uuid')).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.checkout('11111111-1111-4111-8111-111111111111', { remoteId: 'nope' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.release('11111111-1111-4111-8111-111111111111', { extra: true }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(vault.createStatic).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it('surfaces the service rejection for an unknown provider', async () => {
    vault.createStatic.mockRejectedValue(
      new ValidationError('Provider "gemini" is not supported.', {
        reason: 'provider_not_supported',
      }),
    );
    await expect(
      controller.createStatic({ provider: 'gemini', label: 'L', envKey: 'K', value: 'v' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(vault.createStatic).toHaveBeenCalledWith({
      provider: 'gemini',
      label: 'L',
      envKey: 'K',
      value: 'v',
    });
  });

  it('forwards checkout and release with parsed ids', async () => {
    await controller.checkout(ENTRY.id, {
      remoteId: '22222222-2222-4222-8222-222222222222',
    });
    expect(vault.checkout).toHaveBeenCalledWith(ENTRY.id, '22222222-2222-4222-8222-222222222222');
    await controller.release(ENTRY.id, undefined);
    expect(releaseService.release).toHaveBeenCalledWith(ENTRY.id);
    await controller.delete(ENTRY.id);
    expect(vault.delete).toHaveBeenCalledWith(ENTRY.id);
  });

  it('renames an entry with the trimmed label and a parsed id', async () => {
    await expect(controller.rename(ENTRY.id, { label: '  Work login ' })).resolves.toBe(ENTRY);
    expect(vault.rename).toHaveBeenCalledWith(ENTRY.id, 'Work login');
  });

  it('rejects invalid rename bodies at the REST boundary', async () => {
    await expect(controller.rename(ENTRY.id, { label: '' })).rejects.toBeInstanceOf(ZodError);
    await expect(controller.rename(ENTRY.id, { label: '   ' })).rejects.toBeInstanceOf(ZodError);
    await expect(controller.rename(ENTRY.id, { label: 'a'.repeat(129) })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(controller.rename(ENTRY.id, { label: 'x', extra: 1 })).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(controller.rename(ENTRY.id, {})).rejects.toBeInstanceOf(ZodError);
    await expect(controller.rename('not-a-uuid', { label: 'x' })).rejects.toBeInstanceOf(ZodError);
    expect(vault.rename).not.toHaveBeenCalled();
  });

  it('starts, reads and cancels an isolated login with parsed input', async () => {
    await expect(controller.generate({ provider: 'codex' })).resolves.toBe(GENERATION);
    expect(generator.start).toHaveBeenCalledWith('codex', undefined);
    await controller.generate({ provider: 'opencode', label: 'Work' });
    expect(generator.start).toHaveBeenCalledWith('opencode', 'Work');
    expect(controller.getGeneration(GENERATION.id)).toBe(GENERATION);
    await expect(controller.cancelGeneration(GENERATION.id)).resolves.toMatchObject({
      state: 'cancelled',
    });
    expect(generator.cancel).toHaveBeenCalledWith(GENERATION.id);

    await expect(controller.generate({ provider: 'codex', extra: 1 })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(() => controller.getGeneration('nope')).toThrow(ZodError);
    await expect(controller.cancelGeneration('nope')).rejects.toBeInstanceOf(ZodError);
  });
});
