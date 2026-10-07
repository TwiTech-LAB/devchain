import { renderHook, act } from '@testing-library/react';
import { getErrorMessage, useToastHelpers } from './toast-helpers';

const mockToast = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe('toast-helpers', () => {
  describe('getErrorMessage', () => {
    it.each([
      {
        label: 'returns the message of an Error instance',
        message: 'boom',
        expectedMessage: 'boom',
      },
      {
        label: 'uses an empty Error message verbatim rather than the fallback',
        message: '',
        expectedMessage: '',
      },
    ] as const)('$label', ({ message, expectedMessage }) => {
      expect(getErrorMessage(new Error(message), 'fallback')).toBe(expectedMessage);
    });

    it.each([
      { label: 'primitive non-Errors', values: ['a string', 42, null, undefined] },
      { label: 'duck-typed objects', values: [{ message: 'sneaky' }, {}] },
    ] as const)('uses fallback for $label', ({ values }) => {
      for (const value of values) expect(getErrorMessage(value, 'fallback')).toBe('fallback');
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
