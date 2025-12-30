// Jest-only shim for @devchain/shared.
//
// The real @devchain/shared package is published as ESM, which Jest (CJS) in local-app
// can't import without additional ESM configuration. For tests, we re-export the same
// implementations directly from the workspace TypeScript sources.

export { ExportSchema, ManifestSchema } from '../../../../packages/shared/src/schemas/export-schema';

export {
  parseSemVer,
  isValidSemVer,
  compareSemVer,
  isGreaterThan,
  isLessThan,
  isEqual,
  sortVersions,
  getLatestVersion,
  formatSemVer,
} from '../../../../packages/shared/src/utils/semver';
