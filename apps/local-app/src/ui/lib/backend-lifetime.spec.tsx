/** @jest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { BackendProvider } from './backend-provider';
import { MemoryRouter } from 'react-router-dom';
import { BackendBoundary, ProjectGate } from '@/ui/components/BackendBoundary';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: () => ({}) }));

let mockSelectedProjectId = 'remote-project';
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: mockSelectedProjectId }),
}));

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';
const originalFetch = global.fetch;
const requests: string[] = [];
let releaseSave: (() => void) | undefined;
let save: (() => Promise<unknown>) | undefined;

function ProfileSavePage() {
  const fetchFn = useFetchFactory();
  const mutation = useMutation({
    mutationFn: () => fetchFn('/api/profiles/profile-a', { method: 'PUT' }),
    // Same two-request sequence as the profile update followed by the prompt-order save.
    onSuccess: async () => {
      await fetchFn('/api/profiles/profile-a/prompts', { method: 'PUT' });
    },
  });
  save = () => mutation.mutateAsync();
  return <div data-testid="page">mounted</div>;
}

function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/profiles']}>
        <BackendProvider>
          <BackendBoundary>
            <ProjectGate scope="page">
              <ProfileSavePage />
            </ProjectGate>
          </BackendBoundary>
        </BackendProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockSelectedProjectId = 'remote-project';
  requests.length = 0;
  releaseSave = undefined;
  save = undefined;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/api/profiles/profile-a')) {
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    }
    const items =
      url === '/api/remotes/bindings'
        ? [{ projectId: 'remote-project', remoteId: REMOTE_ID, state: 'remote' }]
        : [{ id: REMOTE_ID, name: 'remote', online: true, version: '1', versionMatches: true }];
    return { ok: true, status: 200, json: async () => ({ items }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('backend lifetime of a mounted subtree', () => {
  it('keeps every request of an in-flight mutation on the backend it started on', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(tree(client));
    await screen.findByTestId('page');

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = save!();
    });
    await waitFor(() => expect(requests).toContain(`/r/${REMOTE_ID}/api/profiles/profile-a`));

    mockSelectedProjectId = 'local-project';
    view.rerender(tree(client));
    await act(async () => {
      releaseSave!();
      await pending;
    });

    expect(requests).toContain(`/r/${REMOTE_ID}/api/profiles/profile-a/prompts`);
    expect(requests).not.toContain('/api/profiles/profile-a/prompts');
  });
});
