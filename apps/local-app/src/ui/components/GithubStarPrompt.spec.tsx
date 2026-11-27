import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastHost } from '@/ui/components/shared/ToastHost';
import { toast, useToast } from '@/ui/hooks/use-toast';
import { isHomeAlwaysRoute } from '@/ui/lib/api-transport';
import type { WsEnvelope } from '@/ui/lib/socket';
import { GithubStarPrompt } from './GithubStarPrompt';

const mockHomeHandlers = new Map<string, Set<(arg?: unknown) => void>>();

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn((backend: string) => {
    if (backend !== 'home') throw new Error(`unexpected socket ${backend}`);
    return {
      on: (event: string, handler: (arg?: unknown) => void) => {
        if (!mockHomeHandlers.has(event)) mockHomeHandlers.set(event, new Set());
        mockHomeHandlers.get(event)!.add(handler);
      },
      off: (event: string, handler: (arg?: unknown) => void) => {
        mockHomeHandlers.get(event)?.delete(handler);
      },
    };
  }),
  releaseAppSocket: jest.fn(),
}));

const URL = 'https://github.com/TwiTech-LAB/devchain';
const MESSAGE =
  'DevChain is open source. If it helped today, a GitHub star helps other developers find it.';

type Pending = { id: string; reason: 'launches'; mode: 'gh' | 'web'; url: string } | null;

let pending: Pending;
let actionResponse: (body: { promptId: string; action: string }) => unknown;
let fetchMock: jest.Mock;

function pendingPrompt(mode: 'gh' | 'web', id = 'p1'): Pending {
  return { id, reason: 'launches', mode, url: URL };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function actionCalls() {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === '/api/github-star/action')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

function stateCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === '/api/github-star').length;
}

function emitHome(event: string, arg?: unknown) {
  act(() => {
    for (const handler of mockHomeHandlers.get(event) ?? []) handler(arg);
  });
}

function renderPrompt(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <ToastHost>
        <GithubStarPrompt />
      </ToastHost>
    </QueryClientProvider>,
  );
}

const STATE_URL = '/api/github-star';
const ACTION_URL = '/api/github-star/action';
let held: Map<string, Array<Promise<unknown>>>;

/** The next request to `url` waits until the returned function gives its response body. */
function holdNext(url: string): (body: unknown) => Promise<void> {
  let release!: (body: unknown) => void;
  const body = new Promise<unknown>((resolve) => (release = resolve));
  held.set(url, [...(held.get(url) ?? []), body]);
  return async (value) => {
    await act(async () => {
      release(value);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
}

beforeEach(() => {
  mockHomeHandlers.clear();
  held = new Map();
  pending = pendingPrompt('gh');
  actionResponse = () => ({ pending: null });
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const heldBody = held.get(url)?.shift();
    if (heldBody) return jsonResponse(await heldBody);
    if (url === STATE_URL) return jsonResponse({ pending });
    if (url === ACTION_URL) {
      return jsonResponse(actionResponse(JSON.parse(init!.body as string)));
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

// The toast store is module state; close what a test left open so the next test starts clean.
afterEach(() => {
  const { result, unmount } = renderHook(() => useToast());
  act(() => result.current.dismiss());
  unmount();
});

it('shows the pending prompt after load and keeps it while other toasts come and go', async () => {
  renderPrompt();
  const card = await screen.findByRole('status', { name: 'Star DevChain on GitHub' });
  expect(card).toHaveTextContent(MESSAGE);
  expect(card).toHaveAttribute('aria-live', 'polite');

  act(() => {
    toast({ title: 'one' });
    toast({ title: 'two' });
    toast({ title: 'three' });
  });
  fireEvent.click(await screen.findByText('three'));

  expect(screen.getByRole('status', { name: 'Star DevChain on GitHub' })).toBeInTheDocument();
  expect(actionCalls()).toEqual([]);
});

it('renders nothing when no prompt is pending', async () => {
  pending = null;
  renderPrompt();
  await waitFor(() => expect(stateCalls()).toBe(1));
  expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
});

it.each([
  ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
  ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
])('%s sends later once and hides the card', async (_label, close) => {
  renderPrompt();
  await screen.findByText(MESSAGE);

  close();
  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  await waitFor(() => expect(actionCalls()).toEqual([{ promptId: 'p1', action: 'later' }]));
});

it.each([
  ['Later', 'later'],
  ["Don't ask again", 'never'],
])('%s sends %s with the prompt id', async (label, action) => {
  renderPrompt();
  fireEvent.click(await screen.findByRole('button', { name: label }));
  expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  await waitFor(() => expect(actionCalls()).toEqual([{ promptId: 'p1', action }]));
});

it('gh mode: a successful star closes the card and thanks the user', async () => {
  renderPrompt();
  const star = await screen.findByRole('button', { name: 'Star on GitHub' });
  const respond = holdNext(ACTION_URL);

  fireEvent.click(star);
  fireEvent.click(star);
  expect(star).toHaveAttribute('aria-busy', 'true');
  expect(star).toBeDisabled();
  await respond({ pending: null, result: 'starred' });

  expect(await screen.findByText('Thanks for the star!')).toBeInTheDocument();
  expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  expect(actionCalls()).toEqual([{ promptId: 'p1', action: 'star' }]);
});

it('gh mode: a failed star keeps the card open with the repo link', async () => {
  actionResponse = () => ({ pending: pendingPrompt('web'), result: 'fallback', url: URL });
  renderPrompt();

  fireEvent.click(await screen.findByRole('button', { name: 'Star on GitHub' }));

  const link = await screen.findByRole('link', { name: 'Star on GitHub' });
  expect(link).toHaveAttribute('href', URL);
  expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  expect(screen.queryByText('Thanks for the star!')).not.toBeInTheDocument();
});

it.each([
  ['a primary click', (link: HTMLElement) => fireEvent.click(link)],
  [
    'a middle click',
    (link: HTMLElement) =>
      fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })),
  ],
])('web mode: Star is a real new-tab link that records opened on %s', async (_label, open) => {
  pending = pendingPrompt('web');
  const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  renderPrompt();

  const link = await screen.findByRole('link', { name: 'Star on GitHub' });
  expect(link).toHaveAttribute('href', URL);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  open(link);

  expect(openSpy).not.toHaveBeenCalled();
  expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  await waitFor(() => expect(actionCalls()).toEqual([{ promptId: 'p1', action: 'opened' }]));
  openSpy.mockRestore();
});

it('reloads on github_star_changed and on home reconnect, closing when nothing is pending', async () => {
  renderPrompt();
  await screen.findByText(MESSAGE);
  expect(stateCalls()).toBe(1);

  pending = null;
  emitHome('message', { topic: 'system', type: 'github_star_changed', payload: {} } as WsEnvelope);
  await waitFor(() => expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument());
  expect(stateCalls()).toBe(2);

  pending = pendingPrompt('gh', 'p2');
  emitHome('connect');
  expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
  expect(stateCalls()).toBe(3);
});

it('routes both endpoints to the home backend', () => {
  expect(isHomeAlwaysRoute('/api/github-star', 'GET')).toBe(true);
  expect(isHomeAlwaysRoute('/api/github-star/action', 'POST')).toBe(true);
});

describe('request ordering', () => {
  it('reads home again on every mount, even with the same QueryClient', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderPrompt(client);
    await screen.findByText(MESSAGE);
    first.unmount();

    pending = null;
    renderPrompt(client);
    await waitFor(() => expect(stateCalls()).toBe(2));
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  });

  it('a realtime event during the initial GET reads again, and the older answer loses', async () => {
    const respondInitial = holdNext(STATE_URL);
    renderPrompt();
    await waitFor(() => expect(stateCalls()).toBe(1));

    pending = null;
    emitHome('message', {
      topic: 'system',
      type: 'github_star_changed',
      payload: {},
    } as WsEnvelope);
    await waitFor(() => expect(stateCalls()).toBe(2));

    await respondInitial({ pending: pendingPrompt('gh') });
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  });

  it.each([
    [
      'fallback',
      { pending: pendingPrompt('web'), result: 'fallback', url: URL },
      () => expect(screen.getByRole('link', { name: 'Star on GitHub' })).toBeInTheDocument(),
    ],
    [
      'starred',
      { pending: null, result: 'starred' },
      () => expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument(),
    ],
  ])(
    'a GET started before a %s star answer cannot overwrite it',
    async (_label, starAnswer, expectView) => {
      renderPrompt();
      const star = await screen.findByRole('button', { name: 'Star on GitHub' });

      const respondStale = holdNext(STATE_URL);
      emitHome('connect');
      const respondStar = holdNext(ACTION_URL);
      fireEvent.click(star);

      await respondStar(starAnswer);
      expectView();
      await respondStale({ pending: pendingPrompt('gh') });
      expectView();
      expect(screen.queryByRole('button', { name: 'Star on GitHub' })).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      'starred',
      { pending: null, result: 'starred' },
      () => expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument(),
    ],
    [
      'fallback',
      { pending: pendingPrompt('web'), result: 'fallback', url: URL },
      () => {
        expect(screen.getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', URL);
        expect(screen.queryByRole('button', { name: 'Star on GitHub' })).not.toBeInTheDocument();
      },
    ],
  ])(
    'a %s answer settles the card over GETs that saw the same gh prompt before the star committed',
    async (_label, starAnswer, expectSettled) => {
      renderPrompt();
      const star = await screen.findByRole('button', { name: 'Star on GitHub' });

      const respondStar = holdNext(ACTION_URL);
      fireEvent.click(star);
      // Two reconnect GETs while gh runs; both read the pre-star state.
      const respondLateGet = holdNext(STATE_URL);
      emitHome('connect');
      emitHome('connect');
      await waitFor(() => expect(stateCalls()).toBe(3));
      expect(screen.getByRole('button', { name: 'Star on GitHub' })).toHaveAttribute(
        'aria-busy',
        'true',
      );

      await respondStar(starAnswer);
      expectSettled();
      await respondLateGet({ pending: pendingPrompt('gh') });
      expectSettled();
    },
  );

  it('a GET sent during the star that answers after it cannot bring back the gh prompt', async () => {
    renderPrompt();
    const star = await screen.findByRole('button', { name: 'Star on GitHub' });

    const respondStar = holdNext(ACTION_URL);
    fireEvent.click(star);
    const respondGet = holdNext(STATE_URL);
    emitHome('connect');
    await waitFor(() => expect(stateCalls()).toBe(2));

    await respondStar({ pending: null, result: 'starred' });
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
    await respondGet({ pending: pendingPrompt('gh') });
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  });

  it.each(['before', 'after'])(
    'a starred answer wins over a web view of the same prompt that answers %s it',
    async (order) => {
      renderPrompt();
      const star = await screen.findByRole('button', { name: 'Star on GitHub' });

      const respondStar = holdNext(ACTION_URL);
      fireEvent.click(star);
      // Another tab's star failed first, so the server now shows this prompt in web mode.
      const respondGet = holdNext(STATE_URL);
      emitHome('message', {
        topic: 'system',
        type: 'github_star_changed',
        payload: {},
      } as WsEnvelope);
      await waitFor(() => expect(stateCalls()).toBe(2));

      if (order === 'before') {
        await respondGet({ pending: pendingPrompt('web') });
        expect(screen.getByRole('link', { name: 'Star on GitHub' })).toBeInTheDocument();
        await respondStar({ pending: null, result: 'starred' });
      } else {
        await respondStar({ pending: null, result: 'starred' });
        await respondGet({ pending: pendingPrompt('web') });
      }

      expect(screen.getByText('Thanks for the star!')).toBeInTheDocument();
      expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Star on GitHub' })).not.toBeInTheDocument();
    },
  );

  it('a star answer cannot overwrite a GET that started after it was sent', async () => {
    renderPrompt();
    const star = await screen.findByRole('button', { name: 'Star on GitHub' });

    const respondStar = holdNext(ACTION_URL);
    fireEvent.click(star);
    pending = null;
    emitHome('message', {
      topic: 'system',
      type: 'github_star_changed',
      payload: {},
    } as WsEnvelope);
    await waitFor(() => expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument());

    await respondStar({ pending: pendingPrompt('web'), result: 'fallback', url: URL });
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  });

  it.each([
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('%s during a delayed star sends later once and stays closed', async (_label, close) => {
    renderPrompt();
    const star = await screen.findByRole('button', { name: 'Star on GitHub' });
    const respondStar = holdNext(ACTION_URL);
    fireEvent.click(star);
    expect(star).toHaveAttribute('aria-busy', 'true');

    close();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(actionCalls()).toEqual([
        { promptId: 'p1', action: 'star' },
        { promptId: 'p1', action: 'later' },
      ]),
    );

    await respondStar({ pending: pendingPrompt('web'), result: 'fallback', url: URL });
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  });
});
