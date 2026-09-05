import type { QueryFunctionContext } from '@tanstack/react-query';
import { externalTaskDetailQueryOptions } from './external-task-detail-query';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';

// Layer: pure unit. The helper is a data-only factory; asserting its key, URL,
// gating, and error text here keeps hook suites free of options-shape coupling.
const mockFetch = jest.fn();
const PROJECT_ID = 'project-1';

const detail = {
  remoteId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Ship actions',
  description: null,
  descriptionTruncated: false,
  status: {
    remoteId: 'status-open',
    name: 'Open',
    color: '#6b778c',
    category: 'active',
    position: 0,
  },
  dueAt: null,
  priority: null,
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  location: { scopeKey: 'acme.atlassian.net', workAreaId: 'board-1', workAreaName: 'Board' },
  allowedStatuses: [],
  actions: [],
  linkState: { linked: false, epicId: null },
};

function context(signal?: AbortSignal): QueryFunctionContext {
  return { signal } as unknown as QueryFunctionContext;
}

describe('externalTaskDetailQueryOptions', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('builds the canonical key and encoded provider URL with the shared fetch', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => detail });
    const options = externalTaskDetailQueryOptions(
      mockFetch,
      'jira',
      'conn-a:2',
      PROJECT_ID,
      'ENG 1/2',
    );

    expect(options.queryKey).toEqual(
      externalMyWorkQueryKeys.taskDetail('jira', 'conn-a:2', 'ENG 1/2'),
    );
    expect(options.enabled).toBe(true);

    const signal = new AbortController().signal;
    await expect(options.queryFn!(context(signal))).resolves.toEqual(detail);
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/integrations/my-work/jira/tasks/ENG%201%2F2?projectId=${PROJECT_ID}`,
      { signal },
    );
  });

  it('stays disabled without a connection epoch, task id, or caller enablement', () => {
    expect(
      externalTaskDetailQueryOptions(mockFetch, 'jira', null, PROJECT_ID, 'ENG-1').enabled,
    ).toBe(false);
    expect(
      externalTaskDetailQueryOptions(mockFetch, 'jira', 'conn-a:2', PROJECT_ID, '').enabled,
    ).toBe(false);
    expect(
      externalTaskDetailQueryOptions(mockFetch, 'jira', 'conn-a:2', PROJECT_ID, 'ENG-1', {
        enabled: false,
      }).enabled,
    ).toBe(false);
  });

  it('surfaces the safe fallback text when the load fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => null });

    await expect(
      externalTaskDetailQueryOptions(mockFetch, 'jira', 'conn-a:2', PROJECT_ID, 'ENG-1').queryFn!(
        context(),
      ),
    ).rejects.toThrow('Task detail could not be loaded.');
  });
});
