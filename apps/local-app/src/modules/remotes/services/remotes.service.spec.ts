import { Test } from '@nestjs/testing';
import { AppError, ConflictError, ValidationError } from '../../../common/errors/error-types';
import { certificateFingerprint, normalizeCertificate } from '../../../common/tls/certificate';
import { fixtureTls, otherTls } from '../../../common/test/tls-fixture';
import { RemotesService } from './remotes.service';
import { RemoteApiKeyManagementService } from '../auth/remote-api-key-management.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProjectWriteAdmissionService } from '../admission/project-write-admission.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { RemoteOperationRunner } from '../operations/remote-operation.runner';

// Unit collaborator boundaries prove invalid candidates cannot create a row or enter a DTO.
describe('add remote with API key', () => {
  const key = `dck_${'a'.repeat(43)}`;
  const certificate = normalizeCertificate(fixtureTls.cert);
  const fingerprint = certificateFingerprint(fixtureTls.cert);
  const data = {
    name: 'vm',
    baseUrl: 'https://vm',
    kind: 'address' as const,
    certificateFingerprint: fingerprint,
  };
  const { certificateFingerprint: _fingerprint, ...registration } = data;
  let service: RemotesService;
  let calls: string[];
  let discoverRuntime: jest.Mock;
  let validate: jest.Mock;
  let save: jest.Mock;
  let createRemote: jest.Mock;
  let deleteRemote: jest.Mock;
  beforeEach(async () => {
    calls = [];
    discoverRuntime = jest.fn(async () => {
      calls.push('discover');
      return { runtime: null, certificate };
    });
    validate = jest.fn(async () => void calls.push('validate'));
    save = jest.fn(async () => void calls.push('save'));
    createRemote = jest.fn(async () => {
      calls.push('create');
      return { id: 'vm', ...registration };
    });
    deleteRemote = jest.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        RemotesService,
        { provide: STORAGE_SERVICE, useValue: { createRemote, deleteRemote } },
        { provide: RemoteApiKeyManagementService, useValue: { validate } },
        { provide: RemoteApiKeyService, useValue: { save } },
        { provide: RemoteHostClient, useValue: { discoverRuntime } },
        ...[ProjectWriteAdmissionService, ProviderAuthWritebackService, RemoteOperationRunner].map(
          (provide) => ({ provide, useValue: {} }),
        ),
      ],
    }).compile();
    service = module.get(RemotesService);
  });
  it('discovers, compares, verifies the key pinned, creates the row, then saves the key', async () => {
    const result = await service.create({ ...data, apiKey: key });
    expect(calls).toEqual(['discover', 'validate', 'create', 'save']);
    expect(discoverRuntime).toHaveBeenCalledWith(data.baseUrl);
    expect(validate).toHaveBeenCalledWith(data.baseUrl, certificate, key);
    expect(createRemote).toHaveBeenCalledWith({ ...registration, tlsCertificate: certificate });
    expect(save).toHaveBeenCalledWith('vm', key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result).not.toHaveProperty('apiKey');
  });
  it('accepts the fingerprint with colons and in lower case', async () => {
    const pasted = fingerprint.toLowerCase().match(/../g)!.join(':');
    await service.create({ ...data, certificateFingerprint: pasted });
    expect(createRemote).toHaveBeenCalledWith({ ...registration, tlsCertificate: certificate });
  });
  it.each([undefined, key])(
    'saves nothing and never checks key %s when the address shows another certificate',
    async (apiKey) => {
      discoverRuntime.mockResolvedValue({ runtime: null, certificate: otherTls.cert });
      const error: unknown = await service.create({ ...data, apiKey }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({
        message: expect.stringContaining('The fingerprint does not match'),
        details: { code: 'REMOTE_TLS_FINGERPRINT_MISMATCH' },
      });
      expect(validate).not.toHaveBeenCalled();
      expect(createRemote).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );
  it('fails with a clear error when nothing answers at the address', async () => {
    discoverRuntime.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const error: unknown = await service.create({ ...data, apiKey: key }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'REMOTE_UNREACHABLE',
      message: 'Nothing answers over HTTPS at https://vm. Start the VM, then check the address.',
    });
    expect(validate).not.toHaveBeenCalled();
    expect(createRemote).not.toHaveBeenCalled();
  });
  it('refuses a value that is not a fingerprint before contacting the VM', async () => {
    const error: unknown = await service
      .create({ ...data, certificateFingerprint: 'AB:CD' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(discoverRuntime).not.toHaveBeenCalled();
    expect(createRemote).not.toHaveBeenCalled();
  });
  it.each([undefined, key])('creates nothing when the VM refuses candidate %s', async (apiKey) => {
    validate.mockRejectedValue(new Error('The VM refused this key.'));
    await expect(service.create({ ...data, apiKey })).rejects.toThrow('The VM refused this key.');
    expect(createRemote).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('removes the incomplete registration if key persistence fails', async () => {
    save.mockRejectedValue(new Error(key));
    await expect(service.create({ ...data, apiKey: key })).rejects.toThrow(
      'Could not save the VM API key.',
    );
    expect(deleteRemote).toHaveBeenCalledWith('vm');
  });
});
