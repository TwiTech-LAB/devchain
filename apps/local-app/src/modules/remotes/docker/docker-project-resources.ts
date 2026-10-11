import { COMPOSE_PROJECT_LABEL, DOCKER_PROJECT_LABEL } from '../host/host-docker.dto';
import { within } from './docker-plan-files';
import { projectCompose } from './docker-project-compose';

interface ProjectContainer {
  labels: Readonly<Record<string, string>>;
  mounts: readonly { type: string; source?: string }[];
}
interface ProjectVolume {
  labels: Readonly<Record<string, string>>;
}

/** True when the DevChain project label is set and names another project. */
export function foreignProjectOwner(
  labels: Readonly<Record<string, string>> | undefined,
  projectId: string,
): boolean {
  const owner = labels?.[DOCKER_PROJECT_LABEL];
  return owner !== undefined && owner !== projectId;
}

/** A foreign DevChain owner vetoes even a Compose path or bind inside this project. */
export function projectContainer(
  container: ProjectContainer,
  projectRoot: string | undefined,
  projectId: string,
  volumes: readonly ProjectVolume[] = [],
): boolean {
  if (foreignProjectOwner(container.labels, projectId)) return false;
  return (
    container.labels[DOCKER_PROJECT_LABEL] === projectId ||
    (projectRoot !== undefined &&
      (projectCompose(container.labels, projectRoot) ||
        container.mounts.some(
          (mount) => mount.type === 'bind' && mount.source && within(projectRoot, mount.source),
        ))) ||
    // Only an ownerless container reaches here: a matching owner returned above.
    (Boolean(container.labels[COMPOSE_PROJECT_LABEL]) &&
      volumes.some(
        (volume) =>
          volume.labels[DOCKER_PROJECT_LABEL] === projectId &&
          volume.labels[COMPOSE_PROJECT_LABEL] === container.labels[COMPOSE_PROJECT_LABEL],
      ))
  );
}

/** Compose volumes derive association from this engine's project containers, never their names. */
export function projectVolume(
  labels: Readonly<Record<string, string>>,
  containers: readonly ProjectContainer[],
  projectRoot: string | undefined,
  projectId: string,
  volumes: readonly ProjectVolume[] = [],
): boolean {
  if (foreignProjectOwner(labels, projectId)) return false;
  const compose = labels[COMPOSE_PROJECT_LABEL];
  return (
    labels[DOCKER_PROJECT_LABEL] === projectId ||
    (Boolean(compose) &&
      containers.some(
        (container) =>
          container.labels[COMPOSE_PROJECT_LABEL] === compose &&
          projectContainer(container, projectRoot, projectId, volumes),
      ))
  );
}
