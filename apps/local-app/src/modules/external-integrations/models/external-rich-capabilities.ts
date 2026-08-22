/**
 * Runtime capability flags mirroring the Phase 13 gate evidence
 * (`reports/phase13-gate-evidence.json`, produced by
 * `adapters/rich/phase13-gate-smoke.external.spec.ts`). Every rich-edit or
 * owned-delete route checks its flag before doing work, so flipping a
 * decision to NO_GO disables the whole surface without route surgery.
 */
export const EXTERNAL_RICH_CAPABILITIES = {
  /** Phase 13 RICH_EDIT_GO: Jira + ClickUp rich descriptions and owned comments round-trip losslessly. */
  richEdit: true,
  /** Phase 13 OWNED_DELETE_GO: both providers support bounded owner revalidation and deletion. */
  ownedDelete: true,
} as const;

export type ExternalRichCapabilityFlags = typeof EXTERNAL_RICH_CAPABILITIES;

export const EXTERNAL_RICH_CAPABILITIES_TOKEN = Symbol('EXTERNAL_RICH_CAPABILITIES_TOKEN');
