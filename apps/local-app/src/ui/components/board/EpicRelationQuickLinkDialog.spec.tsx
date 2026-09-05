import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { EpicRelationQuickLinkDialog } from '@/ui/components/board/EpicRelationQuickLinkDialog';
import { epicRelationQueryKeys } from '@/ui/lib/epic-relations';
import type { Epic } from '@/ui/types';

const fetchMock = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

const useEpicExternalSourcesBatchMock = jest.fn();
jest.mock('@/ui/hooks/useEpicExternalSourcesBatch', () => ({
  useEpicExternalSourcesBatch: (...args: unknown[]) => useEpicExternalSourcesBatchMock(...args),
}));

function epic(id: string, title: string, parentId: string | null = null): Epic {
  return {
    id,
    projectId: 'project-1',
    title,
    description: null,
    statusId: 'status-1',
    version: 1,
    parentId,
    agentId: null,
    createdBy: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const source = epic('source-epic', 'Source Epic');
const target = epic('target-epic', 'Target Epic');

function renderDialog(confirmation: { source: Epic; target: Epic } | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onCancel = jest.fn();
  const onSuccess = jest.fn();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = render(
    <EpicRelationQuickLinkDialog
      confirmation={confirmation ?? { source, target }}
      onCancel={onCancel}
      onSuccess={onSuccess}
    />,
    { wrapper: Wrapper },
  );
  return { ...view, queryClient, onCancel, onSuccess };
}

describe('EpicRelationQuickLinkDialog', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ relationId: 'relation-1', type: 'related' }),
    } as Response);
    useEpicExternalSourcesBatchMock.mockReturnValue({
      sources: new Map(),
      query: { isSuccess: true },
    });
  });

  it('defaults to a Related link from the initiated Epic and shows one arrow', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Related' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Blocks' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Source Epic')).toBeInTheDocument();
    expect(screen.getByText('Target Epic')).toBeInTheDocument();
    // No time-route fieldset: the arrow is the only direction control.
    expect(screen.queryByText('Time route')).not.toBeInTheDocument();
    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Target Epic” logs time with “Source Epic”\./,
    );
    expect(screen.getByText(/replaces the current type/i)).toBeInTheDocument();
  });

  it('writes endpoint order as direction and invalidates badge batches for both endpoints', async () => {
    const user = userEvent.setup();
    const { queryClient, onSuccess } = renderDialog();
    const sourceBatch = epicRelationQueryKeys.batch([source.id]);
    const targetBatch = epicRelationQueryKeys.batch([target.id]);
    queryClient.setQueryData(sourceBatch, new Map());
    queryClient.setQueryData(targetBatch, new Map());

    await user.click(screen.getByRole('button', { name: 'Blocks' }));
    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Source Epic” blocks “Target Epic”\./,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm link' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/epics/${source.id}/relations/${target.id}`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ type: 'blocks' }),
        }),
      ),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryState(sourceBatch)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(targetBatch)?.isInvalidated).toBe(true);
  });

  it('writes the pair reversed after the arrow swaps source and target', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /Swap source and target/i }));
    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Source Epic” logs time with “Target Epic”\./,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm link' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/epics/${target.id}/relations/${source.id}`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ type: 'related' }),
        }),
      ),
    );
  });

  it('states that child endpoints do not affect Epic time', () => {
    renderDialog({ source, target: epic('target-epic', 'Target Epic', 'epic-parent') });

    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /does not affect Epic time/i,
    );
  });

  it('keeps the dialog open with a safe error and disables duplicate confirmation while pending', async () => {
    let resolveResponse!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const user = userEvent.setup();
    const { onSuccess } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Confirm link' }));
    expect(screen.getByRole('button', { name: 'Linking…' })).toBeDisabled();
    resolveResponse({
      ok: false,
      json: async () => ({ message: 'This Epic pair cannot be linked.' }),
    } as Response);

    expect(await screen.findByRole('alert')).toHaveTextContent('This Epic pair cannot be linked.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows the boundary warning when a linked managed projection joins an eligible draft', async () => {
    useEpicExternalSourcesBatchMock.mockReturnValue({
      sources: new Map([[target.id, {}]]),
      query: { isSuccess: true },
    });
    renderDialog();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Link boundary');
    expect(alert).toHaveTextContent('“Target Epic” is linked to an external task');
    expect(alert).toHaveTextContent('Time already logged to a provider does not move.');
    expect(screen.queryByRole('button', { name: 'Confirm link' })).toBeInTheDocument();
  });

  it('shows no boundary warning for eligible drafts between two unlinked endpoints', () => {
    renderDialog();

    expect(screen.queryByText('Link boundary')).not.toBeInTheDocument();
    expect(screen.queryByText(/is linked to an external task/)).not.toBeInTheDocument();
  });

  it('renders typed 409 facts and retries once with the exact accepted facts', async () => {
    const user = userEvent.setup();
    // The displaced route lives on another pair, so the retry is a
    // replacement that removes that old Related pair.
    const effect = { sourceEpicId: source.id, targetEpicId: 'epic-other' };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        statusCode: 409,
        code: 'relation_confirmation_required',
        message: 'Confirm the current route effect.',
        details: { currentEffect: effect },
      }),
    } as Response);
    const { onSuccess } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Confirm link' }));

    const alerts = await screen.findAllByRole('alert');
    const routeAlert = alerts.find((node) =>
      node.textContent?.includes('Confirm the current time route'),
    );
    expect(routeAlert).toBeDefined();
    expect(routeAlert).toHaveTextContent(
      'Current route: Epic epic-oth logs time with “Source Epic”.',
    );
    expect(routeAlert).toHaveTextContent('Saving removes the old Related pair');
    expect(routeAlert).toHaveTextContent('Time already logged to a provider does not move.');
    expect(screen.getByRole('button', { name: 'Accept route and save' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accept route and save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/epics/${source.id}/relations/${target.id}`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            type: 'related',
            confirmation: { acceptedRouteEffect: effect },
          }),
        }),
      ),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('replaces displayed 409 facts after a later refusal and retries with only the visible effect', async () => {
    const user = userEvent.setup();
    const effectA = { sourceEpicId: source.id, targetEpicId: 'epic-other-a' };
    const effectB = { sourceEpicId: source.id, targetEpicId: 'epic-other-b' };
    const conflict = (effect: { sourceEpicId: string; targetEpicId: string }): Response =>
      ({
        ok: false,
        status: 409,
        json: async () => ({
          statusCode: 409,
          code: 'relation_confirmation_required',
          message: 'Confirm the current route effect.',
          details: { currentEffect: effect },
        }),
      }) as Response;
    // 409(A) → retry echoes A → 409(B) → retry echoes B → success.
    fetchMock
      .mockResolvedValueOnce(conflict(effectA))
      .mockResolvedValueOnce(conflict(effectB))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ relationId: 'relation-1', type: 'related' }),
      } as Response);
    const { onSuccess } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Confirm link' }));
    let alert = await screen.findByRole('alert');
    await waitFor(() =>
      expect(alert).toHaveTextContent('Current route: Epic epic-oth logs time with “Source Epic”.'),
    );

    await user.click(screen.getByRole('button', { name: 'Accept route and save' }));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/epics/${source.id}/relations/${target.id}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ type: 'related', confirmation: { acceptedRouteEffect: effectA } }),
      }),
    );

    // The displayed facts are replaced in place, never appended or reused.
    alert = await screen.findByRole('alert');
    await waitFor(() =>
      expect(alert).toHaveTextContent('Current route: Epic epic-oth logs time with “Source Epic”.'),
    );
    expect(alert).not.toHaveTextContent('epic-other-a');

    await user.click(screen.getByRole('button', { name: 'Accept route and save' }));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/epics/${source.id}/relations/${target.id}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ type: 'related', confirmation: { acceptedRouteEffect: effectB } }),
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('clears the typed 409 when the draft changes and the next save is plain', async () => {
    const user = userEvent.setup();
    const effect = { sourceEpicId: source.id, targetEpicId: 'epic-other' };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        statusCode: 409,
        code: 'relation_confirmation_required',
        message: 'Confirm the current route effect.',
        details: { currentEffect: effect },
      }),
    } as Response);
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Confirm link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm the current time route');

    // Changing the draft invalidates the displayed facts; the alert clears
    // without any retry.
    await user.click(screen.getByRole('button', { name: 'Blocks' }));
    await waitFor(() =>
      expect(screen.queryByText('Confirm the current time route')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Confirm link' })).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ relationId: 'relation-1', type: 'blocks' }),
    } as Response);
    await user.click(screen.getByRole('button', { name: 'Confirm link' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/epics/${source.id}/relations/${target.id}`,
        expect.objectContaining({
          method: 'PUT',
          // No confirmation rides along after the intent reset.
          body: JSON.stringify({ type: 'blocks' }),
        }),
      ),
    );
  });

  it('cancels without writing and passes accessibility checks', async () => {
    const user = userEvent.setup();
    const { baseElement, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
