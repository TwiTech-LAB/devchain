import type { BackendId } from './api-transport';

export const providerModelQueryKeys = {
  all: ['provider-models'] as const,
  /** Provider ids are per instance, so the backend that answers is part of the key. */
  main: (providerId: string, backend: BackendId) =>
    ['provider-models', 'main', providerId, backend] as const,
};
