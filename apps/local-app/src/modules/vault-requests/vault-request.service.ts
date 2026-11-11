import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type AgentStorage,
  type VaultEntryStorage,
} from '../storage/interfaces/storage.interface';
import type {
  VaultEntry,
  VaultEntryKind,
  VaultResolvedEntry,
} from '../storage/models/domain.models';
import { VaultAccessService } from '../vault/vault-access.service';
import { VaultEntriesService } from '../vault/vault-entries.service';
import {
  hasVaultFamilyApproval,
  useStanding,
  VaultUseApprovalStore,
} from '../vault/vault-use-approvals';
import { VaultRequestStore, type VaultRequestType } from './vault-request.store';

export interface VaultRequestInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  /** For a new entry; a grant request takes the kind of the existing entry. */
  readonly kind?: VaultEntryKind;
}

export type VaultRequestResult =
  | { status: 'available'; name: string }
  | {
      status: 'pending' | 'already_pending';
      requestId: string;
      type: VaultRequestType;
      name: string;
      expiresAt: number;
    };

type RequestStorage = Pick<AgentStorage, 'getAgent'> &
  Pick<VaultEntryStorage, 'listVaultEntries' | 'listVaultUseFamilyApprovals'>;

/**
 * The entry a request for `name` asks to have granted, or null when it asks for a new
 * one. The project's own entry wins over a shared one.
 */
export async function findRequestedEntry(
  storage: Pick<VaultEntryStorage, 'listVaultEntries'>,
  projectId: string,
  name: string,
): Promise<VaultEntry | null> {
  const sameName = (await storage.listVaultEntries({ projectId })).filter(
    (entry) => entry.name === name,
  );
  return sameName.find((entry) => entry.projectId === projectId) ?? sameName[0] ?? null;
}

/**
 * How a request for `name` is classified: `grant` the entry that exists, or `create`
 * a new one of `fallbackKind`. The request service and home's mirror of VM requests
 * share this rule, so one request classifies the same wherever it is raised.
 */
export async function classifyRequest(
  storage: Pick<VaultEntryStorage, 'listVaultEntries'>,
  projectId: string,
  name: string,
  fallbackKind: VaultEntryKind,
): Promise<{ type: VaultRequestType; entryId: string | null; kind: VaultEntryKind }> {
  const existing = await findRequestedEntry(storage, projectId, name);
  return {
    type: existing ? 'grant' : 'create',
    entryId: existing?.id ?? null,
    kind: existing?.kind ?? fallbackKind,
  };
}

/**
 * Turns an agent's ask for a Vault entry into a pending request for the user. The
 * caller's project and family come from its session, never from the request. A claimed
 * VM keeps the request in its own store; only home answers it.
 */
@Injectable()
export class VaultRequestService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RequestStorage,
    private readonly access: VaultAccessService,
    private readonly entries: VaultEntriesService,
    private readonly store: VaultRequestStore,
    private readonly approvals: VaultUseApprovalStore,
  ) {}

  async request(input: VaultRequestInput): Promise<VaultRequestResult> {
    const agent = await this.storage.getAgent(input.agentId);
    const { familySlug, stored, sessionValues } = await this.access.grantedForSession(
      agent,
      input.sessionId,
    );
    this.entries.assertEntryName(input.name);

    const granted = stored.find((entry) => entry.name === input.name);
    if (
      sessionValues.some((value) => value.name === input.name) ||
      (granted && (await this.usable(granted, agent.projectId, input.sessionId, familySlug)))
    ) {
      return { status: 'available', name: input.name };
    }

    const { request, created } = await this.store.add({
      projectId: agent.projectId,
      sessionId: input.sessionId,
      agentId: agent.id,
      agentName: agent.name,
      familySlug,
      name: input.name,
      description: input.description,
      // A granted name reaches here only when it still needs the user's approval.
      ...(granted
        ? { type: 'use' as const, entryId: granted.id, kind: granted.kind }
        : await classifyRequest(this.storage, agent.projectId, input.name, input.kind ?? 'secret')),
    });
    return {
      status: created ? 'pending' : 'already_pending',
      requestId: request.requestId,
      type: request.type,
      name: request.name,
      expiresAt: request.expiresAt,
    };
  }

  /**
   * Whether the session may use a granted entry without asking, by the gate's own
   * `useStanding` rule; asking here is how the agent gets past a denial. A one-shot
   * token does not count: the agent asks for lasting use, and the rule never reads them.
   */
  private async usable(
    entry: VaultResolvedEntry,
    projectId: string,
    sessionId: string,
    familySlug: string | null,
  ): Promise<boolean> {
    const familyApproved =
      entry.approvalRequired &&
      familySlug !== null &&
      (await hasVaultFamilyApproval(this.storage, entry.id, projectId, familySlug));
    return useStanding(this.approvals, sessionId, entry, familyApproved) === 'approved';
  }
}
