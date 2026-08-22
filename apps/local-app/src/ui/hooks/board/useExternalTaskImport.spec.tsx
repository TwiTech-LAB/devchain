import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ExternalTaskDetail,
  ExternalTaskImportResponse,
} from '@/modules/external-integrations/models/external-provider.models';
import { externalMyWorkQueryKeys, epicExternalSourceQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalTaskImport } from './useExternalTaskImport';

const fetchMock = jest.fn();

// Layer: hook + real QueryClient. This proves the minimal wire response still drives
// both new/duplicate navigation data and the current epoch's batch-link cache update.
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const projectId = '11111111-1111-4111-8111-111111111111';
const statusId = '22222222-2222-4222-8222-222222222222';
const connectionEpoch = 'connection-jira-a:1';
const detail: ExternalTaskDetail = {
  remoteId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Remote title',
  description: 'Remote description',
  descriptionTruncated: false,
  status: { remoteId: '1', name: 'In Progress', color: '#777777', category: 'active', position: 0 },
  dueAt: null,
  priority: null,
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  location: { scopeKey: 'acme.atlassian.net', workAreaId: '42', workAreaName: 'Delivery' },
  allowedStatuses: [],
  actions: [],
  linkState: { linked: false, epicId: null },
};

describe('useExternalTaskImport', () => {
  beforeEach(() => fetchMock.mockReset());

  it.each([true, false])(
    'returns the minimal public response and updates links when created=%s',
    async (created) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const epicId = created ? 'epic-new' : 'epic-existing';
      const resultPayload: ExternalTaskImportResponse = {
        epic: { id: epicId, projectId },
        created,
      };
      const linkInputs = [{ scopeKey: detail.location.scopeKey, taskId: detail.remoteId }];
      const linkKey = [
        ...externalMyWorkQueryKeys.links('jira', connectionEpoch),
        linkInputs,
      ] as const;
      client.setQueryData(linkKey, {
        items: [
          {
            ...linkInputs[0],
            linked: false,
            epicId: null,
            projectId: null,
            projectName: null,
          },
        ],
      });
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/projects')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [{ id: projectId, name: 'Product' }] }),
          });
        }
        if (url.startsWith('/api/statuses')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: [{ id: statusId, projectId, label: 'New', color: '#777777', position: 0 }],
            }),
          });
        }
        expect(init?.method).toBe('POST');
        return Promise.resolve({ ok: true, json: async () => resultPayload });
      });

      const { result } = renderHook(
        () => useExternalTaskImport('jira', detail, projectId, { connectionEpoch }),
        { wrapper: wrapper(client) },
      );
      await waitFor(() => expect(result.current.projects.isSuccess).toBe(true));
      await waitFor(() => expect(result.current.statuses.isSuccess).toBe(true));

      let imported: ExternalTaskImportResponse | undefined;
      await act(async () => {
        imported = await result.current.mutation.mutateAsync({
          projectId,
          statusId,
          title: 'Edited title',
          description: 'Edited description',
        });
      });

      const importCall = fetchMock.mock.calls.find(
        ([url]) => url === '/api/epics/import-external-task',
      );
      expect(JSON.parse(importCall?.[1]?.body as string)).toEqual(
        expect.objectContaining({
          projectId,
          statusId,
          agentId: null,
          title: 'Edited title',
          description: 'Edited description',
          remote: expect.objectContaining({ title: 'Remote title', taskId: 'ENG-1' }),
        }),
      );
      expect(imported).toEqual({ created, epic: { id: epicId, projectId } });
      expect(client.getQueryData(linkKey)).toEqual({
        items: [
          {
            ...linkInputs[0],
            linked: true,
            epicId,
            projectId,
            projectName: 'Product',
          },
        ],
      });
      // A new stored source must stale every Board batch entry and the
      // Epic-detail source read.
      expect(client.getQueryState(epicExternalSourceQueryKeys.all)).toBeUndefined();
      const seededBatch = epicExternalSourceQueryKeys.batch(['epic-seed']);
      client.setQueryData(seededBatch, { items: [] });
      const invalidated: string[] = [];
      const originalInvalidate = client.invalidateQueries.bind(client);
      jest.spyOn(client, 'invalidateQueries').mockImplementation(async (filters) => {
        invalidated.push(JSON.stringify((filters as { queryKey: unknown }).queryKey));
        return originalInvalidate(filters as never);
      });
      await act(async () => {
        await result.current.mutation.mutateAsync({
          projectId,
          statusId,
          title: 'Again',
          description: 'Again',
        });
      });
      expect(invalidated).toContain(JSON.stringify(epicExternalSourceQueryKeys.all));
      client.clear();
    },
  );

  it('issues no project, status, or mutation request while disabled', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () =>
        useExternalTaskImport('jira', detail, projectId, {
          enabled: false,
          connectionEpoch,
        }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.projects.data).toBeUndefined();
    expect(result.current.statuses.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    client.clear();
  });
});
