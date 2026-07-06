export const providerEffortQueryKeys = {
  all: ['provider-efforts'] as const,
  byContext: (context: string, providerId: string) =>
    ['provider-efforts', context, providerId] as const,
  main: (providerId: string) => ['provider-efforts', 'main', providerId] as const,
};
