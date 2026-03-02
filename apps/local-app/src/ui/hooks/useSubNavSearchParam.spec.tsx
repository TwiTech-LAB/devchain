import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useSubNavSearchParam } from './useSubNavSearchParam';

const KEYS = ['alpha', 'beta', 'gamma'] as const;
type Key = (typeof KEYS)[number];

function wrapper(initialEntries: string[]) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('useSubNavSearchParam', () => {
  it('returns defaultKey when param is absent', () => {
    const { result } = renderHook(() => useSubNavSearchParam<Key>([...KEYS], 'alpha', 'tab'), {
      wrapper: wrapper(['/page']),
    });
    expect(result.current[0]).toBe('alpha');
  });

  it('returns the param value when valid', () => {
    const { result } = renderHook(() => useSubNavSearchParam<Key>([...KEYS], 'alpha', 'tab'), {
      wrapper: wrapper(['/page?tab=beta']),
    });
    expect(result.current[0]).toBe('beta');
  });

  it('falls back to defaultKey for invalid param value', () => {
    const { result } = renderHook(() => useSubNavSearchParam<Key>([...KEYS], 'alpha', 'tab'), {
      wrapper: wrapper(['/page?tab=bogus']),
    });
    expect(result.current[0]).toBe('alpha');
  });

  it('updates URL when setActiveKey is called', () => {
    const { result } = renderHook(() => useSubNavSearchParam<Key>([...KEYS], 'alpha', 'tab'), {
      wrapper: wrapper(['/page?tab=alpha']),
    });

    act(() => {
      result.current[1]('gamma');
    });

    expect(result.current[0]).toBe('gamma');
  });
});
