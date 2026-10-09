import { act, renderHook } from '@testing-library/react';
import { useRuntime, type RuntimeContextValue } from './useRuntime';
import { useDismissibleNotice } from './useDismissibleNotice';

jest.mock('./useRuntime', () => ({ useRuntime: jest.fn() }));
const runtimeMock = jest.mocked(useRuntime);
let noticeId: string;
let sequence = 0;
const runtime: RuntimeContextValue = {
  runtimeInfo: { bootId: 'boot-1', version: '1' },
  runtimeLoading: false,
  runtimeError: false,
  cloudUiEnabled: false,
};

// renderHook is the cheapest layer that exercises runtime gating and browser storage together.
describe('useDismissibleNotice', () => {
  beforeEach(() => {
    noticeId = `test-${++sequence}`;
    localStorage.clear();
    runtimeMock.mockReturnValue(runtime);
  });
  afterEach(() => jest.restoreAllMocks());

  function renderNotice(itemKeys = ['a']) {
    return renderHook((props) => useDismissibleNotice(props), {
      initialProps: { noticeId, itemKeys },
    });
  }

  it('shows for unacknowledged keys and hides when no items remain', () => {
    const { result, rerender } = renderNotice([]);
    expect(result.current.visible).toBe(false);
    rerender({ noticeId, itemKeys: ['a'] });
    expect(result.current.visible).toBe(true);
    rerender({ noticeId, itemKeys: [] });
    expect(result.current.visible).toBe(false);
  });

  it('replaces acknowledged keys and shows again for a new key', () => {
    const { result, rerender } = renderNotice();
    act(() => result.current.dismissUntilNewItems());
    expect(result.current.visible).toBe(false);
    rerender({ noticeId, itemKeys: ['a', 'b'] });
    expect(result.current.visible).toBe(true);
    rerender({ noticeId, itemKeys: ['b'] });
    act(() => result.current.dismissUntilNewItems());
    expect(result.current.visible).toBe(false);
    expect(JSON.parse(localStorage.getItem(`devchain.notice.${noticeId}`)!)).toEqual({
      acknowledgedKeys: ['b'],
    });
    rerender({ noticeId, itemKeys: ['a'] });
    expect(result.current.visible).toBe(true);
  });

  it('keeps a close across remounts for the same boot only', () => {
    const first = renderNotice();
    act(() => first.result.current.closeUntilRestart());
    expect(first.result.current.visible).toBe(false);
    expect(JSON.parse(localStorage.getItem(`devchain.notice.${noticeId}`)!)).toEqual({
      closedBootId: 'boot-1',
    });
    first.unmount();
    const next = renderNotice();
    expect(next.result.current.visible).toBe(false);
    runtimeMock.mockReturnValue({ ...runtime, runtimeInfo: { bootId: 'boot-2', version: '1' } });
    next.rerender({ noticeId, itemKeys: ['a'] });
    expect(next.result.current.visible).toBe(true);
  });

  it('does not flash a closed notice while runtime loads', () => {
    localStorage.setItem(`devchain.notice.${noticeId}`, JSON.stringify({ closedBootId: 'boot-1' }));
    runtimeMock.mockReturnValue({ ...runtime, runtimeInfo: undefined, runtimeLoading: true });
    const { result, rerender } = renderNotice();
    expect(result.current.visible).toBe(false);
    runtimeMock.mockReturnValue(runtime);
    rerender({ noticeId, itemKeys: ['a'] });
    expect(result.current.visible).toBe(false);
  });

  it('ignores a closed boot on runtime failure and keeps an unknown-boot close for this page', () => {
    localStorage.setItem(`devchain.notice.${noticeId}`, JSON.stringify({ closedBootId: 'boot-1' }));
    runtimeMock.mockReturnValue({ ...runtime, runtimeError: true });
    const first = renderNotice();
    expect(first.result.current.visible).toBe(true);
    act(() => first.result.current.closeUntilRestart());
    expect(first.result.current.visible).toBe(false);
    first.unmount();
    runtimeMock.mockReturnValue(runtime);
    expect(renderNotice().result.current.visible).toBe(false);
  });

  it.each(['getItem', 'setItem'] as const)(
    'preserves in-memory dismissal when %s throws',
    (method) => {
      jest.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('unavailable');
      });
      const first = renderNotice();
      act(() => first.result.current.dismissUntilNewItems());
      expect(first.result.current.visible).toBe(false);
      first.unmount();
      const next = renderNotice();
      expect(next.result.current.visible).toBe(false);
      next.rerender({ noticeId, itemKeys: ['b'] });
      expect(next.result.current.visible).toBe(true);
      act(() => next.result.current.closeUntilRestart());
      expect(next.result.current.visible).toBe(false);
    },
  );

  it.each([
    ['{"closedBootId":42,"acknowledgedKeys":["a",3]}', true],
    ['{"closedBootId":42,"acknowledgedKeys":["a"]}', false],
    ['{"closedBootId":"boot-1","acknowledgedKeys":false}', false],
    ['null', true],
    ['bad json', true],
  ])('validates stored fields independently: %s', (stored, visible) => {
    localStorage.setItem(`devchain.notice.${noticeId}`, stored);
    expect(renderNotice().result.current.visible).toBe(visible);
  });

  it('isolates choices by notice id when the caller changes notices', () => {
    const { result, rerender } = renderNotice();
    act(() => result.current.dismissUntilNewItems());
    rerender({ noticeId: `${noticeId}-other`, itemKeys: ['a'] });
    expect(result.current.visible).toBe(true);
    rerender({ noticeId, itemKeys: ['a'] });
    expect(result.current.visible).toBe(false);
  });
});
