import { getEnvConfig, type EnvConfig } from './env.config';

type ContainerScopeConfig = Pick<EnvConfig, 'DEVCHAIN_MODE' | 'CONTAINER_PROJECT_ID'>;

export function getContainerScopedProjectId(
  env: ContainerScopeConfig = getEnvConfig(),
): string | null {
  if (env.DEVCHAIN_MODE !== 'normal') {
    return null;
  }

  return env.CONTAINER_PROJECT_ID ?? null;
}
