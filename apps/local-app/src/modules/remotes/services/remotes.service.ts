import { RemoteApiKeyManagementService } from '../auth/remote-api-key-management.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { Inject, Injectable } from '@nestjs/common';
import { RemoteStorage, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { Remote } from '../../storage/models/domain.models';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/error-types';
import { certificateFingerprint } from '../../../common/tls/certificate';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { ProjectWriteAdmissionService } from '../admission/project-write-admission.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { createLogger } from '../../../common/logging/logger';
import {
  CERTIFICATE_FINGERPRINT_MESSAGE,
  parseCertificateFingerprint,
  type CreateRemoteData,
} from '../dtos/remote.dto';
import { RemoteOperationRunner } from '../operations/remote-operation.runner';

const logger = createLogger('RemotesService');

/** Write path for remotes; reads stay on the controller's read-CRUD exception. */
@Injectable()
export class RemotesService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly admission: ProjectWriteAdmissionService,
    private readonly hostClient: RemoteHostClient,
    private readonly familyWriteback: ProviderAuthWritebackService,
    private readonly runner: RemoteOperationRunner,
    private readonly keyManagement: RemoteApiKeyManagementService,
    private readonly apiKeys: RemoteApiKeyService,
  ) {}

  /**
   * Adds a running VM: approves its certificate, checks the key over the pinned
   * connection, and only then saves the remote and its key.
   */
  async create(data: CreateRemoteData): Promise<Remote> {
    const { apiKey, certificateFingerprint: fingerprint, ...registration } = data;
    const certificate = await this.approveCertificate(registration.baseUrl, fingerprint);
    await this.keyManagement.validate(registration.baseUrl, certificate, apiKey);
    const remote = await this.storage.createRemote({
      ...registration,
      tlsCertificate: certificate,
    });
    if (apiKey) {
      try {
        await this.apiKeys.save(remote.id, apiKey);
      } catch {
        await this.storage.deleteRemote(remote.id);
        throw new ConflictError('Could not save the VM API key. Try adding the VM again.');
      }
    }
    return remote;
  }

  /**
   * The certificate the VM at `origin` shows, once its SHA-256 fingerprint
   * equals `fingerprint`. The user reads the fingerprint on the VM itself, so
   * it is the only trust source here: the certificate comes from an unverified
   * connection. Throws on a mismatch; the caller then saves and sends nothing.
   */
  async approveCertificate(origin: string, fingerprint: string): Promise<string> {
    const expected = parseCertificateFingerprint(fingerprint);
    if (expected === null) {
      throw new ValidationError(CERTIFICATE_FINGERPRINT_MESSAGE, {
        reason: 'remote_tls_fingerprint_invalid',
      });
    }
    let certificate: string;
    try {
      ({ certificate } = await this.hostClient.discoverRuntime(origin));
    } catch {
      throw new AppError(
        `Nothing answers over HTTPS at ${origin}. Start the VM, then check the address.`,
        'REMOTE_UNREACHABLE',
        502,
      );
    }
    if (certificateFingerprint(certificate) !== expected) {
      throw new ConflictError(
        'The fingerprint does not match the certificate that this address shows. Copy the fingerprint again from this VM. If it is correct, another machine answers at this address.',
        { code: 'REMOTE_TLS_FINGERPRINT_MISMATCH' },
      );
    }
    return certificate;
  }

  async rename(id: string, name: string): Promise<Remote> {
    const remote = await this.storage.updateRemoteName(id, name);
    // `PROJECT_REMOTE` errors name the remote.
    await this.admission.refreshBindings();
    // Not awaited: an unroutable host would hold the rename answer for the
    // whole control timeout, and the push is best-effort anyway.
    void this.pushInstanceLabel(remote);
    return remote;
  }

  async delete(id: string): Promise<void> {
    await this.storage.getRemote(id);
    if (
      (await this.storage.listRemoteProjectBindings()).some((binding) => binding.remoteId === id)
    ) {
      throw new ConflictError('Cannot delete a remote with a project binding.', {
        code: 'REMOTE_HAS_PROJECT_BINDINGS',
        remoteId: id,
      });
    }
    await this.runner.supersedeFailedVmOperation(id);
    // The VM's refreshed family content is unrecoverable once the remote is
    // gone, so pull it into the vault before the delete (reset_vm shares this
    // pre-step). A missing remote still 404s through the pull's lookup.
    await this.familyWriteback.pullFamiliesNow(id).catch((error) => {
      if (error instanceof NotFoundError) throw error;
      logger.warn({ err: error, remoteId: id }, 'Family pull before remote delete failed');
    });
    return this.storage.deleteRemote(id);
  }

  /**
   * The phone shows the host's attestation label, so a rename at home must move
   * to the host or the two names drift. Best-effort: an unreachable host keeps
   * the old label until the next rename or sign-in re-sends it.
   */
  private async pushInstanceLabel(remote: Remote): Promise<void> {
    try {
      await this.hostClient.setInstanceLabel(remote.id, remote.name);
    } catch (error) {
      logger.warn(
        { err: error, remoteId: remote.id },
        'Could not update the remote instance label after rename',
      );
    }
  }
}
