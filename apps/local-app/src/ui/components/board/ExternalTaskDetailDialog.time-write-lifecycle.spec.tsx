import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { ExternalTaskDetailDialog } from './ExternalTaskDetailDialog';

const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

jest.mock('@/ui/hooks/board/useExternalRichDescriptionEdit', () => ({
  useExternalRichDescriptionEdit: () => ({}),
}));

jest.mock('@/ui/components/board/ExternalTaskRichDescription', () => ({
  ExternalTaskRichDescription: () => <section aria-label="Remote description" />,
}));

jest.mock('@/ui/components/board/ExternalTaskCommentsPanel', () => ({
  ExternalTaskCommentsPanel: () => <section aria-label="Remote comments" />,
}));

jest.mock('@/ui/hooks/useEpicTimeDetail', () => ({
  useEpicTimeDetail: () => ({
    admitted: false,
    summary: undefined,
    query: { isLoading: false, isError: false },
  }),
}));

const detail: ExternalTaskDetail = {
  remoteId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Retain time write ownership',
  description: 'Description',
  descriptionTruncated: false,
  status: {
    remoteId: 'status-progress',
    remoteStatusIds: ['status-progress'],
    name: 'In Progress',
    color: '#6b778c',
    category: 'active',
    position: 0,
  },
  dueAt: null,
  priority: null,
  subtasks: [],
  subtasksTruncated: false,
  taskTotalDurationMs: 5_400_000,
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  location: { scopeKey: 'acme.atlassian.net', workAreaId: 'board-1', workAreaName: 'Sprint' },
  allowedStatuses: [],
  actions: [
    { action: 'change_status', supported: false },
    { action: 'add_comment', supported: false },
    { action: 'log_time', supported: true },
  ],
  linkState: { linked: true, epicId: 'epic-1' },
};

const history = {
  windowDays: 30,
  entries: [
    {
      remoteId: 'entry-1',
      durationMs: 1_800_000,
      startedAt: '2026-08-23T10:00:00.000Z',
      note: 'Existing entry',
      noteTruncated: false,
      canDelete: true,
    },
  ],
  truncated: false,
  hasRunningTimer: false,
};

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload };
}

function deferredResponse() {
  let resolve: ((response: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
  return {
    promise: new Promise<{ ok: boolean; json: () => Promise<unknown> }>((settle) => {
      resolve = settle;
    }),
    resolve: (payload: unknown) => resolve?.(jsonResponse(payload)),
  };
}

function renderLifecycleDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let setEpoch: ((epoch: IntegrationConnectionEpoch) => void) | undefined;
  function Harness() {
    const [connectionEpoch, updateEpoch] =
      useState<IntegrationConnectionEpoch>('connection-jira-a:4');
    setEpoch = updateEpoch;
    return (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ExternalTaskDetailDialog
            provider="jira"
            taskId="ENG-1"
            open
            onOpenChange={jest.fn()}
            connectionEpoch={connectionEpoch}
            expectedLinkedEpicId="epic-1"
          />
        </QueryClientProvider>
      </MemoryRouter>
    );
  }
  const view = render(<Harness />);
  return {
    ...view,
    client,
    replaceEpoch: () => {
      if (!setEpoch) throw new Error('Dialog epoch setter is unavailable.');
      setEpoch('connection-jira-b:5');
    },
  };
}

async function openTimeAndHistory(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Expand Time tracked' }));
  await user.click(screen.getByText('Recent time entries', { selector: 'summary' }));
  await screen.findByText('Existing entry');
}

describe('ExternalTaskDetailDialog time-write lifecycle', () => {
  let uuidSpy: jest.SpyInstance;
  let initialDetailDelivered: boolean;

  beforeEach(() => {
    fetchMock.mockReset();
    initialDetailDelivered = false;
    uuidSpy = jest.spyOn(window.crypto, 'randomUUID').mockReturnValue('write-operation-id');
  });

  afterEach(() => uuidSpy.mockRestore());

  function serveLifecycle(
    write: ReturnType<typeof deferredResponse>,
    replacementDetail: ReturnType<typeof deferredResponse>,
  ): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/tasks/ENG-1')) {
        if (!initialDetailDelivered) {
          initialDetailDelivered = true;
          return Promise.resolve(jsonResponse(detail));
        }
        return replacementDetail.promise;
      }
      if (path.endsWith('/comments')) {
        return Promise.resolve(jsonResponse({ comments: [], nextCursor: null }));
      }
      if (path.endsWith('/time-entries') && !init?.method) {
        return Promise.resolve(jsonResponse(history));
      }
      if (path.endsWith('/time-entries') && init?.method === 'POST') {
        return write.promise;
      }
      if (path.endsWith('/time-entries/entry-1') && init?.method === 'DELETE') {
        return write.promise;
      }
      if (path.includes('/acknowledge')) {
        return Promise.resolve(
          jsonResponse({ operationId: 'late-unknown', phase: 'abandoned_unknown' }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  }

  async function evictDetailAndPublishReplacement(
    client: QueryClient,
    replaceEpoch: () => void,
    replacementDetail: ReturnType<typeof deferredResponse>,
  ): Promise<void> {
    await act(async () => {
      await client.cancelQueries({ queryKey: externalMyWorkQueryKeys.provider('jira') });
      client.removeQueries({ queryKey: externalMyWorkQueryKeys.provider('jira') });
      replaceEpoch();
    });
    await waitFor(() =>
      expect(document.getElementById('external-task-time-heading')).not.toBeInTheDocument(),
    );
    replacementDetail.resolve(detail);
    await screen.findByRole('heading', { name: 'Time tracked' });
  }

  it('retains a pending create through detail eviction and turns its late unknown into the same-task lock', async () => {
    const write = deferredResponse();
    const replacementDetail = deferredResponse();
    serveLifecycle(write, replacementDetail);
    const user = userEvent.setup();
    const { client, replaceEpoch } = renderLifecycleDialog();
    await screen.findByRole('heading', { name: 'Time tracked' });
    await user.click(screen.getByRole('button', { name: 'Expand Time tracked' }));
    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.click(screen.getByRole('button', { name: 'Log time' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith('/time-entries') &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toHaveLength(1),
    );

    await evictDetailAndPublishReplacement(client, replaceEpoch, replacementDetail);
    await openTimeAndHistory();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete 30m entry started/ })).toBeDisabled();

    write.resolve({
      outcome: 'outcome_unknown',
      receipt: { operationId: 'late-unknown', phase: 'outcome_unknown' },
    });
    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();
    const unknownAlert = screen.getByText('Last submission unconfirmed').closest('[role="alert"]')!;
    expect(within(unknownAlert).queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(within(unknownAlert).getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(
      within(unknownAlert).getByRole('button', { name: 'Acknowledge duplicate risk' }),
    ).toBeVisible();

    await user.click(
      within(unknownAlert).getByRole('button', { name: 'Acknowledge duplicate risk' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Delete 30m entry started/ })).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/time-entries') &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('retains a pending delete through detail eviction and clears it without stale presentation', async () => {
    const write = deferredResponse();
    const replacementDetail = deferredResponse();
    serveLifecycle(write, replacementDetail);
    const user = userEvent.setup();
    const { client, replaceEpoch } = renderLifecycleDialog();
    await screen.findByRole('heading', { name: 'Time tracked' });
    await openTimeAndHistory();
    await user.click(screen.getByRole('button', { name: /Delete 30m entry started/ }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete entry' }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith('/time-entries/entry-1') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toHaveLength(1),
    );

    await evictDetailAndPublishReplacement(client, replaceEpoch, replacementDetail);
    await openTimeAndHistory();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete 30m entry started/ })).toBeDisabled();

    write.resolve({
      outcome: 'deleted',
      receipt: { operationId: 'write-operation-id', phase: 'succeeded' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Delete 30m entry started/ })).toBeEnabled();
    expect(screen.getByRole('status', { hidden: true })).not.toHaveTextContent(
      'Time entry deleted.',
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/time-entries/entry-1') &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });
});
