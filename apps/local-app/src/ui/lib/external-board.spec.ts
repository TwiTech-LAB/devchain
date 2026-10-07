import { boardReturnUrlFromState, hasInAppHistoryBack } from './external-board';

describe('boardReturnUrlFromState', () => {
  it('returns the validated native /board URL when state carries one', () => {
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board' })).toBe('/board');
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board?st=s1' })).toBe('/board?st=s1');
  });

  it('returns null for missing, non-object, non-string, and off-board values', () => {
    expect(boardReturnUrlFromState(undefined)).toBeNull();
    expect(boardReturnUrlFromState(null)).toBeNull();
    expect(boardReturnUrlFromState('/board')).toBeNull();
    expect(boardReturnUrlFromState({})).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: 7 })).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: '//host/board' })).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board#h' })).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board/sub' })).toBeNull();
  });
});

describe('hasInAppHistoryBack', () => {
  afterEach(() => window.history.replaceState(null, ''));

  it('returns true only for a positive integer history index', () => {
    window.history.replaceState({ idx: 1 }, '');
    expect(hasInAppHistoryBack()).toBe(true);
    window.history.replaceState({ idx: 4 }, '');
    expect(hasInAppHistoryBack()).toBe(true);
  });

  it('returns false for missing, null, zero, and malformed idx values', () => {
    window.history.replaceState(null, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: null }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({}, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: 0 }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: -2 }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: '2' }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: 1.5 }, '');
    expect(hasInAppHistoryBack()).toBe(false);
  });
});
