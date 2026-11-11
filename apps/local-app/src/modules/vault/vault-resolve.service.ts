import { rm } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  VaultAccessRefusedError,
} from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import {
  STORAGE_SERVICE,
  type AgentStorage,
  type GuestStorage,
  type VaultEntryStorage,
} from '../storage/interfaces/storage.interface';
import type { Agent, VaultEntryKind } from '../storage/models/domain.models';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService, type VaultGrantedView } from './vault-access.service';
import {
  vaultSessionFilePath,
  vaultSessionFilesDirectory,
  writeVaultSessionFiles,
} from './vault-session-files';
import { VaultUseGate } from './vault-use-gate';
import { VaultValueReader } from './vault-value-reader';

const logger = createLogger('VaultResolveService');

const FULL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plaintext for the caller session: `env` maps a `secret` name to its value, `files`
 * maps a `file` name to the absolute path of its 0600 file. Never log it.
 * `needsApproval` names granted entries a call without names left out because they
 * wait for the user's approval; it is always empty for a call with names.
 */
export interface VaultResolveResult {
  env: Record<string, string>;
  files: Record<string, string>;
  needsApproval: string[];
}

type ResolveStorage = Pick<AgentStorage, 'getAgent'> &
  Pick<GuestStorage, 'getGuest'> &
  Pick<VaultEntryStorage, 'markVaultEntriesUsed'>;

interface ResolvedValue {
  name: string;
  kind: VaultEntryKind;
  value: Buffer;
}

/**
 * The only path that hands Vault values out. Authorization uses backend facts only:
 * the exact id of a running agent session gives the agent, its project and its
 * profile family. Each call reads current values, so a changed entry needs no restart.
 */
@Injectable()
export class VaultResolveService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ResolveStorage,
    private readonly sessionRows: SessionRowStore,
    private readonly access: VaultAccessService,
    private readonly values: VaultValueReader,
    private readonly runtimeDirectory: RuntimeDirectoryService,
    private readonly gate: VaultUseGate,
  ) {}

  /**
   * All granted entries, or only `names`; one name outside the grants refuses all.
   * Entries that need the user's approval pass `VaultUseGate` first.
   */
  async resolve(sessionId: string, names?: readonly string[]): Promise<VaultResolveResult> {
    // Prefixes are public (`devchain_list_sessions`), so only the full id authorizes.
    if (!FULL_SESSION_ID.test(sessionId)) {
      throw new ValidationError('Give the full session id from DEVCHAIN_SESSION_ID.', {
        code: 'VAULT_SESSION_ID_INVALID',
      });
    }
    const agent = await this.requireAgentSession(sessionId);
    let view: VaultGrantedView;
    try {
      view = await this.access.grantedForSession(agent, sessionId);
    } catch (error) {
      // Files from earlier resolves must not outlive a revoked access.
      if (error instanceof VaultAccessRefusedError) await this.pruneSessionFiles(sessionId);
      throw error;
    }
    const { stored, sessionValues } = view;

    const granted = [...stored, ...sessionValues];
    const grantedNames = new Set(granted.map((entry) => entry.name));
    const wanted = names ? new Set(names) : grantedNames;
    const missing = [...wanted].filter((name) => !grantedNames.has(name));
    if (missing.length > 0) {
      // Entry names are not confidential; the CLI shows them to the agent.
      throw new ForbiddenError('A requested name is not granted to this session.', {
        code: 'VAULT_ENTRY_NOT_GRANTED',
        names: missing,
      });
    }

    const decision = await this.gate.decide({
      sessionId,
      agent,
      familySlug: view.familySlug,
      granted: stored,
      wanted: stored.filter((entry) => wanted.has(entry.name)),
      explicit: names !== undefined,
    });
    try {
      const resolved: ResolvedValue[] = [];
      const usedIds: string[] = [];
      const read = await this.values.read(decision.allowed);
      for (const entry of decision.allowed) {
        const value = read.get(entry.id);
        // Deleted between resolution and read: the caller simply does not get it.
        if (value === undefined) continue;
        resolved.push({ name: entry.name, kind: entry.kind, value });
        usedIds.push(entry.id);
      }
      resolved.push(...sessionValues.filter((value) => wanted.has(value.name)));

      const result = await this.deliver(
        sessionId,
        resolved,
        new Set(
          granted
            .filter((entry) => entry.kind === 'file' && !decision.withheldFileNames.has(entry.name))
            .map((entry) => entry.name),
        ),
      );
      decision.reservation.commit();
      await this.storage.markVaultEntriesUsed(usedIds, new Date().toISOString());
      logger.info(
        { session: sessionId.slice(0, 8), entries: resolved.length },
        'Resolved Vault values for a session',
      );
      return { ...result, needsApproval: [...decision.needsApproval] };
    } catch (error) {
      // After `commit()` a release does nothing, so a failed `markVaultEntriesUsed`
      // cannot give a token back.
      decision.reservation.release();
      throw error;
    }
  }

  private async pruneSessionFiles(sessionId: string): Promise<void> {
    try {
      const { path: root } = await this.runtimeDirectory.resolve();
      await rm(vaultSessionFilesDirectory(root, sessionId), { recursive: true, force: true });
    } catch (error) {
      // The session teardown and the startup sweep stay the backstop.
      logger.warn(
        { session: sessionId.slice(0, 8), error: error instanceof Error ? error.name : 'unknown' },
        'Failed to prune Vault session files after an access refusal',
      );
    }
  }

  private async requireAgentSession(sessionId: string): Promise<Agent> {
    const session = this.sessionRows.getSession(sessionId);
    if (!session) {
      if (await this.isGuest(sessionId)) throw agentSessionRequired();
      throw sessionNotActive();
    }
    if (!session.agentId) throw agentSessionRequired();
    if (session.status !== 'running') throw sessionNotActive();
    try {
      return await this.storage.getAgent(session.agentId);
    } catch (error) {
      if (error instanceof NotFoundError) throw sessionNotActive();
      throw error;
    }
  }

  private async isGuest(id: string): Promise<boolean> {
    try {
      await this.storage.getGuest(id);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  private async deliver(
    sessionId: string,
    resolved: readonly ResolvedValue[],
    grantedFileNames: ReadonlySet<string>,
  ): Promise<Omit<VaultResolveResult, 'needsApproval'>> {
    const env: Record<string, string> = {};
    const fileValues: ResolvedValue[] = [];
    for (const entry of resolved) {
      if (entry.kind === 'secret') env[entry.name] = entry.value.toString('utf8');
      else fileValues.push(entry);
    }
    const { path: root } = await this.runtimeDirectory.resolve();
    const directory = vaultSessionFilesDirectory(root, sessionId);
    await writeVaultSessionFiles(
      directory,
      fileValues.map((entry) => ({ name: entry.name, content: entry.value })),
      grantedFileNames,
    );
    const files = Object.fromEntries(
      fileValues.map((entry) => [entry.name, vaultSessionFilePath(directory, entry.name)]),
    );
    return { env, files };
  }
}

function agentSessionRequired(): ForbiddenError {
  return new ForbiddenError('Vault values belong to agent sessions. Guests have none.', {
    code: 'VAULT_AGENT_SESSION_REQUIRED',
  });
}

function sessionNotActive(): ForbiddenError {
  return new ForbiddenError('No running agent session has this id.', {
    code: 'VAULT_SESSION_NOT_ACTIVE',
  });
}
