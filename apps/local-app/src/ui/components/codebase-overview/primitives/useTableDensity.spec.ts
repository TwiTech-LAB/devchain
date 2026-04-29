import { renderHook, act } from '@testing-library/react';
import { useTableDensity } from './useTableDensity';

describe('useTableDensity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to comfortable when nothing is stored', () => {
    const { result } = renderHook(() => useTableDensity());
    expect(result.current.density).toBe('comfortable');
  });

  it('reads stored value from localStorage on mount', () => {
    localStorage.setItem('overview.tableDensity', 'compact');
    const { result } = renderHook(() => useTableDensity());
    expect(result.current.density).toBe('compact');
  });

  it('updates density state when setDensity is called', () => {
    const { result } = renderHook(() => useTableDensity());
    act(() => {
      result.current.setDensity('compact');
    });
    expect(result.current.density).toBe('compact');
  });

  it('persists new value to localStorage', () => {
    const { result } = renderHook(() => useTableDensity());
    act(() => {
      result.current.setDensity('compact');
    });
    expect(localStorage.getItem('overview.tableDensity')).toBe('compact');
  });

  it('ignores unknown stored values and defaults to comfortable', () => {
    localStorage.setItem('overview.tableDensity', 'ultra-wide');
    const { result } = renderHook(() => useTableDensity());
    expect(result.current.density).toBe('comfortable');
  });
});
