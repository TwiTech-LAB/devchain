import { HostResolver } from '@devchain/shared';

export { HostResolver };

export function getRuntimeInternalBaseUrl(config: { HOST: string; PORT: number }): string {
  return HostResolver.buildInternalBaseUrl({ host: config.HOST, port: config.PORT });
}

export const { isWildcardHost, connectableHost, formatHostForUrl } = HostResolver;
