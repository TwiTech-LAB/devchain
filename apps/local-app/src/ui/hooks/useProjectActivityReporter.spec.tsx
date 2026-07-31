import { act, renderHook } from '@testing-library/react';
import {
  PROJECT_ACTIVITY_TOUCH_THROTTLE_MS,
  resetProjectActivityTouchThrottleForTests,
  touchProjectActivity,
  useProjectActivityReporter,
} from './useProjectActivityReporter';

// Layer: UI hook unit. This is the cheapest layer that proves browser visibility/focus gating and fetch behavior.

function setDocumentActivityState(
  visibilityState: DocumentVisibilityState,
  focused: boolean,
): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: visibilityState,
  });
  jest.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

function okResponse(): Response {
  return { ok: true } as Response;
}

describe('useProjectActivityReporter', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    resetProjectActivityTouchThrottleForTests();
    fetchMock = jest.fn().mockResolvedValue(okResponse()) as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock as unknown as typeof fetch;
    setDocumentActivityState('visible', true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not report activity merely from having a selected project', () => {
    const { result } = renderHook(() => useProjectActivityReporter('project-1'));

    expect(result.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers only capture-phase pointerdown and keydown listeners', () => {
    const addEventListenerSpy = jest.spyOn(document, 'addEventListener');
    const removeEventListenerSpy = jest.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useProjectActivityReporter('project-1'));

    expect(
      addEventListenerSpy.mock.calls.map(([eventName, _listener, options]) => [eventName, options]),
    ).toEqual([
      ['pointerdown', { capture: true }],
      ['keydown', { capture: true }],
    ]);

    unmount();

    expect(
      removeEventListenerSpy.mock.calls.map(([eventName, _listener, options]) => [
        eventName,
        options,
      ]),
    ).toEqual([
      ['pointerdown', { capture: true }],
      ['keydown', { capture: true }],
    ]);
  });

  it('reports visible focused pointer and keyboard input for the current project', () => {
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useProjectActivityReporter(projectId),
      { initialProps: { projectId: 'project-1' } },
    );

    act(() => {
      document.dispatchEvent(new Event('pointerdown'));
    });

    rerender({ projectId: 'project-2' });
    resetProjectActivityTouchThrottleForTests();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/cloud/activity/projects/project-1/touch',
      '/api/cloud/activity/projects/project-2/touch',
    ]);
  });

  it('does not report an unregistered passive event', () => {
    renderHook(() => useProjectActivityReporter('project-1'));

    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps document input gated by project selection and active document state', () => {
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string | undefined }) => useProjectActivityReporter(projectId),
      { initialProps: { projectId: undefined } },
    );

    act(() => {
      document.dispatchEvent(new Event('pointerdown'));
    });

    rerender({ projectId: 'project-1' });
    setDocumentActivityState('hidden', true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });

    setDocumentActivityState('visible', false);
    act(() => {
      document.dispatchEvent(new Event('pointerdown'));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('touches a known project when the document is visible and focused', async () => {
    const touched = await touchProjectActivity('project-1', {
      fetchImpl: fetchMock,
      now: () => 0,
    });

    expect(touched).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/cloud/activity/projects/project-1/touch', {
      method: 'POST',
    });
  });

  it('URL-encodes the project id in the touch path', async () => {
    const touched = await touchProjectActivity('project/alpha:1', {
      fetchImpl: fetchMock,
      now: () => 0,
    });

    expect(touched).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cloud/activity/projects/project%2Falpha%3A1/touch',
      { method: 'POST' },
    );
  });

  it('does not touch when project id is missing', async () => {
    const touched = await touchProjectActivity(undefined, {
      fetchImpl: fetchMock,
      now: () => 0,
    });

    expect(touched).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['hidden', false, 'hidden document'],
    ['visible', false, 'unfocused document'],
  ] as const)('does not touch for a %s/%s state (%s)', async (visibilityState, focused) => {
    setDocumentActivityState(visibilityState, focused);

    const touched = await touchProjectActivity('project-1', {
      fetchImpl: fetchMock,
      now: () => 0,
    });

    expect(touched).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throttles project touches for one minute per project', async () => {
    await touchProjectActivity('project-1', { fetchImpl: fetchMock, now: () => 0 });
    await touchProjectActivity('project-1', {
      fetchImpl: fetchMock,
      now: () => PROJECT_ACTIVITY_TOUCH_THROTTLE_MS - 1,
    });
    await touchProjectActivity('project-1', {
      fetchImpl: fetchMock,
      now: () => PROJECT_ACTIVITY_TOUCH_THROTTLE_MS + 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('swallows fetch errors', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const touched = await touchProjectActivity('project-1', {
      fetchImpl: fetchMock,
      now: () => 0,
    });

    expect(touched).toBe(false);
  });
});
