import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ExternalTaskComment } from '@/modules/external-integrations/models/external-provider.models';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExternalTaskCommentsPanel } from './ExternalTaskCommentsPanel';

type Controller = React.ComponentProps<typeof ExternalTaskCommentsPanel>['controller'];

function comment(overrides: Partial<ExternalTaskComment> = {}): ExternalTaskComment {
  return {
    remoteId: 'comment-1',
    author: { remoteId: '183', displayName: 'John Doe' },
    body: 'Plain text body',
    bodyTruncated: false,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: null,
    ...overrides,
  };
}

function controllerValue(overrides: Record<string, unknown> = {}): Controller {
  return {
    detail: { data: undefined, isLoading: false, isError: false, error: null },
    comments: {
      data: { pages: [], pageParams: [null] },
      isLoading: false,
      isError: false,
      error: null,
      isSuccess: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      isRefetching: false,
      refetch: jest.fn(),
    },
    chronologicalComments: [],
    loadEarlier: jest.fn(async () => undefined),
    commentText: '',
    setCommentText: jest.fn(),
    commentsMessage: null,
    mutation: {
      mutate: jest.fn(),
      reset: jest.fn(),
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
      data: undefined,
    },
    ...overrides,
  } as Controller;
}

function renderPanel(
  controller: Controller,
  {
    provider = 'jira',
    canComment = true,
    richEditEnabled = false,
    ownedDeleteEnabled = false,
  }: {
    provider?: 'jira' | 'clickup';
    canComment?: boolean;
    richEditEnabled?: boolean;
    ownedDeleteEnabled?: boolean;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ExternalTaskCommentsPanel
        provider={provider}
        taskId="ENG-1"
        controller={controller}
        canComment={canComment}
        richEditEnabled={richEditEnabled}
        ownedDeleteEnabled={ownedDeleteEnabled}
      />
    </QueryClientProvider>,
  );
}

function historyRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Comments history' });
}

describe('ExternalTaskCommentsPanel', () => {
  it('renders unique comments chronologically with initials, locale dates, and plain text', async () => {
    const newest = comment({ remoteId: 'c2', body: 'Newest <script>alert(1)</script>' });
    const oldest = comment({
      remoteId: 'c1',
      author: { remoteId: '9', displayName: 'Ada Lovelace' },
      body: 'Oldest',
      createdAt: '2026-08-19T10:00:00.000Z',
    });
    const { baseElement } = renderPanel(
      controllerValue({ chronologicalComments: [oldest, newest] }),
    );

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Oldest');
    expect(items[1]).toHaveTextContent(/Newest/);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByText('JD')).toBeInTheDocument();
    expect(
      screen.getByText(new Date('2026-08-19T10:00:00.000Z').toLocaleString()),
    ).toBeInTheDocument();
    // Vendor markup renders as literal text, never as elements.
    expect(screen.getByText(/alert\(1\)/)).toBeInTheDocument();
    expect(baseElement.querySelector('script')).toBeNull();
    expect(baseElement.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument();
    await expect(axe(baseElement)).resolves.toHaveNoViolations();
  });

  it('uses a native overflow container and positions the view at the newest comment on load', async () => {
    const loading = controllerValue({
      comments: {
        data: undefined,
        isLoading: true,
        isError: false,
        error: null,
        isSuccess: false,
        hasNextPage: false,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
      },
    });
    const view = renderPanel(loading);

    const region = historyRegion();
    expect(region.className).toContain('overflow-y-auto');
    expect(region.className).toContain('overscroll-contain');

    const writes: number[] = [];
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 480 });
    Object.defineProperty(region, 'scrollTop', {
      configurable: true,
      get: () => writes[writes.length - 1] ?? 0,
      set: (value: number) => writes.push(value),
    });

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ExternalTaskCommentsPanel
          provider="jira"
          taskId="ENG-1"
          controller={controllerValue({ chronologicalComments: [comment()] })}
          canComment
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(writes).toEqual([480]));

    // A created comment follows the newest position again.
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ExternalTaskCommentsPanel
          provider="jira"
          taskId="ENG-1"
          controller={controllerValue({
            chronologicalComments: [comment()],
            mutation: {
              mutate: jest.fn(),
              reset: jest.fn(),
              isPending: false,
              isError: false,
              error: null,
              variables: undefined,
              data: { remoteTaskId: 'ENG-1', action: 'add_comment', succeeded: true, refresh: [] },
            },
          })}
          canComment
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(writes).toEqual([480, 480]));
  });

  it('preserves the reading anchor when older comments load above', async () => {
    const heights = [500];
    const controller = controllerValue({
      comments: {
        data: { pages: [], pageParams: [null] },
        isLoading: false,
        isError: false,
        error: null,
        isSuccess: true,
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
      },
      chronologicalComments: [comment()],
      loadEarlier: jest.fn(async () => {
        heights.push(800);
      }),
    });
    renderPanel(controller);

    const region = historyRegion();
    const writes: number[] = [];
    Object.defineProperty(region, 'scrollHeight', {
      configurable: true,
      get: () => heights[heights.length - 1]!,
    });
    Object.defineProperty(region, 'scrollTop', {
      configurable: true,
      get: () => writes[writes.length - 1] ?? 120,
      set: (value: number) => writes.push(value),
    });

    await userEvent.click(screen.getByRole('button', { name: /load earlier comments/i }));

    // 500px content at 120px scroll; grown to 800px keeps the anchor at 420px.
    await waitFor(() => expect(writes).toEqual([420]));
    expect(controller.loadEarlier).toHaveBeenCalledTimes(1);
  });

  it('keeps the composer available on initial comment failure and retries the initial query', async () => {
    const user = userEvent.setup();
    const controller = controllerValue({
      comments: {
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error('Comments could not be loaded.'),
        isSuccess: false,
        hasNextPage: false,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        isRefetching: false,
        refetch: jest.fn(),
      },
    });
    renderPanel(controller);

    expect(screen.getByRole('alert')).toHaveTextContent('Comments unavailable');
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(controller.comments.refetch).toHaveBeenCalledTimes(1);
  });

  it('preserves loaded comments on a later-page failure with exactly one alert and Retry', async () => {
    const user = userEvent.setup();
    const controller = controllerValue({
      comments: {
        data: { pages: [{ comments: [comment()], nextCursor: '10' }], pageParams: [null] },
        isLoading: false,
        isError: true,
        error: new Error('Earlier comments could not be loaded.'),
        isSuccess: false,
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: true,
        isRefetching: false,
        refetch: jest.fn(),
      },
      chronologicalComments: [comment()],
    });
    renderPanel(controller);

    expect(screen.getByText('Plain text body')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Earlier comments unavailable');
    expect(screen.queryByText(/Comments unavailable/)).not.toBeInTheDocument();
    expect(controller.comments.refetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(controller.loadEarlier).toHaveBeenCalledTimes(1);
    expect(controller.comments.refetch).not.toHaveBeenCalled();
  });

  it('shows empty history guidance', () => {
    renderPanel(controllerValue());
    expect(screen.getByText('No comments yet.')).toBeInTheDocument();
  });

  it('marks empty attachment-only bodies as muted, non-copyable metadata', () => {
    renderPanel(
      controllerValue({
        chronologicalComments: [comment({ body: '', bodyTruncated: false })],
      }),
    );

    const metadata = screen.getByText('No text content');
    expect(metadata.className).toContain('select-none');
    expect(metadata.className).toContain('text-muted-foreground');
    expect(screen.queryByText('Plain text body')).not.toBeInTheDocument();
  });

  it('explains truncated bodies', () => {
    renderPanel(
      controllerValue({
        chronologicalComments: [comment({ body: 'x'.repeat(8_000), bodyTruncated: true })],
      }),
    );

    expect(
      screen.getByText('Comment was shortened. Open the source task to read the rest.'),
    ).toBeInTheDocument();
  });

  it('derives avatar initials from the display name only', () => {
    renderPanel(
      controllerValue({
        chronologicalComments: [
          comment({ remoteId: 'c1', author: { remoteId: '9', displayName: 'grace' } }),
          comment({ remoteId: 'c2', author: { remoteId: null, displayName: 'Unknown user' } }),
        ],
      }),
    );

    expect(screen.getByText('G')).toBeInTheDocument();
    expect(screen.getByText('UU')).toBeInTheDocument();
  });

  it('clears nothing on failed creation and submits trimmed text with notify preference', async () => {
    const user = userEvent.setup();
    const controller = controllerValue({ commentText: '  Typed draft  ' });
    const view = renderPanel(controller, { provider: 'clickup' });

    expect(screen.getByLabelText('Notify everyone')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add comment' }));

    expect(controller.mutation.mutate).toHaveBeenCalledWith(
      { action: 'add_comment', input: { text: 'Typed draft', notifyAll: false } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    // The panel never clears the draft itself; the controller owns clearing.
    expect(controller.setCommentText).not.toHaveBeenCalledWith('');

    view.unmount();
    const failed = controllerValue({
      commentText: 'Typed draft',
      mutation: {
        mutate: jest.fn(),
        reset: jest.fn(),
        isPending: false,
        isError: true,
        error: new Error('Provider rejected the comment.'),
        variables: { action: 'add_comment', input: { text: 'Typed draft', notifyAll: false } },
        data: undefined,
      },
    });
    renderPanel(failed);
    expect(screen.getByRole('alert')).toHaveTextContent('Comment could not be added');
    expect((screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement).value).toBe(
      'Typed draft',
    );
  });

  it('hides Notify everyone for Jira and shows it only for ClickUp', () => {
    const { unmount } = renderPanel(controllerValue());
    expect(screen.queryByLabelText('Notify everyone')).not.toBeInTheDocument();
    unmount();

    renderPanel(controllerValue(), { provider: 'clickup' });
    expect(screen.getByLabelText('Notify everyone')).toBeInTheDocument();
  });

  it('announces loading, chase progress, and success through live regions', () => {
    renderPanel(
      controllerValue({
        commentsMessage: 'Comments changed while loading. Continue to load earlier.',
        comments: {
          data: undefined,
          isLoading: true,
          isError: false,
          error: null,
          isSuccess: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
        },
        mutation: {
          mutate: jest.fn(),
          reset: jest.fn(),
          isPending: false,
          isError: false,
          error: null,
          variables: undefined,
          data: { remoteTaskId: 'ENG-1', action: 'add_comment', succeeded: true, refresh: [] },
        },
      }),
    );

    expect(screen.getAllByRole('status').map((node) => node.textContent?.trim())).toEqual(
      expect.arrayContaining([
        'Comments changed while loading. Continue to load earlier.',
        'Loading comments',
        'Comment added.',
      ]),
    );
  });

  it('disables the composer while a creation is pending and when unsupported', () => {
    const { unmount } = renderPanel(
      controllerValue({
        commentText: 'Draft',
        mutation: {
          mutate: jest.fn(),
          reset: jest.fn(),
          isPending: true,
          isError: false,
          error: null,
          variables: undefined,
          data: undefined,
        },
      }),
    );
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    unmount();

    renderPanel(controllerValue(), { canComment: false });
    expect(screen.getByText('Comments are unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
  });
});
