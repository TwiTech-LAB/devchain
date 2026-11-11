/**
 * Vault access codec — owns the `vaultAccess` template section (the project's "Vault in
 * <project>" switch and its allowed families). Entries, grants and approvals never ride a
 * template; only the access mode does.
 *
 * - Absent section: access is left as it is (create: the Vault stays off).
 * - Present section: the project's access rows are replaced exactly. Family slugs that no
 *   profile of the project has are dropped and logged; when none is left the Vault is Off,
 *   never widened to "all agents".
 *
 * Runs LAST in both flows and is non-fatal: replace-import has no transaction, so a failure
 * here must not be able to leave later sections unapplied, and the storage write is a single
 * transaction, so a swallowed failure keeps the previous access. It writes through storage,
 * not VaultAccessService: that service refuses access changes while the Vault is locked and
 * ANY project is remote-bound, which would refuse unrelated local imports. ProjectWriteGate
 * already refuses imports into remote-owned projects before any section runs.
 */
import type { ExportVaultAccess } from '@devchain/shared';
import { createLogger } from '../../../../common/logging/logger';
import type { VaultFamilyAccess, VaultGrantAccess } from '../../../storage/models/domain.models';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

const logger = createLogger('VaultAccessCodec');

type VaultAccessSection = ExportVaultAccess | undefined;

const PROFILE_LIST_LIMIT = 10000;

const normalizeSlug = (slug: string): string => slug.trim().toLowerCase();

class VaultAccessCodec implements TemplateSectionCodec<VaultAccessSection> {
  readonly declaration = {
    section: 'vaultAccess',
    reads: [],
    writes: [],
    requiresState: ['profilesPersisted'],
    modes: ['replace', 'create'],
    onFailure: { replace: 'swallow', create: 'swallow' },
  } as const;

  pick(payload: ParsedTemplatePayload): VaultAccessSection {
    return payload.vaultAccess;
  }

  build() {
    // Export build is invoked directly by project-export via `buildExportVaultAccess`.
    return undefined;
  }

  async apply(
    vaultAccess: VaultAccessSection,
    _ctx: ImportContext,
    mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    if (!vaultAccess) {
      return { section: 'vaultAccess', log: { applied: false } };
    }

    const { projectId, storage } = rt;
    let access: VaultGrantAccess = { mode: 'all' };
    let droppedFamilySlugs: string[] = [];

    if (vaultAccess.mode === 'families') {
      const { items: profiles } = await storage.listAgentProfiles({
        projectId,
        limit: PROFILE_LIST_LIMIT,
        offset: 0,
      });
      const projectFamilies = new Set(
        profiles.flatMap((profile) =>
          profile.familySlug ? [normalizeSlug(profile.familySlug)] : [],
        ),
      );
      const wanted = [...new Set(vaultAccess.familySlugs.map(normalizeSlug))];
      const kept = wanted.filter((slug) => projectFamilies.has(slug));
      droppedFamilySlugs = wanted.filter((slug) => !projectFamilies.has(slug));
      if (droppedFamilySlugs.length > 0) {
        logger.warn(
          { projectId, mode, droppedFamilySlugs },
          'Dropped Vault access families that no imported profile has',
        );
      }
      access = kept.length > 0 ? { mode: 'families', familySlugs: kept } : { mode: 'none' };
    }

    await storage.setVaultFamilyAccess(projectId, access);
    const log = {
      applied: true,
      accessMode: access.mode,
      ...(access.mode === 'families' && { familySlugs: access.familySlugs }),
      ...(droppedFamilySlugs.length > 0 && { droppedFamilySlugs }),
    };
    logger.info({ projectId, mode, ...log }, 'Applied Vault access from template');
    return { section: 'vaultAccess', log };
  }
}

export const vaultAccessCodec = new VaultAccessCodec();

/**
 * The template value of a project's Vault access; undefined while the Vault is off.
 * Slugs no current profile has stay home, and a families list left empty omits the
 * field: it is never widened to all agents.
 */
export function buildExportVaultAccess(
  rows: readonly VaultFamilyAccess[],
): ExportVaultAccess | undefined {
  if (rows.some((row) => row.familySlug === null)) return { mode: 'all' };
  const familySlugs = rows.flatMap((row) =>
    row.familyMatched && row.familySlug !== null ? [row.familySlug] : [],
  );
  return familySlugs.length > 0 ? { mode: 'families', familySlugs } : undefined;
}
