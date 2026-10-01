import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import {
  STORAGE_SERVICE,
  type ProviderAuthStorage,
  type RemoteStorage,
} from '../storage/interfaces/storage.interface';
import type { ProviderAuthEntry, ProviderAuthPayload } from '../storage/models/domain.models';
import {
  OPENCODE_AUTH_FILE_PATH,
  PROVIDER_AUTH_ADAPTERS,
  type ProviderAuthAdapterSpec,
  type ProviderAuthClaimBundle,
  type ProviderAuthClaimFile,
  type ProviderAuthGeneratedEntry,
  opencodeEntries,
  opencodePcAuthFilePath,
  specAcceptsPayload,
} from './provider-auth-adapters';
import {
  isOpencodeProviderId,
  type CreateProviderAuthStaticData,
  type OpencodeLoginDto,
  type PerProviderIdImportResult,
  type ProviderAuthEntryDto,
} from './provider-auth.dto';
import type { ProviderAuthFamilyReport } from './provider-auth-watcher.service';

const logger = createLogger('ProviderAuthVaultService');

interface OpenCodeAuthFileEntry {
  type?: unknown;
  [key: string]: unknown;
}

@Injectable()
export class ProviderAuthVaultService {
  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: ProviderAuthStorage & RemoteStorage,
    private readonly adapters: ProviderAdapterFactory,
  ) {}

  /** Metadata only: the ciphertext column never crosses this method. */
  async list(): Promise<ProviderAuthEntryDto[]> {
    return (await this.storage.listProviderAuthEntries()).map(this.toDto);
  }

  async get(id: string): Promise<ProviderAuthEntryDto> {
    return this.toDto(await this.storage.getProviderAuthEntry(id));
  }

  /** The OpenCode provider ids among `entryIds` (not secret; used to check the login list). */
  async opencodeProviderIds(entryIds: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const entryId of entryIds) {
      const payload = await this.storage.readProviderAuthPayload(entryId);
      ids.push(...Object.keys(opencodeEntries(payload)));
    }
    return ids;
  }

  async createStatic(input: CreateProviderAuthStaticData): Promise<ProviderAuthEntryDto> {
    const spec = this.requireSupportedProvider(input.provider);
    let payload: ProviderAuthPayload;
    if ('token' in input) {
      if (spec.payloadKind !== 'env' || spec.kind !== 'static') {
        throw new ValidationError(
          `Provider "${input.provider}" does not take a pasted token; store its login another way.`,
          { reason: 'provider_not_env_static' },
        );
      }
      payload = { payloadKind: 'env', envKey: spec.envKey, value: input.token };
    } else {
      payload = { payloadKind: 'env', envKey: input.envKey, value: input.value };
    }
    const entry = await this.storage.createProviderAuthEntry({
      provider: input.provider,
      kind: 'static',
      label: input.label,
      payload,
    });
    return this.toDto(entry);
  }

  /**
   * Imports selected entries of this PC's OpenCode `auth.json`. `api` and
   * `wellknown` entries become one static group; `oauth` entries are refused
   * because their refresh token rotates on use.
   */
  async importOpencode(providerIds: string[]): Promise<PerProviderIdImportResult[]> {
    const spec = this.requireSupportedProvider('opencode');
    if (spec.payloadKind !== 'opencode-entry') {
      throw new ValidationError('OpenCode entries are not importable on this instance.');
    }
    const authFile = await this.readPcOpenCodeAuthFile();
    if (!authFile) {
      throw new NotFoundError('OpenCode auth file', opencodePcAuthFilePath('<home>'));
    }

    const results = new Map<string, PerProviderIdImportResult>();
    const entries = new Map<string, Record<string, unknown>>();
    for (const providerId of providerIds) {
      const entry = authFile[providerId];
      if (!isPlainRecord(entry)) {
        results.set(providerId, { providerId, outcome: 'missing' });
        continue;
      }
      if (entry.type === 'oauth') {
        results.set(providerId, {
          providerId,
          outcome: 'refused',
          reason: 'oauth entries refresh on use; generate a family instead',
        });
        continue;
      }
      if (entry.type !== 'api' && entry.type !== 'wellknown') {
        results.set(providerId, {
          providerId,
          outcome: 'refused',
          reason: 'unknown auth entry type',
        });
        continue;
      }
      entries.set(providerId, entry);
    }
    if (entries.size > 0) {
      const created = await this.storage.createProviderAuthEntry({
        provider: 'opencode',
        kind: 'static',
        label: [...entries.keys()].join(', ').slice(0, 128),
        payload: { payloadKind: 'opencode-entries', entries: Object.fromEntries(entries) },
      });
      logger.info(
        { entryId: created.id, providerIds: [...entries.keys()] },
        'Imported OpenCode auth group',
      );
      for (const providerId of entries.keys()) {
        results.set(providerId, { providerId, outcome: 'imported', entryId: created.id });
      }
    }
    return providerIds.map((providerId) => results.get(providerId)!);
  }

  /**
   * The logins in this PC's OpenCode auth file as ids with fixed types and
   * flags; no entry value crosses this method. A missing or malformed file
   * lists empty — `importOpencode` keeps its 404 because it cannot work
   * without the file.
   */
  async listOpencodeLogins(): Promise<OpencodeLoginDto[]> {
    const authFile = await this.readPcOpenCodeAuthFile();
    if (!authFile) return [];
    const staticOpencodeEntryIds = (await this.storage.listProviderAuthEntries())
      .filter((entry) => entry.provider === 'opencode' && entry.kind === 'static')
      .map((entry) => entry.id);
    const importedIds = new Set(await this.opencodeProviderIds(staticOpencodeEntryIds));
    return Object.entries(authFile).map(([providerId, entry]) => {
      const type = this.opencodeEntryType(entry);
      return {
        providerId,
        type,
        importable: (type === 'api' || type === 'wellknown') && isOpencodeProviderId(providerId),
        imported: importedIds.has(providerId),
      };
    });
  }

  /** Stores what an isolated login produced; the login was verified at `verifiedAt`. */
  async createGenerated(
    provider: string,
    label: string,
    entries: ProviderAuthGeneratedEntry[],
    verifiedAt: string,
  ): Promise<ProviderAuthEntryDto[]> {
    this.requireSupportedProvider(provider);
    const created: ProviderAuthEntryDto[] = [];
    for (const entry of entries) {
      const fullLabel = entry.labelSuffix ? `${label} · ${entry.labelSuffix}` : label;
      const stored = await this.storage.createProviderAuthEntry({
        provider,
        kind: entry.kind,
        label: fullLabel.slice(0, 128),
        payload: entry.payload,
        lastVerifiedAt: verifiedAt,
      });
      logger.info({ entryId: stored.id, provider, kind: entry.kind }, 'Stored generated login');
      created.push(this.toDto(stored));
    }
    return created;
  }

  async delete(id: string): Promise<void> {
    await this.storage.deleteProviderAuthEntry(id);
  }

  async checkout(id: string, remoteId: string): Promise<ProviderAuthEntryDto> {
    return this.toDto(await this.storage.checkoutProviderAuthEntry(id, remoteId));
  }

  async release(id: string): Promise<ProviderAuthEntryDto> {
    return this.toDto(await this.storage.releaseProviderAuthEntry(id));
  }

  async rename(id: string, label: string): Promise<ProviderAuthEntryDto> {
    return this.toDto(await this.storage.renameProviderAuthEntry(id, label));
  }

  /** The family entries one remote holds, with their last write-back time; metadata only. */
  async familiesOfRemote(
    remoteId: string,
  ): Promise<Array<{ provider: string; entryId: string; lastWritebackAt: string | null }>> {
    const entries = await this.checkedOutFamilies(remoteId);
    return entries.map((entry) => ({
      provider: entry.provider,
      entryId: entry.id,
      lastWritebackAt: entry.lastWritebackAt,
    }));
  }

  /**
   * Applies a host's families report to the entries checked out to that remote.
   * Only content that actually differs is re-encrypted, so a home restart's
   * first full pull (since=0) is a no-op. OpenCode touches just the `oauth`
   * entries checked out to the remote — imported `api` entries are static and
   * stay exactly as stored. Never logs content: providers and entry ids only.
   */
  async writeBackFamilies(
    remoteId: string,
    reports: ProviderAuthFamilyReport[],
  ): Promise<ProviderAuthEntryDto[]> {
    const checkedOut = await this.checkedOutFamilies(remoteId);
    const updated: ProviderAuthEntry[] = [];

    for (const report of reports) {
      const spec = PROVIDER_AUTH_ADAPTERS[report.provider];
      if (!spec) continue;
      const file = report.files[0];
      if (!file) continue;

      if (spec.payloadKind === 'files') {
        const entry = checkedOut.find((candidate) => candidate.provider === report.provider);
        if (!entry) continue;
        const payload = await this.storage.readProviderAuthPayload(entry.id);
        if (payload.payloadKind !== 'files') continue;
        const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
        if (payload.content === content) continue;
        updated.push(
          await this.storage.updateProviderAuthPayload(entry.id, {
            payloadKind: 'files',
            content,
          }),
        );
        continue;
      }

      if (spec.payloadKind === 'opencode-entry') {
        let authFile: Record<string, unknown>;
        try {
          authFile = JSON.parse(
            Buffer.from(file.contentBase64, 'base64').toString('utf8'),
          ) as Record<string, unknown>;
        } catch {
          logger.warn(
            { provider: report.provider },
            'Family write-back file was not JSON; skipped',
          );
          continue;
        }
        for (const entry of checkedOut.filter(
          (candidate) => candidate.provider === report.provider,
        )) {
          const payload = await this.storage.readProviderAuthPayload(entry.id);
          if (payload.payloadKind !== 'opencode-entry') continue;
          const fresh = authFile[payload.providerId];
          // `api`/`wellknown` entries are static; only a rotating `oauth` entry counts.
          if (
            !fresh ||
            typeof fresh !== 'object' ||
            (fresh as { type?: unknown }).type !== 'oauth'
          ) {
            continue;
          }
          if (JSON.stringify(payload.entry) === JSON.stringify(fresh)) continue;
          updated.push(
            await this.storage.updateProviderAuthPayload(entry.id, {
              payloadKind: 'opencode-entry',
              providerId: payload.providerId,
              entry: fresh as Record<string, unknown>,
            }),
          );
        }
      }
    }

    if (updated.length > 0) {
      logger.info(
        { remoteId, entryIds: updated.map((entry) => entry.id) },
        'Wrote back refreshed login families',
      );
    }
    return updated.map((entry) => this.toDto(entry));
  }

  private async checkedOutFamilies(remoteId: string): Promise<ProviderAuthEntry[]> {
    return (await this.storage.listProviderAuthEntries()).filter(
      (entry) => entry.kind === 'family' && entry.checkedOutRemoteId === remoteId,
    );
  }

  /**
   * Composes the claim's `providerAuth` section: static entries become env
   * vars, Codex/Antigravity families become their login file, and every
   * selected OpenCode entry is merged into one `auth.json`. Duplicate env
   * keys, file paths, or OpenCode provider ids across the selection refuse
   * the whole bundle rather than silently dropping a credential.
   */
  async buildClaimBundle(selection: {
    entryIds: string[];
    homePath: string;
  }): Promise<ProviderAuthClaimBundle> {
    if (!selection.homePath.startsWith('/') || selection.homePath.includes('..')) {
      throw new ValidationError('homePath must be an absolute path inside the VM home.', {
        reason: 'home_path_invalid',
      });
    }
    const bundle: ProviderAuthClaimBundle = { env: {}, files: [] };
    const opencodeAuth: Record<string, unknown> = {};
    const seenIds = new Set<string>();

    for (const entryId of selection.entryIds) {
      if (seenIds.has(entryId)) {
        continue;
      }
      seenIds.add(entryId);
      const entry = await this.storage.getProviderAuthEntry(entryId);
      const payload = await this.storage.readProviderAuthPayload(entryId);
      const spec = this.requireSupportedProvider(entry.provider);

      if (!specAcceptsPayload(spec, payload.payloadKind)) {
        throw new ValidationError(
          `The stored entry for "${entry.provider}" no longer matches its provider shape.`,
          { reason: 'provider_auth_shape_mismatch', entryId },
        );
      }
      switch (payload.payloadKind) {
        case 'env':
          this.addEnv(bundle, payload.envKey, payload.value, entryId);
          break;
        case 'files': {
          if (spec.payloadKind !== 'files') {
            throw new ValidationError(
              `The stored entry for "${entry.provider}" no longer matches its provider shape.`,
              { reason: 'provider_auth_shape_mismatch', entryId },
            );
          }
          this.addFile(bundle, selection.homePath, spec.filePath, payload.content, entryId);
          break;
        }
        case 'opencode-entry':
        case 'opencode-entries': {
          for (const [providerId, auth] of Object.entries(opencodeEntries(payload))) {
            if (Object.hasOwn(opencodeAuth, providerId)) {
              throw new ValidationError(`OpenCode provider id "${providerId}" is selected twice.`, {
                reason: 'opencode_provider_id_duplicate',
                entryId,
              });
            }
            opencodeAuth[providerId] = auth;
          }
          break;
        }
      }
    }

    if (Object.keys(opencodeAuth).length > 0) {
      this.addFile(
        bundle,
        selection.homePath,
        OPENCODE_AUTH_FILE_PATH,
        `${JSON.stringify(opencodeAuth, null, 2)}\n`,
        'opencode-composed',
      );
    }
    return bundle;
  }

  private addEnv(
    bundle: ProviderAuthClaimBundle,
    envKey: string,
    value: string,
    entryId: string,
  ): void {
    if (bundle.env[envKey] !== undefined) {
      throw new ValidationError(`Environment key "${envKey}" is selected twice.`, {
        reason: 'provider_auth_env_duplicate',
        entryId,
      });
    }
    bundle.env[envKey] = value;
  }

  private addFile(
    bundle: ProviderAuthClaimBundle,
    homePath: string,
    relativePath: string,
    content: string,
    entryId: string,
  ): void {
    const path = join(homePath, relativePath);
    if (bundle.files.some((file) => file.path === path)) {
      throw new ValidationError(`File "${relativePath}" is selected twice.`, {
        reason: 'provider_auth_file_duplicate',
        entryId,
      });
    }
    const file: ProviderAuthClaimFile = {
      path,
      mode: '0600',
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    };
    bundle.files.push(file);
  }

  /** The provider enum is the registered adapter set, nothing else. */
  private requireSupportedProvider(provider: string): ProviderAuthAdapterSpec {
    if (!this.adapters.isSupported(provider)) {
      throw new ValidationError(`Provider "${provider}" is not supported.`, {
        reason: 'provider_not_supported',
        supported: this.adapters.getSupportedProviders(),
      });
    }
    const spec = PROVIDER_AUTH_ADAPTERS[provider.toLowerCase()];
    if (!spec) {
      throw new ValidationError(`Provider "${provider}" has no auth storage shape.`, {
        reason: 'provider_auth_shape_missing',
      });
    }
    return spec;
  }

  /**
   * Reads the PC's OpenCode auth file; null when it is missing, unreadable, or
   * its content is anything but a plain JSON object. Import and login listing
   * share this read so the two never disagree about what the file holds.
   */
  private async readPcOpenCodeAuthFile(): Promise<Record<string, OpenCodeAuthFileEntry> | null> {
    let content: string;
    try {
      content = await readFile(opencodePcAuthFilePath(homedir()), 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    if (!isPlainRecord(parsed)) return null;
    return parsed as Record<string, OpenCodeAuthFileEntry>;
  }

  /** Only `api`, `wellknown`, and `oauth` are known login types; everything else maps to `other`. */
  private opencodeEntryType(entry: unknown): OpencodeLoginDto['type'] {
    if (!isPlainRecord(entry)) return 'other';
    const type = entry.type;
    if (type === 'api' || type === 'wellknown' || type === 'oauth') return type;
    return 'other';
  }

  private toDto(entry: ProviderAuthEntry): ProviderAuthEntryDto {
    const { payloadCiphertext: _payloadCiphertext, ...metadata } = entry;
    return metadata;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
