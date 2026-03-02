export const providerModelQueryKeys = {
  all: ['provider-models'] as const,
  byContext: (context: string, providerId: string) =>
    ['provider-models', context, providerId] as const,
  main: (providerId: string) => ['provider-models', 'main', providerId] as const,
};
