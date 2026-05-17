import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';

export function createNullAdapter<T extends object>(serviceName: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'toJSON') return undefined;
      if (typeof prop === 'symbol') return undefined;
      return (..._args: unknown[]) => {
        throw new ServiceUnavailableError(serviceName);
      };
    },
  });
}
