import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

export interface IntegrationPresentationScope {
  projectId: string;
  provider: ExternalBoardProvider;
  connectionEpoch: IntegrationConnectionEpoch;
  taskId: string;
}

export function isSameIntegrationPresentationScope(
  left: IntegrationPresentationScope | null,
  right: IntegrationPresentationScope | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.projectId === right.projectId &&
    left.provider === right.provider &&
    left.connectionEpoch === right.connectionEpoch &&
    left.taskId === right.taskId
  );
}

export function validIntegrationProjectId(projectId: string | null | undefined): string | null {
  return typeof projectId === 'string' && projectId.trim() !== '' ? projectId : null;
}

export function requireIntegrationProjectId(projectId: string | null | undefined): string {
  const validProjectId = validIntegrationProjectId(projectId);
  if (validProjectId === null) {
    throw new Error('A valid selected project is required for integration requests.');
  }
  return validProjectId;
}

export function withIntegrationProjectId(
  url: string,
  projectId: string | null | undefined,
): string {
  const validProjectId = requireIntegrationProjectId(projectId);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}projectId=${encodeURIComponent(validProjectId)}`;
}
