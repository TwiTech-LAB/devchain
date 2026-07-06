import { renderHook, act } from '@testing-library/react';
import { getErrorMessage, useToastHelpers } from './toast-helpers';

const mockToast = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe('toast-helpers', () => {
  describe('getErrorMessage', () => {
    it('returns the message of an Error instance', () => {
      expect(getErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
    });

    it('returns the fallback for a non-Error thrown value', () => {
      expect(getErrorMessage('a string', 'fallback')).toBe('fallback');
      expect(getErrorMessage(42, 'fallback')).toBe('fallback');
      expect(getErrorMessage(null, 'fallback')).toBe('fallback');
      expect(getErrorMessage(undefined, 'fallback')).toBe('fallback');
    });

    it('returns the fallback for a plain object that is not an Error instance', () => {
      // Duck-typed objects with a `message` field must NOT be treated as Errors:
      // the instanceof guard is the whole point.
      expect(getErrorMessage({ message: 'sneaky' }, 'fallback')).toBe('fallback');
      expect(getErrorMessage({}, 'fallback')).toBe('fallback');
    });

    it('uses an empty Error message verbatim rather than the fallback', () => {
      // An Error with an empty message is still an Error — preserve exact
      // behavior of the original ternary (Error branch wins).
      expect(getErrorMessage(new Error(''), 'fallback')).toBe('');
    });
  });

  describe('useToastHelpers', () => {
    beforeEach(() => {
      mockToast.mockClear();
    });

    it('exposes the raw toast primitive from useToast', () => {
      const { result } = renderHook(() => useToastHelpers());
      expect(result.current.toast).toBe(mockToast);
    });

    it('showSuccess fires a toast with title and description and no variant', () => {
      const { result } = renderHook(() => useToastHelpers());
      act(() => {
        result.current.showSuccess({ title: 'Saved', description: 'Changes applied.' });
      });
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Saved',
        description: 'Changes applied.',
      });
    });

    it('showError fires a destructive toast with title and description', () => {
      const { result } = renderHook(() => useToastHelpers());
      act(() => {
        result.current.showError({ title: 'Error', description: 'Something broke.' });
      });
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Something broke.',
        variant: 'destructive',
      });
    });

    it('composes with getErrorMessage to mirror the dominant ternary pattern', () => {
      const { result } = renderHook(() => useToastHelpers());
      act(() => {
        result.current.showError({
          title: 'Failed to create provider',
          description: getErrorMessage(new Error('network'), 'Failed to create provider'),
        });
      });
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Failed to create provider',
        description: 'network',
        variant: 'destructive',
      });
    });

    it('keeps showSuccess/showError referentially stable across renders', () => {
      const { result, rerender } = renderHook(() => useToastHelpers());
      const firstSuccess = result.current.showSuccess;
      const firstError = result.current.showError;
      rerender();
      expect(result.current.showSuccess).toBe(firstSuccess);
      expect(result.current.showError).toBe(firstError);
    });
  });
});
