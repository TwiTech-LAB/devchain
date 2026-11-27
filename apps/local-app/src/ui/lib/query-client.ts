import { QueryClient } from '@tanstack/react-query';

/** The app's query client defaults; per-query options override them. */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
