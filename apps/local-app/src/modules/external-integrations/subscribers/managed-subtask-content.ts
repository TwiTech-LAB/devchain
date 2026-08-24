import type { IntegrationProvider } from '../../storage/models/domain.models';
import type { ExternalSubtaskSnapshot } from '../models/external-provider.models';

interface DesiredManagedSubtaskContent {
  title: string;
  description: string | null;
}

function canonicalClickUpMarkdown(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value
    .replace(/\r\n/g, '\n')
    .replace(/^(\s*)[-*+]\s+/gm, '$1- ')
    .replace(/\\([\\`*_[\]<>#\-+])/g, '$1');
}

/** Compare only content DevChain owns after applying provider read-back rules. */
export function managedSubtaskContentMatches(
  provider: IntegrationProvider,
  snapshot: ExternalSubtaskSnapshot,
  desired: DesiredManagedSubtaskContent,
): boolean {
  if (snapshot.title !== desired.title) {
    return false;
  }
  if (provider === 'clickup') {
    return (
      canonicalClickUpMarkdown(snapshot.description) ===
      canonicalClickUpMarkdown(desired.description)
    );
  }
  return snapshot.description === desired.description;
}
