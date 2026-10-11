import { COMPOSE_PROJECT_LABEL } from '../host/host-docker.dto';
import { within } from './docker-plan-files';

export const DEFAULT_COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
] as const;

export function containerLinksProject(
  labels: Readonly<Record<string, string>> | null | undefined,
  mounts: readonly { Type: string; Source?: string }[] | null | undefined,
  root: string,
): boolean {
  return (
    composeRootLinks(labels ?? {}, root).length > 0 ||
    (mounts?.some(
      (mount) => mount.Type === 'bind' && !!mount.Source && within(root, mount.Source),
    ) ??
      false)
  );
}

/** The Compose working_dir and config_files labels that point inside the project root. */
export function composeRootLinks(labels: Readonly<Record<string, string>>, root: string): string[] {
  return [`${COMPOSE_PROJECT_LABEL}.working_dir`, `${COMPOSE_PROJECT_LABEL}.config_files`].filter(
    (key) =>
      typeof labels[key] === 'string' &&
      labels[key].split(',').some((path) => path.startsWith('/') && within(root, path)),
  );
}

/** A Compose container linked to the project root; the caller has already vetoed a foreign owner. */
export function projectCompose(labels: Readonly<Record<string, string>>, root: string): boolean {
  if (!labels[COMPOSE_PROJECT_LABEL]) return false;
  return composeRootLinks(labels, root).length > 0;
}
