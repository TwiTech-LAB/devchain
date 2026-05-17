import { renderHook } from '@testing-library/react';
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
    setDocumentActivityState('visible', true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not report activity merely from having a selected project', () => {
    renderHook(() => useProjectActivityReporter('project-1'));

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
