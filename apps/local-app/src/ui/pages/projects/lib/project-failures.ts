import type {
  ProjectPreMutationFailure,
  ProjectPromptReferenceFailure,
} from '@/ui/pages/projects/lib/project-contracts';

export function isProjectPreMutationFailure(value: unknown): value is ProjectPreMutationFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProjectPreMutationFailure>;
  return (
    candidate.success === false &&
    candidate.mutationStarted === false &&
    typeof candidate.error === 'string'
  );
}

export function isProjectPromptReferenceFailure(
  value: unknown,
): value is ProjectPromptReferenceFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProjectPromptReferenceFailure>;
  return (
    candidate.success === false &&
    candidate.mutationStarted === false &&
    candidate.promptReferenceValidation?.code === 'skipped_prompt_references' &&
    Array.isArray(candidate.promptReferenceValidation.promptTitles) &&
    Array.isArray(candidate.promptReferenceValidation.issues)
  );
}

export function formatProjectPromptReferenceFailure(
  failure: ProjectPromptReferenceFailure,
): string {
  const details = failure.promptReferenceValidation.issues
    .map(
      ({ promptTitle, profileNames }) =>
        `"${promptTitle}" (${profileNames.length > 0 ? `profiles: ${profileNames.join(', ')}` : 'referenced by a profile'})`,
    )
    .join('; ');
  return details ? `${failure.error}. ${details}` : failure.error;
}

export function formatProjectPreMutationFailure(failure: ProjectPreMutationFailure): string {
  if (isProjectPromptReferenceFailure(failure)) {
    return formatProjectPromptReferenceFailure(failure);
  }
  const issueMessages =
    failure.readiness?.issues.map((issue) =>
      issue.code === 'provider_mapping_required'
        ? 'A selected provider cannot run one or more agents. Select another provider.'
        : issue.message,
    ) ?? [];
  return issueMessages.length > 0 ? issueMessages.join(' ') : failure.error;
}
